// Retried sends must never create duplicates.   BASE_URL=... node tests/idempotency.test.mjs
import { BASE_URL as BASE, TestWorld, connectSocket, createSuite, http, sleep, waitFor } from "./lib.mjs";

const suite = createSuite(`Idempotent sends (${BASE})`);
const { check } = suite;
const world = new TestWorld();
let sB;

try {
	const a = await world.signup(BASE, "a");
	const b = await world.signup(BASE, "b");
	sB = await connectSocket(BASE, b.cookie);
	const live = [];
	sB.on("newMessage", (m) => live.push(m));

	const cid = `idem-${world.tag}-0001`;
	const send = (message, clientId) => http(BASE, `/api/messages/send/${b.id}`, { body: { message, clientId }, cookie: a.cookie });

	const r1 = await send("hello", cid);
	check("first send with a clientId -> 201 and echoes it", r1.status === 201 && r1.data.clientId === cid, JSON.stringify(r1.data));
	const r2 = await send("hello", cid);
	check("same clientId again -> 200 with the SAME _id", r2.status === 200 && r2.data._id === r1.data._id, JSON.stringify(r2.data));
	const [r3, r4] = await Promise.all([send("race", `${cid}-x`), send("race", `${cid}-x`)]);
	check("two simultaneous sends with one clientId -> a single message", r3.data._id === r4.data._id && [r3.status, r4.status].sort().join() === "200,201", `${r3.status}/${r4.status}`);
	await sleep(600);
	check("the receiver was notified exactly once per message", live.length === 2, `got ${live.length}`);

	const persisted = await waitFor(async () => (await http(BASE, `/api/messages/${a.id}`, { cookie: b.cookie })).data.messages.length === 2, 15000);
	check("history contains exactly 2 messages", persisted >= 0);

	check("malformed clientIds -> 400", (await send("x", "short")).status === 400 && (await send("x", { $ne: 1 })).status === 400);
	const n1 = await send("legacy client", undefined);
	const n2 = await send("legacy client", undefined);
	check("sends WITHOUT a clientId still work and are not deduplicated", n1.status === 201 && n2.status === 201 && n1.data._id !== n2.data._id);
	const other = await http(BASE, `/api/messages/send/${a.id}`, { body: { message: "from b", clientId: cid }, cookie: b.cookie });
	check("the same clientId from a different sender is a different message", other.status === 201);
} catch (err) {
	suite.fail(err);
}
sB?.close();
await suite.finish(() => world.cleanup());
