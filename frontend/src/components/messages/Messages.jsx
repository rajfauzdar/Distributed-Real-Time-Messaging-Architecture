import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import useGetMessages from "../../hooks/useGetMessages";
import useConversation from "../../zustand/useConversation";
import MessageSkeleton from "../skeletons/MessageSkeleton";
import Message from "./Message";

const LOAD_OLDER_THRESHOLD_PX = 80; // start loading the previous page when the user scrolls this close to the top

const Messages = () => {
	const { messages, loading, hasMore, loadingOlder, loadOlder } = useGetMessages();
	const selectedId = useConversation((s) => s.selectedConversation?._id);
	const outbox = useConversation((s) => s.outbox);
	const recentSent = useConversation((s) => s.recentSent);

	const containerRef = useRef(null);
	const bottomRef = useRef(null);
	const anchorRef = useRef(null); // scroll position captured right before an older page is prepended
	const lastKeyRef = useRef(null); // key of the newest message, to tell "new message" from "older page prepended"

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

	const handleLoadOlder = async () => {
		const el = containerRef.current;
		if (!el) return;
		anchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
		const loaded = await loadOlder();
		if (!loaded) anchorRef.current = null;
	};

	// After an older page is rendered, keep the message the user was looking at in the same place on screen.
	const oldestId = messages[0]?._id;
	useLayoutEffect(() => {
		const el = containerRef.current;
		const anchor = anchorRef.current;
		if (!el || !anchor) return;
		el.scrollTop = el.scrollHeight - anchor.height + anchor.top;
		anchorRef.current = null;
	}, [oldestId]);

	// Scroll to the bottom only when the NEWEST message changes (a new message, or the first load of a chat) -
	// never when older messages are added at the top.
	const lastKey = visible.length ? visible[visible.length - 1].clientId || visible[visible.length - 1]._id : null;
	useEffect(() => {
		if (lastKey === null) {
			lastKeyRef.current = null;
			return;
		}
		const firstLoad = lastKeyRef.current === null;
		lastKeyRef.current = lastKey;
		const timer = setTimeout(() => {
			bottomRef.current?.scrollIntoView({ behavior: firstLoad ? "auto" : "smooth" });
		}, 50);
		return () => clearTimeout(timer);
	}, [lastKey]);

	// a different chat starts from scratch
	useEffect(() => {
		lastKeyRef.current = null;
		anchorRef.current = null;
	}, [selectedId]);

	const handleScroll = (e) => {
		if (e.currentTarget.scrollTop < LOAD_OLDER_THRESHOLD_PX && hasMore && !loadingOlder && !loading) handleLoadOlder();
	};

	return (
		<div ref={containerRef} onScroll={handleScroll} className='px-4 flex-1 overflow-auto'>
			{!loading && hasMore && (
				<div className='flex justify-center py-2'>
					<button
						type='button'
						className='btn btn-xs btn-ghost text-gray-300'
						onClick={handleLoadOlder}
						disabled={loadingOlder}
					>
						{loadingOlder ? <span className='loading loading-spinner loading-xs'></span> : "Load older messages"}
					</button>
				</div>
			)}

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
