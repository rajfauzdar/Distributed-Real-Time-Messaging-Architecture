import useConversation from "../../zustand/useConversation";
import Conversations from "./Conversations";
import LogoutButton from "./LogoutButton";
import SearchInput from "./SearchInput";

const Sidebar = () => {
	const hasSelection = useConversation((s) => !!s.selectedConversation);
	return (
		// on phones the sidebar and the chat are separate screens
		<div
			className={`border-r border-slate-500 p-4 flex-col w-full md:w-auto md:max-w-[300px] min-h-0 ${
				hasSelection ? "hidden md:flex" : "flex"
			}`}
		>
			<SearchInput />
			<div className='divider px-3'></div>
			<Conversations />
			<LogoutButton />
		</div>
	);
};
export default Sidebar;
