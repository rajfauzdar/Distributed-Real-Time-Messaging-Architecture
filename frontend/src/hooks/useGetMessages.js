import { useCallback, useEffect, useState } from "react";
import useConversation from "../zustand/useConversation";
import toast from "react-hot-toast";
import { apiFetch } from "../utils/api";
import { isTabVisible, markRead } from "../utils/readState";

const PAGE_SIZE = 30;

const useGetMessages = () => {
	const [loading, setLoading] = useState(false);
	const { messages, hasMore, loadingOlder, setHistory, selectedConversation } = useConversation();
	const selectedId = selectedConversation?._id;

	useEffect(() => {
		if (!selectedId) return;

		// abort the request when the user switches chats so a slow old response can't overwrite the new chat
		const controller = new AbortController();
		const getMessages = async () => {
			setLoading(true);
			try {
				const data = await apiFetch(`/api/messages/${selectedId}?limit=${PAGE_SIZE}`, { signal: controller.signal });
				setHistory(data.messages, data.hasMore);

				// the user is looking at this chat now: move the read cursor to its newest message
				const newest = data.messages[data.messages.length - 1];
				if (newest && isTabVisible()) markRead(selectedId, newest.createdAt);
			} catch (error) {
				if (error.name !== "AbortError") toast.error(error.message);
			} finally {
				if (!controller.signal.aborted) setLoading(false);
			}
		};

		getMessages();
		return () => controller.abort();
	}, [selectedId, setHistory]);

	// load the page before the oldest message we have
	const loadOlder = useCallback(async () => {
		const { selectedConversation, messages, hasMore, loadingOlder, setLoadingOlder, prependMessages } =
			useConversation.getState();
		if (!selectedConversation || !hasMore || loadingOlder || messages.length === 0) return false;

		const id = selectedConversation._id;
		const oldest = messages[0];
		const stillOpen = () => useConversation.getState().selectedConversation?._id === id;

		setLoadingOlder(true);
		try {
			const query = `limit=${PAGE_SIZE}&before=${encodeURIComponent(oldest.createdAt)}&beforeId=${oldest._id}`;
			const data = await apiFetch(`/api/messages/${id}?${query}`);
			if (!stillOpen()) return false; // user moved on while the page was loading
			prependMessages(data.messages, data.hasMore);
			return true;
		} catch (error) {
			toast.error(error.message);
			return false;
		} finally {
			if (stillOpen()) setLoadingOlder(false);
		}
	}, []);

	return { messages, loading, hasMore, loadingOlder, loadOlder };
};
export default useGetMessages;
