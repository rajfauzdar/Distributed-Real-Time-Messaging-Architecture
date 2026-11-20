import { create } from "zustand";

const useConversation = create((set) => ({
	selectedConversation: null,
	// opening a chat clears its unread badge and the previous chat's messages
	setSelectedConversation: (selectedConversation) =>
		set((state) => {
			if (state.selectedConversation?._id === selectedConversation?._id) return {};
			const unreadCounts = { ...state.unreadCounts };
			if (selectedConversation) delete unreadCounts[selectedConversation._id];
			return { selectedConversation, messages: [], unreadCounts };
		}),

	messages: [],
	setMessages: (messages) => set({ messages }),
	// functional append - never depends on a stale `messages` closure
	addMessage: (message) =>
		set((state) =>
			state.messages.some((m) => m._id === message._id) ? {} : { messages: [...state.messages, message] }
		),

	unreadCounts: {}, // { userId: number }
	incrementUnread: (userId) =>
		set((state) => ({ unreadCounts: { ...state.unreadCounts, [userId]: (state.unreadCounts[userId] || 0) + 1 } })),

	conversations: [],
	setConversations: (conversations) => set({ conversations }),
}));

export default useConversation;
