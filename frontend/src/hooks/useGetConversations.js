import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import useConversation from "../zustand/useConversation";
import { apiFetch } from "../utils/api";

// Fetches the user list once (call this from a single component) and stores it in zustand
// so every consumer shares the same data.
const useGetConversations = () => {
	const [loading, setLoading] = useState(false);
	const { conversations, setConversations } = useConversation();

	useEffect(() => {
		const controller = new AbortController();
		const getConversations = async () => {
			setLoading(true);
			try {
				setConversations(await apiFetch("/api/users", { signal: controller.signal }));
			} catch (error) {
				if (error.name !== "AbortError") toast.error(error.message);
			} finally {
				if (!controller.signal.aborted) setLoading(false);
			}
		};

		getConversations();
		return () => controller.abort();
	}, [setConversations]);

	return { loading, conversations };
};
export default useGetConversations;
