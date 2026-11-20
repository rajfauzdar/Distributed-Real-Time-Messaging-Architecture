// Presence store: which users currently have at least one live socket.
// - Redis implementation: shared by every server instance. Each socket is a sorted-set member scored by
//   its last heartbeat, so sockets of a crashed instance simply expire (no ghost "online" users).
// - Memory implementation: used when REDIS_URL isn't set (single instance / local dev).

export const PRESENCE_TTL_MS = 45_000;
const KEY = "presence:sockets";
const member = (userId, socketId) => `${userId}|${socketId}`;
const userOf = (m) => m.slice(0, m.indexOf("|"));

export const createMemoryPresence = () => {
	const sockets = new Map(); // userId -> Set<socketId>
	return {
		async add(userId, socketId) {
			if (!sockets.has(userId)) sockets.set(userId, new Set());
			sockets.get(userId).add(socketId);
		},
		async remove(userId, socketId) {
			const set = sockets.get(userId);
			if (!set) return;
			set.delete(socketId);
			if (set.size === 0) sockets.delete(userId);
		},
		async touch() {}, // nothing expires in memory
		async onlineUserIds() {
			return [...sockets.keys()];
		},
	};
};

export const createRedisPresence = (redis) => ({
	async add(userId, socketId) {
		await redis.zAdd(KEY, { score: Date.now(), value: member(userId, socketId) });
	},
	async remove(userId, socketId) {
		await redis.zRem(KEY, member(userId, socketId));
	},
	// refresh the heartbeat of the sockets this instance owns
	async touch(members) {
		if (members.length === 0) return;
		const now = Date.now();
		await redis.zAdd(
			KEY,
			members.map((value) => ({ score: now, value }))
		);
	},
	async onlineUserIds() {
		const cutoff = Date.now() - PRESENCE_TTL_MS;
		await redis.zRemRangeByScore(KEY, "-inf", cutoff);
		const members = await redis.zRange(KEY, 0, -1);
		return [...new Set(members.map(userOf))];
	},
});

export const presenceMember = member;
