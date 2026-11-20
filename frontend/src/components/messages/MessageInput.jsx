import { useEffect, useRef, useState } from "react";
import { BsSend } from "react-icons/bs";
import useSendMessage from "../../hooks/useSendMessage";
import { useSocketContext } from "../../context/SocketContext";
import useConversation from "../../zustand/useConversation";

const TYPING_EMIT_INTERVAL_MS = 2000; // send "typing" at most this often while the user keeps typing
const TYPING_IDLE_MS = 2000; // send "stopTyping" after this much silence

const MessageInput = () => {
	const [message, setMessage] = useState("");
	const { loading, sendMessage } = useSendMessage();
	const { socket } = useSocketContext();
	const receiverId = useConversation((s) => s.selectedConversation?._id);

	const lastEmitRef = useRef(0);
	const idleTimerRef = useRef(null);
	const isTypingRef = useRef(false);

	const stopTyping = () => {
		clearTimeout(idleTimerRef.current);
		if (isTypingRef.current && receiverId) socket?.emit("stopTyping", { to: receiverId });
		isTypingRef.current = false;
		lastEmitRef.current = 0;
	};

	// leaving the chat (or unmounting) while typing must not leave a stuck "typing…" on the other side
	useEffect(() => {
		return () => {
			clearTimeout(idleTimerRef.current);
			if (isTypingRef.current && receiverId) socket?.emit("stopTyping", { to: receiverId });
			isTypingRef.current = false;
			lastEmitRef.current = 0;
		};
	}, [receiverId, socket]);

	const handleChange = (e) => {
		const value = e.target.value;
		setMessage(value);
		if (!value.trim()) return stopTyping();

		const now = Date.now();
		if (now - lastEmitRef.current >= TYPING_EMIT_INTERVAL_MS) {
			socket?.emit("typing", { to: receiverId });
			lastEmitRef.current = now;
			isTypingRef.current = true;
		}
		clearTimeout(idleTimerRef.current);
		idleTimerRef.current = setTimeout(stopTyping, TYPING_IDLE_MS);
	};

	const handleSubmit = async (e) => {
		e.preventDefault();
		if (!message.trim() || loading) return;
		stopTyping();
		// keep the text if sending failed so the user can retry
		const sent = await sendMessage(message);
		if (sent) setMessage("");
	};

	return (
		<form className='px-4 my-3' onSubmit={handleSubmit}>
			<div className='w-full relative'>
				<input
					type='text'
					className='border text-sm rounded-lg block w-full p-2.5  bg-gray-700 border-gray-600 text-white'
					placeholder='Send a message'
					maxLength={2000}
					value={message}
					onChange={handleChange}
				/>
				<button type='submit' aria-label='Send' className='absolute inset-y-0 end-0 flex items-center pe-3'>
					{loading ? <div className='loading loading-spinner'></div> : <BsSend />}
				</button>
			</div>
		</form>
	);
};
export default MessageInput;
