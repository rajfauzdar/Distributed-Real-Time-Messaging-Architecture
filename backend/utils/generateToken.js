import jwt from "jsonwebtoken";

const cookieOptions = () => ({
	httpOnly: true, // prevent XSS attacks cross-site scripting attacks
	sameSite: "strict", // CSRF attacks cross-site request forgery attacks
	secure: process.env.NODE_ENV === "production",
});

const generateTokenAndSetCookie = (userId, res) => {
	const token = jwt.sign({ userId }, process.env.JWT_SECRET, {
		expiresIn: "15d",
	});

	res.cookie("jwt", token, {
		...cookieOptions(),
		maxAge: 15 * 24 * 60 * 60 * 1000, // MS
	});
};

export const clearAuthCookie = (res) => {
	res.clearCookie("jwt", cookieOptions());
};

export default generateTokenAndSetCookie;
