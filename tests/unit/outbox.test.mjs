// Client-side send queue (frontend/src/utils/outbox.js) against a scriptable mock server.   node tests/unit/outbox.test.mjs
import { pathToFileURL } from "url";
import path from "path";
import { ROOT, createSuite, sleep, waitFor } from "../lib.mjs";

const src = (p) => pathToFileURL(path.join(ROOT, "frontend", "src", p)).href;
const { default: useConversation } = await import(src("zustand/useConversation.js"));
const { enqueueMessage, retryMessage, discardMessage, retryNetworkFailures, resetOutbox, outboxConfig } = await import(src("utils/outbox.js"));

outboxConfig.baseDelayMs = 5;
outboxConfig.maxDelayMs = 20;

const suite = createSuite("Outbox queue (unit)");
const check = suite.check;
const S = () => useConversation.getState();
const waitUntil = (cond) => waitFor(cond, 3000, 5);

// ---- mock server: stores messages by clientId (idempotent like the real one), behaviour is scriptable ----
let db, calls, plan, active, maxActivePerReceiver;
const resetServer = () => { db = new Map(); calls = []; plan = []; active = new Map(); maxActivePerReceiver = 0; };
let nextId = 1;
globalThis.fetch = async (url, opts) => {
	const body = JSON.parse(opts.body);
	const receiver = url.split("/").pop();
	calls.push({ receiver, clientId: body.clientId, message: body.message });
	active.set(receiver, (active.get(receiver) || 0) + 1);
	maxActivePerReceiver = Math.max(maxActivePerReceiver, active.get(receiver));
	await sleep(3);
	active.set(receiver, active.get(receiver) - 1);

	const behaviour = plan.shift() || "ok";
	const respond = (status, data) => ({ ok: status < 400, status, json: async () => data, headers: { getSetCookie: () => [] } });
	if (behaviour === "network") throw new TypeError("Failed to fetch");
	if (behaviour === "500") return respond(500, { error: "Internal server error" });
	if (behaviour === "400") return respond(400, { error: "Message can't be empty" });
	// "ok" and "lost-response" both store the message; lost-response then fails on the way back
	let doc = db.get(body.clientId);
	const isNew = !doc;
	if (!doc) { doc = { _id: "srv" + nextId++, clientId: body.clientId, senderId: "me", receiverId: receiver, message: body.message, createdAt: new Date().toISOString() }; db.set(body.clientId, doc); }
	if (behaviour === "lost-response") throw new TypeError("network dropped the response");
	return respond(isNew ? 201 : 200, doc);
};

const fresh = (selectedId = "bob") => { resetOutbox(); resetServer(); useConversation.setState({ selectedConversation: { _id: selectedId } }); };
const idle = () => waitFor(() => S().outbox.every((o) => o.status === "failed") );

// 1. optimistic display + confirmation
fresh();
enqueueMessage("me", "bob", "hello");
check("message is visible in the outbox immediately (before any server reply)", S().outbox.length === 1 && S().outbox[0].status === "sending");
await waitUntil(() => S().outbox.length === 0);
check("after server reply: removed from outbox and added once to messages", S().outbox.length === 0 && S().messages.length === 1 && S().messages[0]._id === "srv1");
check("saved message keeps the clientId (UI can match it to the optimistic bubble)", S().messages[0].clientId === calls[0].clientId);

// 2. order preserved + retries + never >1 in flight per receiver
fresh();
plan = ["network", "500"]; // first message fails twice, then ok
enqueueMessage("me", "bob", "m1"); enqueueMessage("me", "bob", "m2"); enqueueMessage("me", "bob", "m3");
await waitUntil(() => S().outbox.length === 0);
const stored = [...db.values()].map((d) => d.message);
check("retries on network error and 500, then delivers", S().outbox.length === 0 && stored.length === 3, JSON.stringify(stored));
check("order is preserved even though the first message needed retries", stored.join(",") === "m1,m2,m3", stored.join(","));
check("never more than one request in flight per receiver", maxActivePerReceiver === 1, maxActivePerReceiver);
const m1Calls = calls.filter((c) => c.message === "m1");
check("every retry reuses the same clientId (idempotency key)", m1Calls.length === 3 && new Set(m1Calls.map((c) => c.clientId)).size === 1, m1Calls.length);

// 3. different receivers are independent
fresh();
plan = ["network", "network", "network"];
enqueueMessage("me", "bob", "to-bob"); enqueueMessage("me", "carol", "to-carol");
await waitUntil(() => db.size === 2);
check("a slow/failing chat doesn't block another chat", db.size === 2 && S().outbox.length === 0);

// 4. validation rejection: no retry, doesn't block later messages, manual retry works
fresh();
plan = ["400"];
enqueueMessage("me", "bob", "bad"); enqueueMessage("me", "bob", "good");
await waitUntil(() => db.size === 1 && S().outbox.length === 1);
let failed = S().outbox[0];
check("4xx marks the message failed immediately (1 attempt, reason=rejected)", failed.status === "failed" && failed.failedReason === "rejected" && calls.filter((c) => c.message === "bad").length === 1, JSON.stringify(failed));
check("a failed message does not block the next one", [...db.values()][0].message === "good");
retryMessage(failed.clientId);
await waitUntil(() => S().outbox.length === 0);
check("manual Retry sends it successfully", db.size === 2 && S().outbox.length === 0);

// 5. gives up after max attempts; reconnect retries network failures
fresh();
plan = Array(5).fill("500");
enqueueMessage("me", "bob", "flaky");
await waitUntil(() => S().outbox[0]?.status === "failed");
failed = S().outbox[0];
check(`gives up after ${outboxConfig.maxAttempts} attempts (reason=network)`, failed.status === "failed" && failed.failedReason === "network" && calls.length === 5, `${calls.length} ${failed.status}`);
retryNetworkFailures(); // what the browser 'online' event triggers
await waitUntil(() => S().outbox.length === 0);
check("'back online' retries network-failed messages automatically", db.size === 1 && S().outbox.length === 0);

// 6. lost response: server stored it, client never heard -> retry must NOT duplicate
fresh();
plan = ["lost-response"];
enqueueMessage("me", "bob", "once only");
await waitUntil(() => S().outbox.length === 0);
check("lost response + retry results in exactly ONE stored message", db.size === 1 && calls.length === 2, `db=${db.size} calls=${calls.length}`);
check("and exactly one message shown in the chat", S().messages.length === 1);

// 7. other chat open: confirmed message isn't injected into the wrong chat
fresh("carol");
enqueueMessage("me", "bob", "for bob");
await waitUntil(() => S().outbox.length === 0);
check("confirmation for a closed chat does not appear in the open chat", S().messages.length === 0);

// 8. discard + logout safety
fresh();
plan = ["400"];
enqueueMessage("me", "bob", "x");
await waitUntil(() => S().outbox[0]?.status === "failed");
discardMessage(S().outbox[0].clientId);
check("Delete removes a failed message", S().outbox.length === 0);
fresh();
plan = ["network", "network", "network"];
enqueueMessage("me", "bob", "pending at logout");
resetOutbox();
await sleep(100);
check("logout clears pending messages and nothing leaks afterwards", S().outbox.length === 0 && S().messages.length === 0 && db.size <= 1);

await suite.finish();
