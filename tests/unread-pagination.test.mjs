// Cursor pagination + persistent unread counts.   BASE_URL=... node tests/unread-pagination.test.mjs
import { BASE_URL as BASE, TestWorld, connectDb, createSuite, http, mongoose, sleep, waitFor } from "./lib.mjs";

const suite = createSuite(`Pagination & unread counts (${BASE})`);
const { check } = suite;
const world = new TestWorld();

try {
	const a = await world.signup(BASE, "a");
	const b = await world.signup(BASE, "b");
	const c = await world.signup(BASE, "c");
	let n = 0;
	const sendTo = (from, to, text) =>
		http(BASE, `/api/messages/send/${to.id}`, { body: { message: text, clientId: `ur-${world.tag}-${++n}-${Math.random().toString(36).slice(2, 8)}` }, cookie: from.cookie });
	const getPage = (viewer, peer, query = "") => http(BASE, `/api/messages/${peer.id}${query}`, { cookie: viewer.cookie });
	const unread = async (who) => (await http(BASE, "/api/messages/unread", { cookie: who.cookie })).data;

	// 75 messages A -> B, sequential so createdAt order is well defined
	const N = 75;
	for (let i = 1; i <= N; i++) await sendTo(a, b, `m${String(i).padStart(3, "0")}`);
	check(`all ${N} messages persisted`, (await waitFor(async () => (await getPage(b, a, "?limit=100")).data.messages.length === N, 30000)) >= 0);

	// ---- pagination
	let r = await getPage(b, a);
	check("default page = the 30 newest, oldest->newest, hasMore=true", r.data.messages.length === 30 && r.data.hasMore && r.data.messages[0].message === "m046" && r.data.messages[29].message === "m075", `${r.data.messages[0]?.message}..${r.data.messages.at(-1)?.message}`);
	const pages = [r.data.messages];
	let cursor = r.data.messages[0];
	let hasMore = r.data.hasMore;
	while (hasMore) {
		const p = await getPage(b, a, `?limit=30&before=${encodeURIComponent(cursor.createdAt)}&beforeId=${cursor._id}`);
		pages.unshift(p.data.messages);
		cursor = p.data.messages[0];
		hasMore = p.data.hasMore;
	}
	const all = pages.flat().map((m) => m.message);
	check("paging back yields all 75 messages exactly once, in order", all.length === N && all.every((m, i) => m === `m${String(i + 1).padStart(3, "0")}`), `${all.length}`);
	check("3 pages (30+30+15); the last reports hasMore=false", pages.length === 3 && pages[0].length === 15 && !hasMore, pages.map((p) => p.length).join("+"));
	r = await getPage(b, a, "?limit=abc");
	check("non-numeric limit falls back to the default (30)", r.status === 200 && r.data.messages.length === 30);
	check("invalid 'before' cursor -> 400", (await getPage(b, a, "?before=not-a-date")).status === 400);
	check("invalid 'beforeId' cursor -> 400", (await getPage(b, a, `?before=${new Date().toISOString()}&beforeId=xyz`)).status === 400);
	r = await getPage(b, a, "?before=2020-01-01T00:00:00Z");
	check("cursor older than every message -> empty page, hasMore=false", r.data.messages.length === 0 && r.data.hasMore === false);
	r = await getPage(b, c);
	check("chat with no messages -> empty page", r.data.messages.length === 0 && r.data.hasMore === false);

	// the page-size cap needs >100 messages: insert them directly instead of sending 120 requests
	const db = await connectDb();
	const base = Date.now() - 3_600_000;
	await db.collection("messages").insertMany(
		Array.from({ length: 120 }, (_, i) => ({ senderId: new mongoose.Types.ObjectId(c.id), receiverId: new mongoose.Types.ObjectId(a.id), message: `bulk ${i}`, createdAt: new Date(base + i * 1000), updatedAt: new Date(base + i * 1000) }))
	);
	r = await getPage(a, c, "?limit=5000");
	check("page size is capped at 100 (120 messages exist, limit=5000)", r.data.messages.length === 100 && r.data.hasMore === true, `${r.data.messages.length}`);
	r = await getPage(a, c, "?limit=1");
	check("limit=1 returns exactly one message", r.data.messages.length === 1 && r.data.messages[0].message === "bulk 119");
	await db.collection("messages").deleteMany({ senderId: new mongoose.Types.ObjectId(c.id), receiverId: new mongoose.Types.ObjectId(a.id) });

	// ---- unread counts
	check("B has 75 unread from A (and nothing else)", (await unread(b))[a.id] === N && Object.keys(await unread(b)).length === 1);
	check("A (the sender) has no unread", Object.keys(await unread(a)).length === 0);

	const full = (await getPage(b, a, "?limit=100")).data.messages;
	const markRead = (who, peer, upTo) => http(BASE, `/api/messages/read/${peer.id}`, { body: { upTo }, cookie: who.cookie });
	check("mark read up to message #70 -> 204", (await markRead(b, a, full[69].createdAt)).status === 204);
	check("unread drops to 5", (await unread(b))[a.id] === 5);
	await markRead(b, a, full[10].createdAt);
	check("an older 'read' can't move the cursor backwards (still 5)", (await unread(b))[a.id] === 5);
	await markRead(b, a, full.at(-1).createdAt);
	check("read everything -> no unread entry for A", (await unread(b))[a.id] === undefined);

	await sleep(50);
	await sendTo(a, b, "new one");
	await sendTo(c, b, "from c 1");
	await sendTo(c, b, "from c 2");
	await waitFor(async () => { const u = await unread(b); return u[a.id] === 1 && u[c.id] === 2; });
	const u = await unread(b);
	check("new messages are counted per sender: {A:1, C:2}", u[a.id] === 1 && u[c.id] === 2, JSON.stringify(u));

	await markRead(b, c, "2100-01-01T00:00:00Z");
	check("marking C read (future timestamp) clears C", (await unread(b))[c.id] === undefined);
	await sleep(50);
	await sendTo(c, b, "after far-future read");
	await waitFor(async () => (await unread(b))[c.id] === 1);
	check("...but the future timestamp was clamped to 'now': a later message is unread again", (await unread(b))[c.id] === 1);

	// ---- validation / auth
	check("read: invalid id -> 400", (await markRead(b, { id: "xyz" }, new Date().toISOString())).status === 400);
	check("read: bad or missing date -> 400", (await markRead(b, a, "nope")).status === 400 && (await http(BASE, `/api/messages/read/${a.id}`, { body: {}, cookie: b.cookie })).status === 400);
	check("read: unknown user -> 404", (await markRead(b, { id: "507f1f77bcf86cd799439011" }, new Date().toISOString())).status === 404);
	check("unread/read without login -> 401", (await http(BASE, "/api/messages/unread")).status === 401 && (await http(BASE, `/api/messages/read/${a.id}`, { body: { upTo: new Date().toISOString() } })).status === 401);
} catch (err) {
	suite.fail(err);
}
await suite.finish(() => world.cleanup());
