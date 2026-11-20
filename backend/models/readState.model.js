import mongoose from "mongoose";

// "How far has `userId` read in the chat with `peerId`?"  Unread count = messages from the peer newer than lastReadAt.
// A cursor (instead of a per-message flag) means marking a whole chat as read is one tiny write.
const readStateSchema = new mongoose.Schema(
	{
		userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
		peerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
		lastReadAt: { type: Date, required: true },
	},
	{ timestamps: true }
);

readStateSchema.index({ userId: 1, peerId: 1 }, { unique: true });

const ReadState = mongoose.model("ReadState", readStateSchema);

export default ReadState;
