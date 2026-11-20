import { useEffect } from "react";

import { useSocketContext } from "../context/SocketContext";
import useConversation from "../zustand/useConversation";
import { fetchUnread, isTabVisible, markOpenChatRead, markRead } from "../utils/readState";

import notificationSound from "../assets/sounds/notification.mp3";

const TYPING_TIMEOUT_MS = 3000; // if we stop hearing "typing", assume they stopped

// Mounted once on the home page so messages are received even when no chat is open.
const useListenMessages = () => {
	const { socket } = useSocketContext();

	useEffect(() => {
		if (!socket) return;

		const typingTimers = new Map(); // userId -> timeout id

		const clearTyping = (userId) => {
			clearTimeout(typingTimers.get(userId));
			typingTimers.delete(userId);
			useConversation.getState().setTyping(userId, false);
		};

		const handleNewMessage = (newMessage) => {
			const { selectedConversation, addMessage, incrementUnread } = useConversation.getState();

			clearTyping(newMessage.senderId); // a delivered message means they're no longer "typing"

			if (selectedConversation?._id === newMessage.senderId) {
				addMessage({ ...newMessage, shouldShake: true });
				// only counts as read if the user can actually see it; otherwise it stays unread until they come back
				if (isTabVisible()) markRead(newMessage.senderId, newMessage.createdAt);
				else incrementUnread(newMessage.senderId);
			} else {
				// belongs to a chat that isn't open: show an unread badge instead of polluting the open thread
				incrementUnread(newMessage.senderId);
			}

			// browsers may block autoplay before the first user interaction - ignore that
			new Audio(notificationSound).play().catch(() => {});
		};

		const handleTyping = ({ from }) => {
			useConversation.getState().setTyping(from, true);
			clearTimeout(typingTimers.get(from));
			typingTimers.set(from, setTimeout(() => clearTyping(from), TYPING_TIMEOUT_MS));
		};

		const handleStopTyping = ({ from }) => clearTyping(from);

		// real unread counts from the server: on first connect and again after every reconnect
		// (messages may have arrived while the socket was down)
		const handleConnect = () => fetchUnread();
		socket.on("connect", handleConnect);
		if (socket.connected) fetchUnread();

		// coming back to the tab: whatever is open has now been seen
		const handleVisibility = () => {
			if (isTabVisible()) markOpenChatRead();
		};
		document.addEventListener("visibilitychange", handleVisibility);

		socket.on("newMessage", handleNewMessage);
		socket.on("typing", handleTyping);
		socket.on("stopTyping", handleStopTyping);

		return () => {
			socket.off("connect", handleConnect);
			socket.off("newMessage", handleNewMessage);
			socket.off("typing", handleTyping);
			socket.off("stopTyping", handleStopTyping);
			document.removeEventListener("visibilitychange", handleVisibility);
			typingTimers.forEach(clearTimeout);
			useConversation.setState({ typingFrom: {} });
		};
	}, [socket]);
};
export default useListenMessages;
