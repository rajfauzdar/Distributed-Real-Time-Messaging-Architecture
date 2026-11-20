// Needs the docker-compose stack (Redis adapter).  Puts user A on instance 1 and user B on instance 2.
//   docker compose up -d && node tests/cross-instance.test.mjs
// (Also runs against ONE server - pass the same URL twice via INSTANCE_A / INSTANCE_B - to test typing + presence alone.)
import { INSTANCE_A, INSTANCE_B, TestWorld, connectSocket, createSuite, http, sleep } from "./lib.mjs";

const suite = createSuite(`Cross-instance delivery (${INSTANCE_A} <-> ${INSTANCE_B})`);
const { check } = suite;
const world = new TestWorld();
const sockets = [];

try {
	const [hA, hB] = [await http(INSTANCE_A, "/healthz"), await http(INSTANCE_B, "/healthz")];
	suite.log(`A is served by instance ${hA.data?.instance}, B by ${hB.data?.instance}`);
	check("both instances are healthy", hA.status === 200 && hB.status === 200);
	if (INSTANCE_A !== INSTANCE_B) check("A and B are on DIFFERENT instances", hA.data.instance !== hB.data.instance);

	const a = await world.signup(INSTANCE_A, "a");
	const b = await world.signup(INSTANCE_B, "b");
	const sA = await connectSocket(INSTANCE_A, a.cookie);
	const sB = await connectSocket(INSTANCE_B, b.cookie);
	sockets.push(sA, sB);
	let onlineSeenByA = [];
	sA.on("getOnlineUsers", (u) => (onlineSeenByA = u));
	await sleep(500);
	check("A sees B online across instances", onlineSeenByA.includes(a.id) && onlineSeenByA.includes(b.id), JSON.stringify(onlineSeenByA));

	const gotA = [], gotB = [];
	sA.on("newMessage", (m) => gotA.push(m));
	sB.on("newMessage", (m) => gotB.push(m));
	let r = await http(INSTANCE_A, `/api/messages/send/${b.id}`, { body: { message: "A->B" }, cookie: a.cookie });
	await sleep(500);
	check("message sent via A's instance reaches B's socket on the other instance", r.status === 201 && gotB.length === 1, `${r.status}/${gotB.length}`);
	r = await http(INSTANCE_B, `/api/messages/send/${a.id}`, { body: { message: "B->A" }, cookie: b.cookie });
	await sleep(500);
	check("message sent via B's instance reaches A's socket on the other instance", r.status === 201 && gotA.length === 1, `${r.status}/${gotA.length}`);

	// ---- typing indicators
	const typingB = [], stopB = [], typingA = [];
	sB.on("typing", (p) => typingB.push(p));
	sB.on("stopTyping", (p) => stopB.push(p));
	sA.on("typing", (p) => typingA.push(p));
	sA.emit("typing", { to: b.id });
	await sleep(400);
	check("typing from A arrives at B", typingB.length === 1 && typingB[0].from === a.id, JSON.stringify(typingB));
	check("A doesn't receive its own typing event", typingA.length === 0);
	sA.emit("typing", { to: b.id });
	sA.emit("typing", { to: b.id });
	sA.emit("typing", { to: b.id });
	await sleep(400);
	check("a flood of typing events is rate-limited server-side", typingB.length === 1, `got ${typingB.length}`);
	sA.emit("stopTyping", { to: b.id });
	await sleep(400);
	check("stopTyping arrives at B", stopB.length === 1 && stopB[0].from === a.id);
	sA.emit("typing", { to: "not-an-id" });
	sA.emit("typing", { to: a.id });
	sA.emit("typing", {});
	sA.emit("typing");
	await sleep(1000);
	check("invalid typing payloads are ignored (no crash, nothing delivered)", typingB.length === 1 && typingA.length === 0 && sA.connected);

	sB.close();
	await sleep(600);
	check("B shows offline for A after B disconnects", !onlineSeenByA.includes(b.id), JSON.stringify(onlineSeenByA));
} catch (err) {
	suite.fail(err);
}
sockets.forEach((s) => s.close());
await suite.finish(() => world.cleanup());
