// REST + socket behaviour of one running server.   BASE_URL=http://localhost:5000 node tests/api.test.mjs
import { BASE_URL as BASE, TestWorld, connectSocket, createSuite, http, sleep } from "./lib.mjs";

const suite = createSuite(`API & sockets (${BASE})`);
const { check } = suite;
const world = new TestWorld();
const sockets = [];

try {
	// ---- input validation
	let r = await http(BASE, "/api/auth/signup", { body: { username: "x" } });
	check("signup with missing fields -> 400", r.status === 400, r.status);
	r = await http(BASE, "/api/auth/signup", { body: { fullName: "T", username: "bad name!", password: "123456", confirmPassword: "123456", gender: "male" } });
	check("signup with invalid username -> 400", r.status === 400, JSON.stringify(r.data));
	r = await http(BASE, "/api/auth/signup", { body: { fullName: "T", username: `${world.tag}`, password: "123", confirmPassword: "123", gender: "male" } });
	check("signup with short password -> 400", r.status === 400, JSON.stringify(r.data));
	r = await http(BASE, "/api/auth/signup", { body: { fullName: "T", username: `${world.tag}`, password: "123456", confirmPassword: "1234567", gender: "male" } });
	check("signup with mismatched passwords -> 400", r.status === 400, JSON.stringify(r.data));
	r = await http(BASE, "/api/auth/login", { body: { username: { $ne: null }, password: { $ne: null } } });
	check("NoSQL injection on login -> 400, no cookie", r.status === 400 && !r.setCookie, `${r.status}`);
	r = await http(BASE, "/api/auth/login", { body: "{bad json" });
	check("malformed JSON -> 400 JSON error", r.status === 400 && r.data?.error, `${r.status}`);

	// ---- signup / login
	const a = await world.signup(BASE, "a");
	const b = await world.signup(BASE, "b");
	check("signup A and B succeed", a.cookie && b.cookie);
	r = await http(BASE, "/api/auth/signup", { body: { fullName: "Dup", username: a.username.toUpperCase(), password: "secret1", confirmPassword: "secret1", gender: "male" } });
	check("duplicate username (different case) -> 400", r.status === 400, r.status);
	r = await http(BASE, "/api/auth/login", { body: { username: a.username, password: "wrong!!" } });
	check("login with wrong password -> 400", r.status === 400);
	r = await http(BASE, "/api/auth/login", { body: { username: a.username.toUpperCase(), password: "secret1" } });
	check("login (case-insensitive username) -> 200 + cookie", r.status === 200 && r.cookie);
	r = await http(BASE, "/api/auth/signup", { body: { fullName: "Test c", username: `${a.username}_c`, password: "secret1", confirmPassword: "secret1", gender: "male" } });
	check("session cookie is httpOnly + SameSite=Strict", /HttpOnly/i.test(r.setCookie) && /SameSite=Strict/i.test(r.setCookie), r.setCookie);
	world.usernames.push(`${a.username}_c`);

	// ---- sessions
	check("/me without cookie -> 401", (await http(BASE, "/api/auth/me")).status === 401);
	check("/me with garbage token -> 401 (not 500)", (await http(BASE, "/api/auth/me", { cookie: "jwt=garbage.token.here" })).status === 401);
	r = await http(BASE, "/api/auth/me", { cookie: a.cookie });
	check("/me with a valid cookie -> 200, right user", r.status === 200 && r.data._id === a.id);
	r = await http(BASE, "/api/users", { cookie: a.cookie });
	check("/users excludes self and never exposes passwords", r.status === 200 && !r.data.some((u) => u._id === a.id) && r.data.every((u) => !("password" in u)));
	r = await http(BASE, "/api/nope");
	check("unknown /api route -> JSON 404", r.status === 404 && r.data?.error, r.status);

	// ---- sending rules
	const send = (toId, message, cookie = a.cookie) => http(BASE, `/api/messages/send/${toId}`, { body: { message }, cookie });
	check("send to self -> 400", (await send(a.id, "hi me")).status === 400);
	check("send to invalid id -> 400", (await send("notanid", "hi")).status === 400);
	check("send to nonexistent user -> 404", (await send("507f1f77bcf86cd799439011", "hi")).status === 404);
	check("whitespace-only message -> 400", (await send(b.id, "   ")).status === 400);
	check("2001-character message -> 400", (await send(b.id, "x".repeat(2001))).status === 400);
	check("send without login -> 401", (await http(BASE, `/api/messages/send/${b.id}`, { body: { message: "hi" } })).status === 401);

	// ---- socket authentication
	const reject = async (cookie, label) => {
		try {
			(await connectSocket(BASE, cookie)).close();
			check(label, false, "connected");
		} catch (err) {
			check(label, /unauthorized/i.test(err.message), err.message);
		}
	};
	await reject("", "socket without a cookie is rejected");
	await reject("jwt=forged", "socket with a forged token is rejected");

	// ---- real time
	const sA = await connectSocket(BASE, a.cookie);
	const sB = await connectSocket(BASE, b.cookie);
	sockets.push(sA, sB);
	let onlineSeenByA = [];
	sA.on("getOnlineUsers", (u) => (onlineSeenByA = u));
	const gotA = [], gotB = [], gotImpostor = [];
	sA.on("newMessage", (m) => gotA.push(m));
	sB.on("newMessage", (m) => gotB.push(m));
	// attacker holds A's valid cookie but CLAIMS to be B in the query string (the old vulnerability)
	const impostor = await connectSocket(`${BASE}?userId=${b.id}`, a.cookie);
	sockets.push(impostor);
	impostor.on("newMessage", (m) => gotImpostor.push(m));
	await sleep(400);

	check("A and B connect with valid cookies and see each other online", sA.connected && sB.connected && onlineSeenByA.includes(b.id));
	r = await send(b.id, "hello B");
	await sleep(500);
	check("A -> B delivered live", r.status === 201 && gotB.length === 1 && gotB[0].senderId === a.id, `${r.status} ${gotB.length}`);
	check("a client claiming B's id (but authenticated as A) does NOT receive B's messages", gotImpostor.length === 0, gotImpostor.length);
	check("sender doesn't receive their own message", gotA.length === 0);
	await send(a.id, "reply from B", b.cookie);
	await sleep(400);
	check("B -> A delivered live", gotA.length === 1 && gotA[0].message === "reply from B");

	// ---- multi tab presence
	const sB2 = await connectSocket(BASE, b.cookie);
	sockets.push(sB2);
	const gotB2 = [];
	sB2.on("newMessage", (m) => gotB2.push(m));
	await sleep(300);
	await send(b.id, "to both tabs");
	await sleep(500);
	check("message reaches both of B's tabs", gotB.length === 2 && gotB2.length === 1, `${gotB.length}/${gotB2.length}`);
	sB.close();
	await sleep(500);
	check("B still online after closing ONE tab", onlineSeenByA.includes(b.id));
	sB2.close();
	await sleep(500);
	check("B offline after closing the LAST tab", !onlineSeenByA.includes(b.id));

	// ---- history + logout
	await sleep(500);
	r = await http(BASE, `/api/messages/${b.id}`, { cookie: a.cookie });
	check("history is complete and ordered", r.status === 200 && r.data.messages.map((m) => m.message).join("|") === "hello B|reply from B|to both tabs", JSON.stringify(r.data?.messages?.map((m) => m.message)));
	r = await http(BASE, `/api/messages/${a.id}`, { cookie: b.cookie });
	check("history is the same from B's side", r.data?.messages?.length === 3);
	check("history without login -> 401", (await http(BASE, `/api/messages/${b.id}`)).status === 401);
	r = await http(BASE, "/api/auth/logout", { method: "POST", cookie: a.cookie });
	check("logout clears the cookie", r.status === 200 && /jwt=;/.test(r.setCookie || ""), r.setCookie);
} catch (err) {
	suite.fail(err);
}
sockets.forEach((s) => s.close());
await suite.finish(() => world.cleanup());
