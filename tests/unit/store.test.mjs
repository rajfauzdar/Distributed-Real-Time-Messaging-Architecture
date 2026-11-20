// Client store logic (pagination merge, unread counts, reset).   node tests/unit/store.test.mjs
import { pathToFileURL } from "url";
import path from "path";
import { ROOT, createSuite } from "../lib.mjs";

const { default: useConversation } = await import(pathToFileURL(path.join(ROOT, "frontend", "src", "zustand", "useConversation.js")).href);
const suite = createSuite("Client store (unit)");
const check = suite.check;
const S = () => useConversation.getState();
const msg = (id, t) => ({ _id: id, message: id, createdAt: t });

S().setSelectedConversation({ _id: "bob" });
S().setHistory([msg("m4", "4"), msg("m5", "5")], true);
check("history load sets messages and hasMore", S().messages.length === 2 && S().hasMore === true);
S().prependMessages([msg("m2", "2"), msg("m3", "3")], true);
check("older page is placed in front, order preserved", S().messages.map((m) => m._id).join() === "m2,m3,m4,m5");
S().prependMessages([msg("m1", "1"), msg("m2", "2")], false);
check("overlap with already-loaded messages is de-duplicated; hasMore updates", S().messages.map((m) => m._id).join() === "m1,m2,m3,m4,m5" && S().hasMore === false);
S().addMessage(msg("m6", "6")); S().addMessage(msg("m6", "6"));
check("live message appended once", S().messages.filter((m) => m._id === "m6").length === 1);

S().setUnreadCounts({ bob: 3, carol: 2 });
check("server unread counts never show a badge for the open chat", S().unreadCounts.bob === undefined && S().unreadCounts.carol === 2, JSON.stringify(S().unreadCounts));
S().incrementUnread("carol");
check("live increment on top of server counts", S().unreadCounts.carol === 3);
S().clearUnread("carol");
check("clearUnread removes the badge", S().unreadCounts.carol === undefined);

S().setSelectedConversation({ _id: "carol" });
check("switching chats clears messages, hasMore and loadingOlder", S().messages.length === 0 && S().hasMore === false && S().loadingOlder === false);
S().reset();
check("reset (logout) wipes everything", S().selectedConversation === null && Object.keys(S().unreadCounts).length === 0 && S().outbox.length === 0);
await suite.finish();
