import { useState } from "react";
import { IoSearchSharp } from "react-icons/io5";
import useConversation from "../../zustand/useConversation";
import toast from "react-hot-toast";

const SearchInput = () => {
	const [search, setSearch] = useState("");
	const { setSelectedConversation, conversations } = useConversation();

	const handleSubmit = (e) => {
		e.preventDefault();
		const term = search.trim().toLowerCase();
		if (!term) return;
		if (term.length < 3) {
			return toast.error("Search term must be at least 3 characters long");
		}

		const conversation = conversations.find((c) => c.fullName.toLowerCase().includes(term));

		if (conversation) {
			setSelectedConversation(conversation);
			setSearch("");
		} else toast.error("No such user found!");
	};
	return (
		<form onSubmit={handleSubmit} className='flex items-center gap-2'>
			<input
				type='text'
				placeholder='Search…'
				className='input input-bordered rounded-full w-full min-w-0'
				value={search}
				onChange={(e) => setSearch(e.target.value)}
			/>
			<button type='submit' className='btn btn-circle bg-sky-500 text-white' aria-label='Search'>
				<IoSearchSharp className='w-6 h-6 outline-none' />
			</button>
		</form>
	);
};
export default SearchInput;
