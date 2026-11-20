import { useEffect } from "react";

import { useSocketContext } from "../context/SocketContext";
import useConversation from "../zustand/useConversation";

import notificationSound from "../assets/sounds/notification.mp3";

// Mounted once on the home page so messages are received even when no chat is open.
const useListenMessages = () => {
	const { socket } = useSocketContext();

	useEffect(() => {
		if (!socket) return;

		const handleNewMessage = (newMessage) => {
			const { selectedConversation, addMessage, incrementUnread } = useConversation.getState();

			if (selectedConversation?._id === newMessage.senderId) {
				addMessage({ ...newMessage, shouldShake: true });
			} else {
				// belongs to a chat that isn't open: show an unread badge instead of polluting the open thread
				incrementUnread(newMessage.senderId);
			}

			// browsers may block autoplay before the first user interaction - ignore that
			new Audio(notificationSound).play().catch(() => {});
		};

		socket.on("newMessage", handleNewMessage);
		return () => socket.off("newMessage", handleNewMessage);
	}, [socket]);
};
export default useListenMessages;
