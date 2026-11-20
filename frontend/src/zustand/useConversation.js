import { create } from "zustand";

const initialState = {
	selectedConversation: null,
	messages: [], // server-confirmed messages of the open chat
	unreadCounts: {}, // { userId: number }
	typingFrom: {}, // { userId: true } - who is currently typing to me
	conversations: [],
	// Messages the user has sent that the server hasn't confirmed yet (optimistic UI + retry queue).
	// [{ clientId, senderId, receiverId, message, createdAt, status: "sending"|"failed", attempts, nextAttemptAt, error, failedReason }]
	outbox: [],
};

const useConversation = create((set) => ({
	...initialState,

	// opening a chat clears its unread badge and the previous chat's messages
	setSelectedConversation: (selectedConversation) =>
		set((state) => {
			if (state.selectedConversation?._id === selectedConversation?._id) return {};
			const unreadCounts = { ...state.unreadCounts };
			if (selectedConversation) delete unreadCounts[selectedConversation._id];
			return { selectedConversation, messages: [], unreadCounts };
		}),

	setMessages: (messages) => set({ messages }),
	// functional append - never depends on a stale `messages` closure
	addMessage: (message) =>
		set((state) =>
			state.messages.some((m) => m._id === message._id) ? {} : { messages: [...state.messages, message] }
		),

	incrementUnread: (userId) =>
		set((state) => ({ unreadCounts: { ...state.unreadCounts, [userId]: (state.unreadCounts[userId] || 0) + 1 } })),

	setTyping: (userId, isTyping) =>
		set((state) => {
			if (!!state.typingFrom[userId] === isTyping) return {};
			const typingFrom = { ...state.typingFrom };
			if (isTyping) typingFrom[userId] = true;
			else delete typingFrom[userId];
			return { typingFrom };
		}),

	setConversations: (conversations) => set({ conversations }),

	// ----- outbox -----
	addOutboxItem: (item) => set((state) => ({ outbox: [...state.outbox, item] })),
	updateOutboxItem: (clientId, patch) =>
		set((state) => ({ outbox: state.outbox.map((o) => (o.clientId === clientId ? { ...o, ...patch } : o)) })),
	removeOutboxItem: (clientId) => set((state) => ({ outbox: state.outbox.filter((o) => o.clientId !== clientId) })),
	// server accepted the message: drop it from the outbox and (if that chat is open) show the real message, atomically
	confirmOutbox: (clientId, serverMessage) =>
		set((state) => {
			const item = state.outbox.find((o) => o.clientId === clientId);
			if (!item) return {}; // already discarded, or the user logged out meanwhile
			const outbox = state.outbox.filter((o) => o.clientId !== clientId);
			const isOpen = state.selectedConversation?._id === item.receiverId;
			const alreadyThere = state.messages.some((m) => m._id === serverMessage._id);
			return isOpen && !alreadyThere ? { outbox, messages: [...state.messages, serverMessage] } : { outbox };
		}),

	// wipe everything tied to the signed-in user (logout / expired session)
	reset: () => set({ ...initialState }),
}));

export default useConversation;
