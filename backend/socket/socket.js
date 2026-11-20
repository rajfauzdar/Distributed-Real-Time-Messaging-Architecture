import { Server } from "socket.io";
import http from "http";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { createClient } from "redis";
import { createAdapter } from "@socket.io/redis-adapter";
import { createMemoryPresence, createRedisPresence, presenceMember } from "./presence.js";

const app = express();

const server = http.createServer(app);
const io = new Server(server, {
	cors: {
		origin: process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(",") : ["http://localhost:3000"],
		methods: ["GET", "POST"],
		credentials: true,
	},
});

// ---------- Redis (optional) ----------
// With REDIS_URL set, rooms/broadcasts are shared between all server instances (Redis Pub/Sub)
// and presence lives in Redis. Without it everything stays in this process.
let presence = createMemoryPresence();
const redisClients = [];

if (process.env.REDIS_URL) {
	const connectRedis = async (client, name) => {
		client.on("error", (err) => console.error(`Redis ${name} error:`, err.message));
		await client.connect();
		redisClients.push(client);
	};

	const pubClient = createClient({ url: process.env.REDIS_URL });
	const subClient = pubClient.duplicate();
	const dataClient = pubClient.duplicate();
	await Promise.all([connectRedis(pubClient, "pub"), connectRedis(subClient, "sub"), connectRedis(dataClient, "data")]);

	io.adapter(createAdapter(pubClient, subClient));
	presence = createRedisPresence(dataClient);
	console.log("Redis connected: Pub/Sub adapter + shared presence enabled");
} else {
	console.log("REDIS_URL not set: running single-instance (in-memory) mode");
}

// every socket of a user joins this room, so "send to user" works across all tabs AND all server instances
const userRoom = (userId) => `user:${userId}`;

export const emitToUser = (userId, event, payload) => {
	io.to(userRoom(userId)).emit(event, payload);
};

const broadcastOnline = async () => {
	try {
		io.emit("getOnlineUsers", await presence.onlineUserIds());
	} catch (err) {
		console.error("Failed to broadcast online users:", err.message);
	}
};

// ---------- auth ----------
const getJwtFromCookieHeader = (header = "") => {
	for (const part of header.split(";")) {
		const idx = part.indexOf("=");
		if (idx === -1) continue;
		if (part.slice(0, idx).trim() === "jwt") {
			try {
				return decodeURIComponent(part.slice(idx + 1).trim());
			} catch {
				return null;
			}
		}
	}
	return null;
};

// Authenticate the socket using the same httpOnly JWT cookie the REST API uses,
// never a client supplied userId.
io.use((socket, next) => {
	try {
		const token = getJwtFromCookieHeader(socket.handshake.headers.cookie);
		if (!token) return next(new Error("Unauthorized"));
		const decoded = jwt.verify(token, process.env.JWT_SECRET);
		socket.data.userId = String(decoded.userId);
		next();
	} catch {
		next(new Error("Unauthorized"));
	}
});

// ---------- connections ----------
const localMembers = new Set(); // presence members owned by THIS instance (for heartbeats)
const TYPING_MIN_INTERVAL_MS = 800;

io.on("connection", async (socket) => {
	const userId = socket.data.userId;
	const entry = presenceMember(userId, socket.id);

	socket.join(userRoom(userId));
	localMembers.add(entry);
	await presence.add(userId, socket.id).catch((e) => console.error("presence add failed:", e.message));
	await broadcastOnline();

	// Typing indicators are ephemeral: relayed through Pub/Sub only, never stored in a database.
	let lastTypingAt = 0;
	socket.on("typing", (payload) => {
		const to = payload?.to;
		if (typeof to !== "string" || !mongoose.isValidObjectId(to) || to === userId) return;
		const now = Date.now();
		if (now - lastTypingAt < TYPING_MIN_INTERVAL_MS) return; // basic flood protection
		lastTypingAt = now;
		emitToUser(to, "typing", { from: userId });
	});
	socket.on("stopTyping", (payload) => {
		const to = payload?.to;
		if (typeof to !== "string" || !mongoose.isValidObjectId(to) || to === userId) return;
		emitToUser(to, "stopTyping", { from: userId });
	});

	socket.on("disconnect", async () => {
		localMembers.delete(entry);
		await presence.remove(userId, socket.id).catch((e) => console.error("presence remove failed:", e.message));
		await broadcastOnline();
	});
});

// Heartbeat: keep our sockets "fresh" in Redis, drop sockets of crashed instances, and re-broadcast.
const heartbeat = setInterval(async () => {
	try {
		await presence.touch([...localMembers]);
		await broadcastOnline();
	} catch (err) {
		console.error("presence heartbeat failed:", err.message);
	}
}, 15_000);
heartbeat.unref();

// ---------- shutdown ----------
export const closeSocketLayer = async () => {
	clearInterval(heartbeat);
	// remove our sockets right away so users don't appear online for the TTL after a deploy
	await Promise.all(
		[...localMembers].map((m) => presence.remove(m.slice(0, m.indexOf("|")), m.slice(m.indexOf("|") + 1)))
	).catch(() => {});
	await new Promise((resolve) => io.close(resolve));
	await Promise.all(redisClients.map((c) => c.quit().catch(() => {})));
};

export { app, io, server };
