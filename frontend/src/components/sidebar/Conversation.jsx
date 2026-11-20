import { useSocketContext } from "../../context/SocketContext";
import useConversation from "../../zustand/useConversation";

const Conversation = ({ conversation, lastIdx, emoji }) => {
	const { selectedConversation, setSelectedConversation, unreadCounts } = useConversation();

	const isSelected = selectedConversation?._id === conversation._id;
	const { onlineUsers } = useSocketContext();
	const isOnline = onlineUsers.includes(conversation._id);
	const unread = unreadCounts[conversation._id] || 0;

	return (
		<>
			<div
				role='button'
				tabIndex={0}
				className={`flex gap-2 items-center hover:bg-sky-500 rounded p-2 py-1 cursor-pointer
				${isSelected ? "bg-sky-500" : ""}
			`}
				onClick={() => setSelectedConversation(conversation)}
				onKeyDown={(e) => e.key === "Enter" && setSelectedConversation(conversation)}
			>
				<div className={`avatar ${isOnline ? "online" : ""}`}>
					<div className='w-12 rounded-full'>
						<img src={conversation.profilePic} alt={`${conversation.fullName} avatar`} />
					</div>
				</div>

				<div className='flex flex-col flex-1'>
					<div className='flex gap-3 justify-between items-center'>
						<p className='font-bold text-gray-200'>{conversation.fullName}</p>
						{unread > 0 && <span className='badge badge-sm badge-primary'>{unread}</span>}
						<span className='text-xl'>{emoji}</span>
					</div>
				</div>
			</div>

			{!lastIdx && <div className='divider my-0 py-0 h-1' />}
		</>
	);
};
export default Conversation;
