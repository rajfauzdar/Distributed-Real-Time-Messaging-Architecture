import bcrypt from "bcryptjs";
import User from "../models/user.model.js";
import generateTokenAndSetCookie, { clearAuthCookie } from "../utils/generateToken.js";

const USERNAME_REGEX = /^[a-z0-9_.]{3,20}$/;

const isString = (v) => typeof v === "string";

const userResponse = (user) => ({
	_id: user._id,
	fullName: user.fullName,
	username: user.username,
	profilePic: user.profilePic,
});

export const signup = async (req, res) => {
	try {
		const { fullName, username, password, confirmPassword, gender } = req.body;

		if (![fullName, username, password, confirmPassword, gender].every(isString)) {
			return res.status(400).json({ error: "Please fill in all fields" });
		}

		const cleanFullName = fullName.trim();
		const cleanUsername = username.trim().toLowerCase();

		if (!cleanFullName || !cleanUsername || !password) {
			return res.status(400).json({ error: "Please fill in all fields" });
		}
		if (cleanFullName.length > 50) {
			return res.status(400).json({ error: "Full name is too long (max 50 characters)" });
		}
		if (!USERNAME_REGEX.test(cleanUsername)) {
			return res
				.status(400)
				.json({ error: "Username must be 3-20 characters: letters, numbers, '_' or '.'" });
		}
		if (password.length < 6 || password.length > 72) {
			return res.status(400).json({ error: "Password must be between 6 and 72 characters" });
		}
		if (password !== confirmPassword) {
			return res.status(400).json({ error: "Passwords don't match" });
		}
		if (!["male", "female"].includes(gender)) {
			return res.status(400).json({ error: "Invalid gender" });
		}

		const existing = await User.findOne({ username: cleanUsername });
		if (existing) {
			return res.status(400).json({ error: "Username already exists" });
		}

		const salt = await bcrypt.genSalt(10);
		const hashedPassword = await bcrypt.hash(password, salt);

		// https://avatar-placeholder.iran.liara.run/
		const avatarType = gender === "male" ? "boy" : "girl";
		const profilePic = `https://avatar.iran.liara.run/public/${avatarType}?username=${encodeURIComponent(cleanUsername)}`;

		const newUser = new User({
			fullName: cleanFullName,
			username: cleanUsername,
			password: hashedPassword,
			gender,
			profilePic,
		});

		// save first, only then hand out a session
		await newUser.save();
		generateTokenAndSetCookie(newUser._id, res);

		res.status(201).json(userResponse(newUser));
	} catch (error) {
		if (error.code === 11000) {
			return res.status(400).json({ error: "Username already exists" });
		}
		console.log("Error in signup controller", error.message);
		res.status(500).json({ error: "Internal Server Error" });
	}
};

export const login = async (req, res) => {
	try {
		const { username, password } = req.body;

		// reject non-string values so objects like {"$ne": null} never reach the query
		if (!isString(username) || !isString(password) || !username || !password) {
			return res.status(400).json({ error: "Invalid username or password" });
		}

		// also match the exact spelling so accounts created before usernames were lowercased still work
		const trimmed = username.trim();
		const user = await User.findOne({ username: { $in: [trimmed, trimmed.toLowerCase()] } });
		const isPasswordCorrect = await bcrypt.compare(password, user?.password || "");

		if (!user || !isPasswordCorrect) {
			return res.status(400).json({ error: "Invalid username or password" });
		}

		generateTokenAndSetCookie(user._id, res);

		res.status(200).json(userResponse(user));
	} catch (error) {
		console.log("Error in login controller", error.message);
		res.status(500).json({ error: "Internal Server Error" });
	}
};

export const logout = (req, res) => {
	try {
		clearAuthCookie(res);
		res.status(200).json({ message: "Logged out successfully" });
	} catch (error) {
		console.log("Error in logout controller", error.message);
		res.status(500).json({ error: "Internal Server Error" });
	}
};

// Lets the client verify that its cookie session is still valid (used on app load).
export const me = (req, res) => {
	res.status(200).json(userResponse(req.user));
};
