import mongoose from "mongoose";
import Message from "../models/message.model.js";
import User from "../models/user.model.js";
import { getReceiverSocketIds, io } from "../socket/socket.js";

const MAX_MESSAGE_LENGTH = 2000;
const HISTORY_LIMIT = 200;

export const sendMessage = async (req, res) => {
	try {
		const { message } = req.body;
		const { id: receiverId } = req.params;
		const senderId = req.user._id;

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

		const receiverExists = await User.exists({ _id: receiverId });
		if (!receiverExists) {
			return res.status(404).json({ error: "User not found" });
		}

		const newMessage = await Message.create({
			senderId,
			receiverId,
			message: message.trim(),
		});

		// deliver to every open tab/device of the receiver
		for (const socketId of getReceiverSocketIds(receiverId)) {
			io.to(socketId).emit("newMessage", newMessage);
		}

		res.status(201).json(newMessage);
	} catch (error) {
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

		// latest N messages of the two-way conversation, returned oldest -> newest
		const messages = await Message.find({
			$or: [
				{ senderId, receiverId: userToChatId },
				{ senderId: userToChatId, receiverId: senderId },
			],
		})
			.sort({ createdAt: -1 })
			.limit(HISTORY_LIMIT)
			.lean();

		res.status(200).json(messages.reverse());
	} catch (error) {
		console.log("Error in getMessages controller: ", error.message);
		res.status(500).json({ error: "Internal server error" });
	}
};
