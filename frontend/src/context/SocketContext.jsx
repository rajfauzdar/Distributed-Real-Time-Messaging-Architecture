import { createContext, useState, useEffect, useContext } from "react";
import { useAuthContext } from "./AuthContext";
import io from "socket.io-client";

const SocketContext = createContext();

// eslint-disable-next-line react-refresh/only-export-components
export const useSocketContext = () => {
	return useContext(SocketContext);
};

export const SocketContextProvider = ({ children }) => {
	const [socket, setSocket] = useState(null);
	const [onlineUsers, setOnlineUsers] = useState([]);
	const userId = useAuthContext().authUser?._id;

	useEffect(() => {
		if (!userId) return;

		// same origin (proxied by Vite in dev); the server authenticates via the httpOnly jwt cookie
		// websocket-only: no HTTP long-polling fallback, so no sticky sessions are needed behind a load balancer
		const newSocket = io({ withCredentials: true, transports: ["websocket"] });

		setSocket(newSocket);
		newSocket.on("getOnlineUsers", setOnlineUsers);

		return () => {
			newSocket.close();
			setSocket(null);
			setOnlineUsers([]);
		};
	}, [userId]);

	return <SocketContext.Provider value={{ socket, onlineUsers }}>{children}</SocketContext.Provider>;
};
