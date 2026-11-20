// Server-side read cursors: "I have read this chat up to <time>". Unread counts are computed by the server
// from those cursors, so they survive refreshes and show up on every device.
import { apiFetch } from "./api.js";
import useConversation from "../zustand/useConversation.js";

export const isTabVisible = () => typeof document === "undefined" || document.visibilityState === "visible";

// Load the real unread counts (on start-up and after every socket reconnect, so nothing is missed while offline).
export const fetchUnread = async () => {
	try {
		const counts = await apiFetch("/api/messages/unread");
		useConversation.getState().setUnreadCounts(counts);
	} catch {
		// non-critical: live socket events keep the badges roughly right until the next refresh
	}
};

// Debounced: a burst of incoming messages in an open chat becomes a single request carrying the newest time.
const pending = new Map(); // peerId -> { upTo (ms), iso, timer }
export const markRead = (peerId, upToIso) => {
	const upTo = Date.parse(upToIso);
	if (!peerId || Number.isNaN(upTo)) return;

	const entry = pending.get(peerId);
	if (entry) {
		if (upTo > entry.upTo) Object.assign(entry, { upTo, iso: upToIso });
		return;
	}

	const created = { upTo, iso: upToIso, timer: null };
	created.timer = setTimeout(async () => {
		pending.delete(peerId);
		try {
			await apiFetch(`/api/messages/read/${peerId}`, { body: { upTo: created.iso } });
		} catch {
			// the cursor is re-sent with the next message / next time the chat is opened
		}
	}, 400);
	pending.set(peerId, created);
};

export const markOpenChatRead = () => {
	const { selectedConversation, messages, clearUnread } = useConversation.getState();
	if (!selectedConversation) return;
	clearUnread(selectedConversation._id);
	const newest = messages[messages.length - 1];
	if (newest) markRead(selectedConversation._id, newest.createdAt);
};
