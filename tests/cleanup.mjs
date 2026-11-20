// Removes any leftover test users (and their messages / read cursors) if a test run was interrupted.
//   npm run test:cleanup
import { mongoose, removeTestUsers } from "./lib.mjs";

const removed = await removeTestUsers();
console.log(`removed ${removed.users} test users and ${removed.messages} test messages`);
await mongoose.disconnect();
