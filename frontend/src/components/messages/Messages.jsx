import { useEffect, useMemo, useRef } from "react";
import useGetMessages from "../../hooks/useGetMessages";
import useConversation from "../../zustand/useConversation";
import MessageSkeleton from "../skeletons/MessageSkeleton";
import Message from "./Message";

const Messages = () => {
	const { messages, loading } = useGetMessages();
	const selectedId = useConversation((s) => s.selectedConversation?._id);
	const outbox = useConversation((s) => s.outbox);
	const recentSent = useConversation((s) => s.recentSent);
	const bottomRef = useRef();

	// confirmed messages + the ones still being delivered (optimistic), oldest first
	const visible = useMemo(() => {
		const known = new Set(messages.map((m) => m._id));
		const now = Date.now();
		// accepted by the server but maybe not in the history response yet (Kafka -> MongoDB lag)
		const recent = recentSent
			.filter((r) => r.doc.receiverId === selectedId && now - r.at < 60_000 && !known.has(r.doc._id))
			.map((r) => r.doc);
		const confirmed = [...messages, ...recent];
		const confirmedClientIds = new Set(confirmed.map((m) => m.clientId).filter(Boolean));
		const pending = outbox
			.filter((o) => o.receiverId === selectedId && !confirmedClientIds.has(o.clientId))
			.map((o) => ({
				_id: o.clientId,
				clientId: o.clientId,
				senderId: o.senderId,
				receiverId: o.receiverId,
				message: o.message,
				createdAt: o.createdAt,
				status: o.status, // "sending" | "failed"
				error: o.error,
			}));
		return [...confirmed, ...pending];
	}, [messages, outbox, recentSent, selectedId]);

	useEffect(() => {
		const timer = setTimeout(() => {
			bottomRef.current?.scrollIntoView({ behavior: "smooth" });
		}, 100);
		return () => clearTimeout(timer);
	}, [visible.length]);

	return (
		<div className='px-4 flex-1 overflow-auto'>
			{!loading &&
				// key by clientId so a bubble doesn't remount when its temporary entry is replaced by the saved message
				visible.map((message) => <Message key={message.clientId || message._id} message={message} />)}

			{loading && visible.length === 0 && [...Array(3)].map((_, idx) => <MessageSkeleton key={idx} />)}
			{!loading && visible.length === 0 && <p className='text-center'>Send a message to start the conversation</p>}
			<div ref={bottomRef} />
		</div>
	);
};
export default Messages;
