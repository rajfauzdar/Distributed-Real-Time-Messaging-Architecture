// Shared helpers for the integration / load tests. Everything runs against REAL servers (see README, "Testing").
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import { execSync } from "child_process";

export const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const rootRequire = createRequire(path.join(ROOT, "package.json"));

export const mongoose = rootRequire("mongoose");
export const jwt = rootRequire("jsonwebtoken");
export const { Kafka, logLevel } = rootRequire("kafkajs");
export const { io } = rootRequire("socket.io-client");
rootRequire("dotenv").config({ path: path.join(ROOT, ".env") });

export const BASE_URL = process.env.BASE_URL || "http://localhost:5000";
// the two directly-published instances of the docker-compose stack
export const INSTANCE_A = process.env.INSTANCE_A || "http://localhost:5001";
export const INSTANCE_B = process.env.INSTANCE_B || "http://localhost:5002";
export const KAFKA_EXTERNAL = process.env.KAFKA_EXTERNAL || "localhost:9094";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const waitFor = async (cond, timeoutMs = 15000, stepMs = 100) => {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await cond()) return Date.now() - start;
		await sleep(stepMs);
	}
	return -1;
};

export const compose = (args) => execSync(`docker compose ${args}`, { cwd: ROOT, stdio: "pipe" }).toString().trim();

export const percentile = (values, p) => {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

// ---------- tiny test runner ----------
export const createSuite = (name) => {
	const results = [];
	console.log(`\n=== ${name} ===`);
	return {
		check(label, ok, detail = "") {
			results.push(Boolean(ok));
			console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  -> ${detail}`}`);
		},
		log: (msg) => console.log(`      ${msg}`),
		async finish(cleanup) {
			try {
				await cleanup?.();
			} catch (err) {
				console.log(`cleanup failed: ${err.message}`);
			}
			const passed = results.filter(Boolean).length;
			console.log(`\n${passed}/${results.length} checks passed`);
			process.exit(passed === results.length ? 0 : 1);
		},
		fail(err) {
			console.log(`SCRIPT ERROR: ${err?.stack || err}`);
			results.push(false);
		},
	};
};

// ---------- HTTP ----------
export const http = async (base, pathname, { method, body, cookie } = {}) => {
	const res = await fetch(base + pathname, {
		method: method || (body !== undefined ? "POST" : "GET"),
		headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
		body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
	});
	let data = null;
	try {
		data = await res.json();
	} catch {
		// empty / non-JSON body
	}
	const setCookie = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith("jwt=")) ?? null;
	return { status: res.status, data, cookie: setCookie ? setCookie.split(";")[0] : null, setCookie };
};

export const connectSocket = (base, cookie) =>
	new Promise((resolve, reject) => {
		const socket = io(base, { extraHeaders: { Cookie: cookie }, reconnection: false, transports: ["websocket"] });
		socket.on("connect", () => resolve(socket));
		socket.on("connect_error", (err) => reject(new Error(err.message)));
	});

// ---------- database + test users ----------
export const TEST_PREFIX = "zztest_";

export const connectDb = async () => {
	if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGO_DB_URI);
	return mongoose.connection;
};

export const removeTestUsers = async (usernames) => {
	const db = await connectDb();
	const filter = usernames ? { username: { $in: usernames } } : { username: { $regex: `^${TEST_PREFIX}` } };
	const ids = (await db.collection("users").find(filter).toArray()).map((u) => u._id);
	const messages = await db.collection("messages").deleteMany({ $or: [{ senderId: { $in: ids } }, { receiverId: { $in: ids } }] });
	await db.collection("readstates").deleteMany({ $or: [{ userId: { $in: ids } }, { peerId: { $in: ids } }] });
	await db.collection("users").deleteMany({ _id: { $in: ids } });
	return { users: ids.length, messages: messages.deletedCount };
};

// Creates throw-away users (signup through the real API) and deletes them + their data afterwards.
export class TestWorld {
	constructor() {
		// short on purpose: usernames are limited to 20 characters
		this.tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 3)}`;
		this.usernames = [];
	}

	async signup(base, label) {
		const username = `${TEST_PREFIX}${label}_${this.tag}`;
		this.usernames.push(username);
		const res = await http(base, "/api/auth/signup", {
			body: { fullName: `Test ${label}`, username, password: "secret1", confirmPassword: "secret1", gender: "male" },
		});
		if (res.status !== 201) throw new Error(`signup failed (${res.status}): ${JSON.stringify(res.data)}`);
		return { id: res.data._id, username, cookie: res.cookie };
	}

	async cleanup() {
		const removed = await removeTestUsers(this.usernames);
		console.log(`cleanup: removed ${removed.users} test users and ${removed.messages} test messages`);
		await mongoose.disconnect();
	}
}
