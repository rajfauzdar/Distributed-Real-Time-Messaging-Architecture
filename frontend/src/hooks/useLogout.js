import { useState } from "react";
import { useAuthContext } from "../context/AuthContext";
import toast from "react-hot-toast";
import { apiFetch } from "../utils/api";
import useConversation from "../zustand/useConversation";

const useLogout = () => {
	const [loading, setLoading] = useState(false);
	const { setAuthUser } = useAuthContext();

	const logout = async () => {
		setLoading(true);
		try {
			await apiFetch("/api/auth/logout", { method: "POST", skipAuthExpiry: true });

			// don't leak the previous user's chats/unread counts into the next session
			useConversation.setState({ selectedConversation: null, messages: [], conversations: [], unreadCounts: {} });
			setAuthUser(null);
		} catch (error) {
			toast.error(error.message);
		} finally {
			setLoading(false);
		}
	};

	return { loading, logout };
};
export default useLogout;
