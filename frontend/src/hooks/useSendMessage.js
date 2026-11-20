import useConversation from "../zustand/useConversation";
import { useAuthContext } from "../context/AuthContext";
import { enqueueMessage } from "../utils/outbox";

// Optimistic send: the message appears immediately and is delivered by the outbox queue in the background.
const useSendMessage = () => {
	const { authUser } = useAuthContext();
	const { selectedConversation } = useConversation();

	const sendMessage = (message) => {
		if (!selectedConversation) return false;
		enqueueMessage(authUser._id, selectedConversation._id, message.trim());
		return true;
	};

	return { sendMessage };
};
export default useSendMessage;
