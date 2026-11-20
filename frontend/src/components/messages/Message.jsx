import { useAuthContext } from "../../context/AuthContext";
import { extractTime } from "../../utils/extractTime";
import { discardMessage, retryMessage } from "../../utils/outbox";
import useConversation from "../../zustand/useConversation";

const Message = ({ message }) => {
	const { authUser } = useAuthContext();
	const { selectedConversation } = useConversation();
	const fromMe = message.senderId === authUser._id;
	const formattedTime = extractTime(message.createdAt);
	const chatClassName = fromMe ? "chat-end" : "chat-start";
	const profilePic = fromMe ? authUser.profilePic : selectedConversation?.profilePic;
	const isSending = message.status === "sending";
	const isFailed = message.status === "failed";
	const bubbleBgColor = isFailed ? "bg-red-500" : fromMe ? "bg-blue-500" : "";

	const shakeClass = message.shouldShake ? "shake" : "";

	return (
		<div className={`chat ${chatClassName}`}>
			<div className='chat-image avatar'>
				<div className='w-10 rounded-full'>
					<img alt='avatar' src={profilePic} />
				</div>
			</div>
			<div className={`chat-bubble text-white ${bubbleBgColor} ${shakeClass} pb-2 ${isSending ? "opacity-60" : ""}`}>
				{message.message}
			</div>
			<div className='chat-footer text-xs flex gap-1 items-center'>
				{isFailed ? (
					<>
						<span className='text-red-400' title={message.error}>
							Not sent
						</span>
						<button type='button' className='underline text-sky-300' onClick={() => retryMessage(message.clientId)}>
							Retry
						</button>
						<button type='button' className='underline opacity-70' onClick={() => discardMessage(message.clientId)}>
							Delete
						</button>
					</>
				) : (
					<span className='opacity-50'>{isSending ? "Sending…" : formattedTime}</span>
				)}
			</div>
		</div>
	);
};
export default Message;
