import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
	{
		senderId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "User",
			required: true,
		},
		receiverId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "User",
			required: true,
		},
		message: {
			trim: true,
			maxlength: 2000,
			type: String,
			required: true,
		},
		// createdAt, updatedAt
	},
	{ timestamps: true }
);

// speeds up loading a two-way conversation
messageSchema.index({ senderId: 1, receiverId: 1, createdAt: -1 });

const Message = mongoose.model("Message", messageSchema);

export default Message;
