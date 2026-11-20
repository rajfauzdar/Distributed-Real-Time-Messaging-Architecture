import jwt from "jsonwebtoken";
import User from "../models/user.model.js";

// Short-lived cache of the authenticated user: without it every API call costs a database round trip.
// Trade-off: a deleted user keeps access for up to USER_CACHE_TTL_MS (accounts can't be deleted in the app today).
const USER_CACHE_TTL_MS = 30_000;
const USER_CACHE_MAX = 5_000;
const userCache = new Map(); // userId -> { user, expires }

const getUser = async (userId) => {
	const hit = userCache.get(userId);
	if (hit && hit.expires > Date.now()) return hit.user;

	const user = await User.findById(userId).select("-password");
	if (!user) {
		userCache.delete(userId);
		return null;
	}
	if (userCache.size >= USER_CACHE_MAX) userCache.clear();
	userCache.set(userId, { user, expires: Date.now() + USER_CACHE_TTL_MS });
	return user;
};

const protectRoute = async (req, res, next) => {
	try {
		const token = req.cookies.jwt;

		if (!token) {
			return res.status(401).json({ error: "Unauthorized - No Token Provided" });
		}

		let decoded;
		try {
			decoded = jwt.verify(token, process.env.JWT_SECRET);
		} catch {
			// expired / malformed / tampered token
			return res.status(401).json({ error: "Unauthorized - Invalid Token" });
		}

		const user = await getUser(String(decoded.userId));

		if (!user) {
			return res.status(401).json({ error: "Unauthorized - User not found" });
		}

		req.user = user;

		next();
	} catch (error) {
		console.log("Error in protectRoute middleware: ", error.message);
		res.status(500).json({ error: "Internal server error" });
	}
};

export default protectRoute;
