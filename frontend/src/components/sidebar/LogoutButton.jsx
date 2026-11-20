import { BiLogOut } from "react-icons/bi";
import useLogout from "../../hooks/useLogout";

const LogoutButton = () => {
	const { loading, logout } = useLogout();

	return (
		<div className='mt-auto pt-2'>
			{!loading ? (
				<button type='button' onClick={logout} aria-label='Log out' title='Log out'>
					<BiLogOut className='w-6 h-6 text-white cursor-pointer' />
				</button>
			) : (
				<span className='loading loading-spinner'></span>
			)}
		</div>
	);
};
export default LogoutButton;
