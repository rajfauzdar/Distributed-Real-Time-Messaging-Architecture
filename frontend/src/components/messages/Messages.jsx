import { useEffect, useRef } from "react";
import useGetMessages from "../../hooks/useGetMessages";
import MessageSkeleton from "../skeletons/MessageSkeleton";
import Message from "./Message";

const Messages = () => {
	const { messages, loading } = useGetMessages();
	const bottomRef = useRef();

	useEffect(() => {
		const timer = setTimeout(() => {
			bottomRef.current?.scrollIntoView({ behavior: "smooth" });
		}, 100);
		return () => clearTimeout(timer);
	}, [messages]);

	return (
		<div className='px-4 flex-1 overflow-auto'>
			{!loading && messages.map((message) => <Message key={message._id} message={message} />)}

			{loading && [...Array(3)].map((_, idx) => <MessageSkeleton key={idx} />)}
			{!loading && messages.length === 0 && <p className='text-center'>Send a message to start the conversation</p>}
			<div ref={bottomRef} />
		</div>
	);
};
export default Messages;
