import { useState } from "react";
import useConversation from "../zustand/useConversation";
import toast from "react-hot-toast";
import { apiFetch } from "../utils/api";

const useSendMessage = () => {
	const [loading, setLoading] = useState(false);
	const { selectedConversation } = useConversation();

	// resolves to true when the message was sent
	const sendMessage = async (message) => {
		const receiverId = selectedConversation._id;
		setLoading(true);
		try {
			const data = await apiFetch(`/api/messages/send/${receiverId}`, { body: { message } });

			// only show it if the user is still looking at the same chat
			const current = useConversation.getState();
			if (current.selectedConversation?._id === receiverId) current.addMessage(data);
			return true;
		} catch (error) {
			toast.error(error.message);
			return false;
		} finally {
			setLoading(false);
		}
	};

	return { sendMessage, loading };
};
export default useSendMessage;
