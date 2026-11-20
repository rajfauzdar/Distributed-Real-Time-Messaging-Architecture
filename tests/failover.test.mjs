// Needs the docker-compose stack. Kills / stops instance "app2" while a user is connected to it.
//   docker compose up -d && node tests/failover.test.mjs
import { INSTANCE_A, INSTANCE_B, TestWorld, compose, connectSocket, createSuite, http, sleep, waitFor } from "./lib.mjs";

const suite = createSuite("Instance failure & presence");
const { check } = suite;
const world = new TestWorld();
let sA, sB;

try {
	const a = await world.signup(INSTANCE_A, "a");
	const b = await world.signup(INSTANCE_B, "b");
	let online = [];
	sA = await connectSocket(INSTANCE_A, a.cookie);
	sA.on("getOnlineUsers", (u) => (online = u));
	sB = await connectSocket(INSTANCE_B, b.cookie);
	await sleep(500);
	check("A sees B online (B is on instance 2)", online.includes(b.id));

	// 1) hard crash: the instance gets no chance to clean up after itself
	suite.log("docker kill app2 (hard crash) - waiting for the presence TTL (~45s + heartbeat)...");
	compose("kill app2");
	const took = await waitFor(() => !online.includes(b.id), 75000, 1000);
	check(`a crashed instance's users expire from presence (${Math.round(took / 1000)}s)`, took >= 0, JSON.stringify(online));
	check("A is unaffected: still online and connected to instance 1", online.includes(a.id) && sA.connected);
	const r = await http(INSTANCE_A, `/api/messages/send/${b.id}`, { body: { message: "to B while its instance is dead" }, cookie: a.cookie });
	check("sending to a user whose instance is dead still succeeds", r.status === 201, r.status);

	// 2) restart: the user reconnects and is online again
	compose("start app2");
	await waitFor(async () => (await fetch(`${INSTANCE_B}/healthz`).catch(() => ({ ok: false }))).ok, 30000, 1000);
	sB = await connectSocket(INSTANCE_B, b.cookie);
	await sleep(700);
	check("after the restart B reconnects and is online again", online.includes(b.id));

	// 3) graceful stop (SIGTERM): the instance removes its own users immediately
	compose("stop -t 10 app2");
	await sleep(1500);
	check("graceful stop clears B from presence immediately (<2s)", !online.includes(b.id), JSON.stringify(online));
} catch (err) {
	suite.fail(err);
}
sA?.close();
sB?.close();
try {
	compose("start app2");
} catch {
	// best effort: leave the stack as we found it
}
await suite.finish(() => world.cleanup());
