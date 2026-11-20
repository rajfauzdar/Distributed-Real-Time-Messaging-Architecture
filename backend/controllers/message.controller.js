import crypto from "crypto";
import mongoose from "mongoose";
import Message from "../models/message.model.js";
import User from "../models/user.model.js";
import ReadState from "../models/readState.model.js";
import { claimOnce, emitToUser } from "../socket/socket.js";
import { kafkaEnabled } from "../kafka/kafka.js";
import { KafkaUnavailableError, publishMessage } from "../kafka/producer.js";

// same (sender, clientId) always yields the same 12-byte ObjectId
const deterministicObjectId = (senderId, clientId) =>
	new mongoose.Types.ObjectId(crypto.createHash("sha256").update(`${senderId}:${clientId}`).digest().subarray(0, 12));

// Users are never deleted, so a positive lookup can be cached; avoids one DB read per message.
const knownUsers = new Map(); // id -> expiry timestamp
const userExists = async (id) => {
	const key = String(id);
	if ((knownUsers.get(key) ?? 0) > Date.now()) return true;
	if (!(await User.exists({ _id: id }))) return false;
	if (knownUsers.size > 10_000) knownUsers.clear();
	knownUsers.set(key, Date.now() + 5 * 60_000);
	return true;
};

const MAX_MESSAGE_LENGTH = 2000;
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;
const CLIENT_ID_REGEX = /^[\w-]{8,64}$/; // e.g. a UUID

export const sendMessage = async (req, res) => {
	try {
		const { message, clientId } = req.body;
		const { id: receiverId } = req.params;
		const senderId = req.user._id;

		if (clientId !== undefined && (typeof clientId !== "string" || !CLIENT_ID_REGEX.test(clientId))) {
			return res.status(400).json({ error: "Invalid clientId" });
		}

		if (!mongoose.isValidObjectId(receiverId)) {
			return res.status(400).json({ error: "Invalid user id" });
		}
		if (String(receiverId) === String(senderId)) {
			return res.status(400).json({ error: "You can't send a message to yourself" });
		}
		if (typeof message !== "string" || !message.trim()) {
			return res.status(400).json({ error: "Message can't be empty" });
		}
		if (message.length > MAX_MESSAGE_LENGTH) {
			return res.status(400).json({ error: `Message is too long (max ${MAX_MESSAGE_LENGTH} characters)` });
		}

		if (!(await userExists(receiverId))) {
			return res.status(404).json({ error: "User not found" });
		}

		let newMessage;
		let isDuplicate = false;

		if (kafkaEnabled()) {
			// ---- Kafka mode: Kafka is the durable buffer; a separate consumer writes to MongoDB ----
			const now = new Date();
			newMessage = {
				// deterministic _id: a retried send (same clientId) maps to the same document, so every
				// downstream step (consumer upsert, live delivery dedupe) is idempotent
				_id: clientId ? deterministicObjectId(senderId, clientId) : new mongoose.Types.ObjectId(),
				senderId,
				receiverId,
				message: message.trim(),
				...(clientId ? { clientId } : {}),
				createdAt: now,
				updatedAt: now,
			};
			await publishMessage(newMessage); // throws KafkaUnavailableError -> 503, the client's outbox retries
			isDuplicate = !(await claimOnce(`msg:${newMessage._id}`));
		} else {
			// ---- direct mode (no Kafka configured): write straight to MongoDB ----
			try {
				newMessage = await Message.create({ senderId, receiverId, message: message.trim(), clientId });
			} catch (error) {
				// same clientId sent before (client retry after a lost response): return the original, don't create/deliver again
				if (error.code === 11000 && clientId) {
					newMessage = await Message.findOne({ senderId, clientId });
					isDuplicate = true;
				} else {
					throw error;
				}
			}
		}

		// deliver to every open tab/device of the receiver, on whichever server instance they're connected to
		if (!isDuplicate) emitToUser(receiverId, "newMessage", newMessage);

		res.status(isDuplicate ? 200 : 201).json(newMessage);
	} catch (error) {
		if (error instanceof KafkaUnavailableError) {
			console.error("Kafka unavailable:", error.message);
			return res.status(503).json({ error: "Messaging is temporarily unavailable, please retry" });
		}
		console.log("Error in sendMessage controller: ", error.message);
		res.status(500).json({ error: "Internal server error" });
	}
};

export const getMessages = async (req, res) => {
	try {
		const { id: userToChatId } = req.params;
		const senderId = req.user._id;

		if (!mongoose.isValidObjectId(userToChatId)) {
			return res.status(400).json({ error: "Invalid user id" });
		}

		// Cursor pagination, newest first: ?limit=30 for the latest page, then
		// ?before=<createdAt of the oldest loaded>&beforeId=<its _id> for the page before it.
		// (createdAt, _id) is used - not createdAt alone - so messages sharing a millisecond are never skipped.
		const parsedLimit = Number.parseInt(req.query.limit, 10);
		const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? DEFAULT_PAGE_SIZE : parsedLimit, 1), MAX_PAGE_SIZE);

		const filter = {
			$or: [
				{ senderId, receiverId: userToChatId },
				{ senderId: userToChatId, receiverId: senderId },
			],
		};

		const { before, beforeId } = req.query;
		if (before !== undefined) {
			const beforeDate = new Date(before);
			if (typeof before !== "string" || Number.isNaN(beforeDate.getTime())) {
				return res.status(400).json({ error: "Invalid 'before' cursor" });
			}
			if (beforeId !== undefined && !mongoose.isValidObjectId(beforeId)) {
				return res.status(400).json({ error: "Invalid 'beforeId' cursor" });
			}
			const cursor = beforeId
				? { $or: [{ createdAt: { $lt: beforeDate } }, { createdAt: beforeDate, _id: { $lt: beforeId } }] }
				: { createdAt: { $lt: beforeDate } };
			filter.$and = [cursor];
		}

		const page = await Message.find(filter)
			.sort({ createdAt: -1, _id: -1 })
			.limit(limit + 1) // one extra row tells us whether an older page exists
			.lean();

		const hasMore = page.length > limit;
		if (hasMore) page.pop();

		// returned oldest -> newest, ready to render
		res.status(200).json({ messages: page.reverse(), hasMore });
	} catch (error) {
		console.log("Error in getMessages controller: ", error.message);
		res.status(500).json({ error: "Internal server error" });
	}
};

// Unread messages per sender: { [senderId]: count }
export const getUnreadCounts = async (req, res) => {
	try {
		const me = req.user._id;
		const states = await ReadState.find({ userId: me }).lean();

		// per peer: messages newer than my cursor; peers I have never opened: everything they sent
		const clauses = states.map((s) => ({ senderId: s.peerId, createdAt: { $gt: s.lastReadAt } }));
		const knownPeers = states.map((s) => s.peerId);

		const rows = await Message.aggregate([
			{ $match: { receiverId: me, $or: [...clauses, { senderId: { $nin: knownPeers } }] } },
			{ $group: { _id: "$senderId", count: { $sum: 1 } } },
		]);

		res.status(200).json(Object.fromEntries(rows.map((r) => [String(r._id), r.count])));
	} catch (error) {
		console.log("Error in getUnreadCounts controller: ", error.message);
		res.status(500).json({ error: "Internal server error" });
	}
};

// "I have read this chat up to <upTo>" (the createdAt of the newest message the user has seen)
export const markAsRead = async (req, res) => {
	try {
		const { id: peerId } = req.params;
		const me = req.user._id;

		if (!mongoose.isValidObjectId(peerId)) {
			return res.status(400).json({ error: "Invalid user id" });
		}
		const upTo = new Date(req.body?.upTo);
		if (typeof req.body?.upTo !== "string" || Number.isNaN(upTo.getTime())) {
			return res.status(400).json({ error: "Invalid 'upTo' date" });
		}
		if (!(await userExists(peerId))) {
			return res.status(404).json({ error: "User not found" });
		}

		// a client can't "pre-read" the future: that would silently swallow messages that arrive later
		const lastReadAt = new Date(Math.min(upTo.getTime(), Date.now()));

		// $max: the cursor only ever moves forward, so late/out-of-order requests can't mark messages unread again
		await ReadState.updateOne({ userId: me, peerId }, { $max: { lastReadAt } }, { upsert: true });

		res.status(204).end();
	} catch (error) {
		console.log("Error in markAsRead controller: ", error.message);
		res.status(500).json({ error: "Internal server error" });
	}
};
