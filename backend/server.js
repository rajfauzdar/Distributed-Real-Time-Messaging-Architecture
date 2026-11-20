import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

// load env vars before anything reads them
dotenv.config();

for (const key of ["MONGO_DB_URI", "JWT_SECRET"]) {
	if (!process.env[key]) {
		console.error(`Missing required environment variable: ${key}`);
		process.exit(1);
	}
}

const { default: authRoutes } = await import("./routes/auth.routes.js");
const { default: messageRoutes } = await import("./routes/message.routes.js");
const { default: userRoutes } = await import("./routes/user.routes.js");
const { default: connectToMongoDB } = await import("./db/connectToMongoDB.js");
const { app, server } = await import("./socket/socket.js");

// resolve relative to this file, not to wherever the process was started from
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.join(__dirname, "..", "frontend", "dist");

const PORT = process.env.PORT || 5000;

// Render (and most hosts) sit behind a reverse proxy - needed for correct client IPs / rate limiting
app.set("trust proxy", 1);

app.use(
	helmet({
		contentSecurityPolicy: {
			directives: {
				defaultSrc: ["'self'"],
				imgSrc: ["'self'", "data:", "https://avatar.iran.liara.run"],
				mediaSrc: ["'self'", "data:", "blob:"],
				connectSrc: ["'self'", "ws:", "wss:"],
				styleSrc: ["'self'", "'unsafe-inline'"],
			},
		},
	})
);
app.use(express.json({ limit: "10kb" })); // to parse the incoming requests with JSON payloads (from req.body)
app.use(cookieParser());

// brute-force protection for login / signup
const authLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 50,
	standardHeaders: true,
	legacyHeaders: false,
	message: { error: "Too many attempts, please try again later" },
});
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/signup", authLimiter);

app.use("/api/auth", authRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/users", userRoutes);

// unknown API routes should be a JSON 404, not the SPA html
app.use("/api", (req, res) => {
	res.status(404).json({ error: "Not found" });
});

app.use(express.static(distPath));

app.get("*", (req, res) => {
	res.sendFile(path.join(distPath, "index.html"));
});

// global error handler (bad JSON bodies, unexpected throws)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
	if (err.type === "entity.parse.failed") {
		return res.status(400).json({ error: "Invalid JSON body" });
	}
	if (err.type === "entity.too.large") {
		return res.status(413).json({ error: "Request body too large" });
	}
	console.error("Unhandled error:", err.message);
	res.status(500).json({ error: "Internal server error" });
});

await connectToMongoDB();

server.listen(PORT, () => {
	console.log(`Server Running on port ${PORT}`);
});
