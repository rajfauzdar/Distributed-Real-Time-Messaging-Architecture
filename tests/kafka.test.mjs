// Needs the docker-compose stack (Kafka + consumer). Stops/kills containers on purpose - takes a few minutes.
//   docker compose up -d && node tests/kafka.test.mjs
import {
	INSTANCE_A, INSTANCE_B, KAFKA_EXTERNAL, Kafka, TestWorld, compose, connectDb, connectSocket, createSuite, http, logLevel,
	mongoose, percentile, sleep, waitFor,
} from "./lib.mjs";

const suite = createSuite("Kafka write path");
const { check } = suite;
const world = new TestWorld();
let sB;

try {
	const db = await connectDb();
	const messages = db.collection("messages");
	const a = await world.signup(INSTANCE_A, "a");
	const b = await world.signup(INSTANCE_B, "b");
	const cid = (n) => `kt-${world.tag}-${String(n).padStart(5, "0")}`;
	const send = (n, text = `msg ${n}`, base = INSTANCE_A) => http(base, `/api/messages/send/${b.id}`, { body: { message: text, clientId: cid(n) }, cookie: a.cookie });
	const countDb = (extra = {}) => messages.countDocuments({ senderId: new mongoose.Types.ObjectId(a.id), ...extra });
	const history = async () => (await http(INSTANCE_B, `/api/messages/${a.id}`, { cookie: b.cookie })).data?.messages || [];

	sB = await connectSocket(INSTANCE_B, b.cookie);
	const live = [];
	sB.on("newMessage", (m) => live.push(m));

	// 1. basic flow
	let t0 = Date.now();
	const r1 = await send(1, "first through kafka");
	check(`send is acknowledged once Kafka has it -> 201 (${Date.now() - t0}ms)`, r1.status === 201 && r1.data.clientId === cid(1), JSON.stringify(r1.data));
	await sleep(300);
	check("the receiver got it live over the socket", live.length === 1 && live[0]._id === r1.data._id, live.length);
	const lag = await waitFor(async () => (await history()).some((m) => m._id === r1.data._id), 10000, 50);
	check(`the consumer persisted it to MongoDB (visible in history after ~${lag}ms)`, lag >= 0);

	// 2. idempotent retries
	const r2 = await send(1, "first through kafka");
	check("retry with the same clientId -> 200, same _id", r2.status === 200 && r2.data._id === r1.data._id, JSON.stringify(r2.data));
	await sleep(1500);
	check("the receiver is NOT notified twice and MongoDB has exactly one copy", live.length === 1 && (await countDb({ clientId: cid(1) })) === 1, `live=${live.length}`);

	// 3. the buffer: consumer down -> still accepted + delivered, persisted (in order, once) when it returns
	suite.log("stopping the consumer");
	compose("stop consumer");
	const before = await countDb();
	for (let i = 10; i < 15; i++) {
		const r = await send(i, `buffered ${i}`);
		if (r.status !== 201) check(`buffered send ${i}`, false, r.status);
	}
	await sleep(2000);
	check("consumer down: sends succeed and are delivered live", live.length === 6, `live=${live.length}`);
	check("...but nothing reaches MongoDB yet - Kafka is holding the messages", (await countDb()) === before);
	suite.log("starting the consumer");
	compose("start consumer");
	const drained = await waitFor(async () => (await countDb()) === before + 5, 40000, 250);
	check(`consumer back: all 5 buffered messages are persisted (${drained}ms)`, drained >= 0, `${await countDb()}`);
	const buffered = (await history()).filter((m) => m.message.startsWith("buffered")).map((m) => m.message);
	check("persisted exactly once and in order", buffered.join() === "buffered 10,buffered 11,buffered 12,buffered 13,buffered 14", buffered.join());

	// 4. hard-crash the consumer in the middle of a burst
	suite.log("sending 60 messages and killing the consumer in the middle");
	const crashBase = await countDb();
	const burst = Promise.all(Array.from({ length: 60 }, (_, i) => send(100 + i, `crash ${i}`)));
	await sleep(40);
	compose("kill consumer");
	const burstRes = await burst;
	check("all 60 sends were accepted", burstRes.every((r) => r.status === 201), burstRes.map((r) => r.status).join());
	compose("start consumer");
	await waitFor(async () => (await countDb()) >= crashBase + 60, 40000, 250);
	await sleep(1500); // give any (wrong) duplicates time to show up
	check("after the consumer crash + restart: exactly 60 new messages (none lost, none duplicated)", (await countDb()) === crashBase + 60, `${(await countDb()) - crashBase}`);

	// 5. poison messages
	const kafka = new Kafka({ clientId: "test", brokers: [KAFKA_EXTERNAL], logLevel: logLevel.NOTHING });
	const admin = kafka.admin();
	await admin.connect();
	const dlqSize = async () => (await admin.fetchTopicOffsets("chat.messages.dlq")).reduce((s, p) => s + Number(p.high), 0);
	const dlqBefore = await dlqSize();
	const producer = kafka.producer();
	await producer.connect();
	await producer.send({
		topic: "chat.messages",
		messages: [
			{ key: "poison", value: "this is not json" },
			{ key: "poison", value: JSON.stringify({ _id: "nope", senderId: a.id, receiverId: b.id, message: "x", createdAt: new Date() }) },
		],
	});
	await producer.disconnect();
	const r5 = await send(200, "after poison");
	const afterPoison = await waitFor(async () => (await history()).some((m) => m._id === r5.data._id), 15000, 100);
	check("malformed events are parked in the dead-letter topic (2 added)", (await dlqSize()) - dlqBefore === 2, `${(await dlqSize()) - dlqBefore}`);
	check("a valid message after the poison is still persisted (the partition is not blocked)", afterPoison >= 0);
	await admin.disconnect();

	// 6. Kafka outage
	suite.log("stopping Kafka");
	compose("stop kafka");
	t0 = Date.now();
	const r6 = await send(300, "during outage");
	check(`during a Kafka outage the API answers 503 (not 201), after ${Date.now() - t0}ms`, r6.status === 503 && Date.now() - t0 < 12000, `${r6.status}`);
	check("...and nothing was delivered to the receiver", !live.some((m) => m.message === "during outage"));
	suite.log("starting Kafka");
	compose("start kafka");
	let r7;
	const recovered = await waitFor(async () => (r7 = await send(300, "during outage")).status === 201, 90000, 2000);
	check(`the same clientId retried after recovery -> 201 (recovered after ~${Math.round(recovered / 1000)}s)`, recovered >= 0, JSON.stringify(r7?.data));
	const persistedAfter = await waitFor(async () => (await countDb({ clientId: cid(300) })) >= 1, 120000, 250);
	suite.log(`consumer persisted it ${Math.round(persistedAfter / 1000)}s after the API accepted it (it must first rejoin its group after the broker restart)`);
	await sleep(1500);
	check("the retried message is persisted exactly once", persistedAfter >= 0 && (await countDb({ clientId: cid(300) })) === 1, `copies=${await countDb({ clientId: cid(300) })} after ${persistedAfter}ms`);

	// 7. throughput smoke test
	const N = 300, CONCURRENCY = 30;
	const latencies = [];
	let next = 1000, failures = 0;
	const base = await countDb();
	t0 = Date.now();
	await Promise.all(
		Array.from({ length: CONCURRENCY }, async () => {
			while (next < 1000 + N) {
				const n = next++;
				const started = Date.now();
				const r = await send(n, `load ${n}`, n % 2 ? INSTANCE_A : INSTANCE_B);
				latencies.push(Date.now() - started);
				if (r.status !== 201) failures++;
			}
		})
	);
	const sendMs = Date.now() - t0;
	const persisted = await waitFor(async () => (await countDb()) === base + N, 60000, 100);
	suite.log(`${N} sends, ${CONCURRENCY} concurrent: ${Math.round((N / sendMs) * 1000)} msg/s accepted, API latency p50=${percentile(latencies, 50)}ms p95=${percentile(latencies, 95)}ms; all persisted ${Date.now() - t0}ms after start`);
	check(`burst of ${N}: no failures, all persisted exactly once`, failures === 0 && persisted >= 0 && (await countDb()) === base + N, `failures=${failures}`);
} catch (err) {
	suite.fail(err);
}
sB?.close();
try {
	compose("start kafka consumer");
} catch {
	// best effort
}
await suite.finish(() => world.cleanup());
