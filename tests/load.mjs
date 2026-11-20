// Load test: many users connected over WebSockets, each sending messages to a partner at a steady pace.
//
//   node tests/load.mjs                                   (defaults: 40 users x 25 messages, ~200ms think time)
//   USERS=100 MESSAGES=40 THINK_MS=100 node tests/load.mjs
//   URLS=http://localhost:8080 node tests/load.mjs        (through nginx; comma-separate several URLs to spread users)
//
// Reports API latency, end-to-end delivery latency (sender's clock -> receiver's socket), message loss/duplicates
// on the live path, and how long MongoDB takes to hold everything. Exits non-zero if anything was lost or duplicated.
//
// Users: by default they are inserted directly into the database and given locally signed JWTs (this only works
// against a server that shares your local JWT_SECRET and avoids the signup rate limiter). Against a remote
// deployment use SIGNUP=1: users are created through the real signup API instead (limited by the signup rate
// limiter, so keep USERS <= ~40). Test users are removed afterwards either way.
import {
	INSTANCE_A, INSTANCE_B, TEST_PREFIX, connectDb, connectSocket, createSuite, http, jwt, mongoose, percentile, removeTestUsers, sleep, waitFor,
} from "./lib.mjs";

const USERS = Number(process.env.USERS || 40);
const MESSAGES = Number(process.env.MESSAGES || 25);
const THINK_MS = Number(process.env.THINK_MS || 200);
const URLS = (process.env.URLS || `${INSTANCE_A},${INSTANCE_B}`).split(",").map((u) => u.trim());

const suite = createSuite(`Load test: ${USERS} users x ${MESSAGES} messages, think ~${THINK_MS}ms, servers: ${URLS.join(" ")}`);
const runId = `${Date.now().toString(36)}`;
const usernames = [];

try {
	// ---- setup
	const db = await connectDb();
	let users;
	if (process.env.SIGNUP === "1") {
		users = [];
		for (let i = 0; i < USERS; i++) {
			const base = URLS[i % URLS.length];
			const username = `${TEST_PREFIX}l${i}_${runId}`; // usernames are limited to 20 chars
			usernames.push(username);
			const r = await http(base, "/api/auth/signup", { body: { fullName: `Load ${i}`, username, password: "secret1", confirmPassword: "secret1", gender: "male" } });
			if (r.status !== 201) throw new Error(`signup ${i} failed (${r.status}): ${JSON.stringify(r.data)}`);
			users.push({ id: r.data._id, cookie: r.cookie, base });
		}
	} else {
		const docs = Array.from({ length: USERS }, (_, i) => {
			const username = `${TEST_PREFIX}l${i}_${runId}`;
			usernames.push(username);
			const now = new Date();
			return { _id: new mongoose.Types.ObjectId(), fullName: `Load ${i}`, username, password: "not-a-real-hash", gender: "male", profilePic: "", createdAt: now, updatedAt: now, __v: 0 };
		});
		await db.collection("users").insertMany(docs);
		users = docs.map((d, i) => ({
			id: String(d._id),
			cookie: `jwt=${jwt.sign({ userId: String(d._id) }, process.env.JWT_SECRET, { expiresIn: "1h" })}`,
			base: URLS[i % URLS.length],
		}));
	}

	const sockets = await Promise.all(users.map((u) => connectSocket(u.base, u.cookie)));
	suite.log(`${sockets.length} sockets connected`);

	// ---- measure
	const received = new Map(); // clientId -> times delivered
	const deliveryLatency = [];
	sockets.forEach((s) =>
		s.on("newMessage", (m) => {
			received.set(m.clientId, (received.get(m.clientId) || 0) + 1);
			deliveryLatency.push(Date.now() - Number(m.message.split("|")[1]));
		})
	);

	const apiLatency = [];
	const statuses = {};
	const accepted = new Set();
	const startedAt = Date.now();

	await Promise.all(
		users.map(async (user, i) => {
			const partner = users[(i + 1) % USERS];
			await sleep(Math.random() * THINK_MS); // spread the start
			for (let seq = 0; seq < MESSAGES; seq++) {
				const clientId = `ld-${runId}-${i}-${seq}`;
				const sentAt = Date.now();
				try {
					const r = await http(user.base, `/api/messages/send/${partner.id}`, { body: { message: `${seq}|${sentAt}`, clientId }, cookie: user.cookie });
					apiLatency.push(Date.now() - sentAt);
					statuses[r.status] = (statuses[r.status] || 0) + 1;
					if (r.status === 201) accepted.add(clientId);
				} catch (err) {
					statuses[err.code || "error"] = (statuses[err.code || "error"] || 0) + 1;
				}
				await sleep(THINK_MS * (0.5 + Math.random()));
			}
		})
	);
	const sendDuration = Date.now() - startedAt;

	// ---- verify: live delivery, then persistence
	await waitFor(() => received.size >= accepted.size, 20000, 100);
	const lost = [...accepted].filter((id) => !received.has(id)).length;
	const duplicated = [...received.values()].filter((n) => n > 1).length;

	const senderIds = users.map((u) => new mongoose.Types.ObjectId(u.id));
	const countDb = () => db.collection("messages").countDocuments({ senderId: { $in: senderIds }, clientId: { $regex: `^ld-${runId}-` } });
	const persistWait = await waitFor(async () => (await countDb()) >= accepted.size, 60000, 100);
	await sleep(500);
	const persisted = await countDb();

	const total = USERS * MESSAGES;
	const throughput = Math.round((accepted.size / sendDuration) * 1000);
	console.log("\n  results");
	console.log(`    attempted        ${total}    accepted ${accepted.size}    statuses ${JSON.stringify(statuses)}`);
	console.log(`    throughput       ${throughput} msg/s accepted over ${(sendDuration / 1000).toFixed(1)}s`);
	console.log(`    API latency      p50 ${percentile(apiLatency, 50)}ms   p95 ${percentile(apiLatency, 95)}ms   p99 ${percentile(apiLatency, 99)}ms   max ${Math.max(...apiLatency)}ms`);
	console.log(`    delivery latency p50 ${percentile(deliveryLatency, 50)}ms   p95 ${percentile(deliveryLatency, 95)}ms   p99 ${percentile(deliveryLatency, 99)}ms   (sender clock -> receiver socket)`);
	console.log(`    live delivery    ${received.size}/${accepted.size} received, lost ${lost}, duplicated ${duplicated}`);
	console.log(`    persisted        ${persisted}/${accepted.size} in MongoDB, ${persistWait >= 0 ? `complete +${persistWait}ms after live delivery finished` : "NOT complete after 60s"}`);
	console.log(`    markdown row     | ${USERS} | ${MESSAGES} | ${THINK_MS}ms | ${URLS.length} | ${throughput} | ${percentile(apiLatency, 50)} / ${percentile(apiLatency, 95)} / ${percentile(apiLatency, 99)} ms | ${percentile(deliveryLatency, 50)} / ${percentile(deliveryLatency, 95)} ms | ${lost}/${duplicated} | ${persisted}/${accepted.size} |`);

	suite.check("every attempted message was accepted (201)", accepted.size === total, JSON.stringify(statuses));
	suite.check("no message lost on the live path", lost === 0, `${lost}`);
	suite.check("no message delivered twice", duplicated === 0, `${duplicated}`);
	suite.check("every accepted message is in MongoDB exactly once", persisted === accepted.size, `${persisted}/${accepted.size}`);
	sockets.forEach((s) => s.close());
} catch (err) {
	suite.fail(err);
}
await suite.finish(async () => {
	const removed = await removeTestUsers(usernames);
	console.log(`cleanup: removed ${removed.users} load-test users and ${removed.messages} messages`);
	await mongoose.disconnect();
});
