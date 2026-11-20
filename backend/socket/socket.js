import { Server } from "socket.io";
import http from "http";
import express from "express";
import jwt from "jsonwebtoken";

const app = express();

const server = http.createServer(app);
const io = new Server(server, {
	cors: {
		origin: process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(",") : ["http://localhost:3000"],
		methods: ["GET", "POST"],
		credentials: true,
	},
});

// {userId: Set<socketId>} - a user can be connected from several tabs/devices at once
const userSocketMap = new Map();

export const getReceiverSocketIds = (receiverId) => {
	return [...(userSocketMap.get(String(receiverId)) || [])];
};

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

io.on("connection", (socket) => {
	const userId = socket.data.userId;

	if (!userSocketMap.has(userId)) userSocketMap.set(userId, new Set());
	userSocketMap.get(userId).add(socket.id);

	// io.emit() is used to send events to all the connected clients
	io.emit("getOnlineUsers", [...userSocketMap.keys()]);

	socket.on("disconnect", () => {
		const sockets = userSocketMap.get(userId);
		if (sockets) {
			sockets.delete(socket.id);
			if (sockets.size === 0) userSocketMap.delete(userId);
		}
		io.emit("getOnlineUsers", [...userSocketMap.keys()]);
	});
});

export { app, io, server };
