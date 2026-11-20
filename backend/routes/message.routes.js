import express from "express";
import { getMessages, getUnreadCounts, markAsRead, sendMessage } from "../controllers/message.controller.js";
import protectRoute from "../middleware/protectRoute.js";

const router = express.Router();

// fixed paths first, otherwise "/unread" would be captured by "/:id"
router.get("/unread", protectRoute, getUnreadCounts);
router.post("/read/:id", protectRoute, markAsRead);
router.get("/:id", protectRoute, getMessages);
router.post("/send/:id", protectRoute, sendMessage);

export default router;
