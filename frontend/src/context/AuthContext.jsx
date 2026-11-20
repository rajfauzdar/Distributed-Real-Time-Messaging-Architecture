import { createContext, useContext, useEffect, useState } from "react";
import { AUTH_EXPIRED_EVENT, apiFetch } from "../utils/api";

export const AuthContext = createContext();

// eslint-disable-next-line react-refresh/only-export-components
export const useAuthContext = () => {
	return useContext(AuthContext);
};

const readStoredUser = () => {
	try {
		return JSON.parse(localStorage.getItem("chat-user")) || null;
	} catch {
		localStorage.removeItem("chat-user");
		return null;
	}
};

export const AuthContextProvider = ({ children }) => {
	const [authUser, setAuthUserState] = useState(readStoredUser);

	const setAuthUser = (user) => {
		if (user) localStorage.setItem("chat-user", JSON.stringify(user));
		else localStorage.removeItem("chat-user");
		setAuthUserState(user);
	};

	// the stored user is only a cache - confirm the cookie session is still valid on load
	useEffect(() => {
		if (!readStoredUser()) return;
		apiFetch("/api/auth/me", { skipAuthExpiry: true })
			.then((user) => setAuthUser(user))
			.catch((error) => {
				// only a rejected session logs out; a flaky network must not
				if (/unauthorized/i.test(error.message)) setAuthUser(null);
			});
	}, []);

	// any API call that comes back 401 logs the user out
	useEffect(() => {
		const onExpired = () => setAuthUser(null);
		window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
		return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
	}, []);

	return <AuthContext.Provider value={{ authUser, setAuthUser }}>{children}</AuthContext.Provider>;
};
