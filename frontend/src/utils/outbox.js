// Client-side send queue (the "outbox").
//
// sendMessage() returns instantly: the message is shown right away with a "sending" state while this
// module delivers it in the background:
//   - one in-flight request per receiver, oldest first, so a conversation's order is preserved
//   - network errors / 5xx / 429 are retried with exponential backoff + jitter
//   - other 4xx errors (validation) fail immediately and can be retried manually
//   - every message carries a clientId that the server treats as an idempotency key, so a retry after a
//     lost response can never create a duplicate
import { apiFetch } from "./api.js";
import useConversation from "../zustand/useConversation.js";

export const outboxConfig = {
	maxAttempts: 5,
	baseDelayMs: 1000,
	maxDelayMs: 15000,
};

const inFlight = new Set(); // receiverIds with a request currently running
let wakeTimer = null;

const newClientId = () =>
	globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

const backoff = (attempts) => {
	const exp = Math.min(outboxConfig.baseDelayMs * 2 ** (attempts - 1), outboxConfig.maxDelayMs);
	return exp / 2 + Math.random() * (exp / 2); // jitter so many clients don't retry in lockstep
};

const store = () => useConversation.getState();

export const enqueueMessage = (senderId, receiverId, text) => {
	const clientId = newClientId();
	store().addOutboxItem({
		clientId,
		senderId,
		receiverId,
		message: text,
		createdAt: new Date().toISOString(),
		status: "sending",
		attempts: 0,
		nextAttemptAt: 0,
	});
	pumpOutbox();
	return clientId;
};

export const retryMessage = (clientId) => {
	store().updateOutboxItem(clientId, {
		status: "sending",
		attempts: 0,
		nextAttemptAt: 0,
		error: undefined,
		failedReason: undefined,
	});
	pumpOutbox();
};

export const discardMessage = (clientId) => store().removeOutboxItem(clientId);

// Start sending whatever is due. Safe to call at any time.
export function pumpOutbox() {
	clearTimeout(wakeTimer);
	const now = Date.now();
	let nextWake = Infinity;
	const seenReceivers = new Set();

	for (const item of store().outbox) {
		if (item.status !== "sending") continue; // failed messages don't block the ones after them
		if (seenReceivers.has(item.receiverId)) continue; // only the oldest pending item per receiver goes out
		seenReceivers.add(item.receiverId);
		if (inFlight.has(item.receiverId)) continue;

		if (item.nextAttemptAt > now) {
			nextWake = Math.min(nextWake, item.nextAttemptAt);
			continue;
		}
		deliver(item);
	}

	if (nextWake !== Infinity) wakeTimer = setTimeout(pumpOutbox, Math.max(0, nextWake - now));
}

async function deliver(item) {
	inFlight.add(item.receiverId);
	try {
		const saved = await apiFetch(`/api/messages/send/${item.receiverId}`, {
			body: { message: item.message, clientId: item.clientId },
		});
		store().confirmOutbox(item.clientId, saved);
	} catch (error) {
		const attempts = item.attempts + 1;
		const isNetworkError = error.status === undefined;
		const retryable = isNetworkError || error.status >= 500 || error.status === 429;

		if (retryable && attempts < outboxConfig.maxAttempts) {
			store().updateOutboxItem(item.clientId, { attempts, nextAttemptAt: Date.now() + backoff(attempts) });
		} else {
			store().updateOutboxItem(item.clientId, {
				status: "failed",
				attempts,
				error: error.message,
				failedReason: retryable ? "network" : "rejected",
			});
		}
	} finally {
		inFlight.delete(item.receiverId);
		pumpOutbox();
	}
}

// Called when the browser regains connectivity: give messages that failed because of the network another go.
export const retryNetworkFailures = () => {
	for (const item of store().outbox) {
		if (item.status === "failed" && item.failedReason === "network") retryMessage(item.clientId);
	}
	pumpOutbox();
};

// Logout / expired session: forget everything queued by the previous user.
export const resetOutbox = () => {
	clearTimeout(wakeTimer);
	inFlight.clear();
	store().reset();
};

if (typeof window !== "undefined") {
	window.addEventListener("online", retryNetworkFailures);
}
