import { useEffect, useState } from "react";
import useConversation from "../zustand/useConversation";
import toast from "react-hot-toast";
import { apiFetch } from "../utils/api";

const useGetMessages = () => {
	const [loading, setLoading] = useState(false);
	const { messages, setMessages, selectedConversation } = useConversation();
	const selectedId = selectedConversation?._id;

	useEffect(() => {
		if (!selectedId) return;

		// abort the request when the user switches chats so a slow old response can't overwrite the new chat
		const controller = new AbortController();
		const getMessages = async () => {
			setLoading(true);
			try {
				const data = await apiFetch(`/api/messages/${selectedId}`, { signal: controller.signal });
				setMessages(data);
			} catch (error) {
				if (error.name !== "AbortError") toast.error(error.message);
			} finally {
				if (!controller.signal.aborted) setLoading(false);
			}
		};

		getMessages();
		return () => controller.abort();
	}, [selectedId, setMessages]);

	return { messages, loading };
};
export default useGetMessages;
