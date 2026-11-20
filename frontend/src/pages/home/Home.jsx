import MessageContainer from "../../components/messages/MessageContainer";
import Sidebar from "../../components/sidebar/Sidebar";
import useListenMessages from "../../hooks/useListenMessages";

const Home = () => {
	// listen for incoming messages for the whole session, not only while a chat is open
	useListenMessages();

	return (
		<div className='flex w-full max-w-4xl h-full max-h-[600px] rounded-lg overflow-hidden bg-gray-400 bg-clip-padding backdrop-filter backdrop-blur-lg bg-opacity-0'>
			<Sidebar />
			<MessageContainer />
		</div>
	);
};
export default Home;
