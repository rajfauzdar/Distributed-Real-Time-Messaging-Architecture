// Kafka -> MongoDB persister. Run as its own process:  node backend/consumer.js
//
// - reads message events in batches and writes them with one bulk upsert (keyed by _id => idempotent)
// - offsets are committed only after MongoDB has the data, so a crash re-delivers rather than loses messages
// - malformed events go to a dead-letter topic instead of blocking the partition
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();
const { Partitioners } = await import("kafkajs");

for (const key of ["MONGO_DB_URI", "KAFKA_BROKERS"]) {
	if (!process.env[key]) {
		console.error(`Missing required environment variable: ${key}`);
		process.exit(1);
	}
}

const { createKafka, ensureTopics, TOPIC, DLQ_TOPIC } = await import("./kafka/kafka.js");

const CLIENT_ID_REGEX = /^[\w-]{8,64}$/;
const isId = (v) => typeof v === "string" && mongoose.isValidObjectId(v);

// returns the Mongo operation for a valid event, or throws if the event is malformed
const toOperation = (event) => {
	if (!isId(event._id) || !isId(event.senderId) || !isId(event.receiverId)) throw new Error("bad ids");
	if (typeof event.message !== "string" || !event.message || event.message.length > 2000) throw new Error("bad message");
	const createdAt = new Date(event.createdAt);
	if (Number.isNaN(createdAt.getTime())) throw new Error("bad createdAt");
	if (event.clientId !== undefined && !CLIENT_ID_REGEX.test(event.clientId)) throw new Error("bad clientId");

	const doc = {
		senderId: new mongoose.Types.ObjectId(event.senderId),
		receiverId: new mongoose.Types.ObjectId(event.receiverId),
		message: event.message,
		createdAt,
		updatedAt: createdAt,
		__v: 0,
	};
	if (event.clientId) doc.clientId = event.clientId;

	// $setOnInsert: replaying the same event (redelivery, producer retry, client retry) changes nothing
	return { updateOne: { filter: { _id: new mongoose.Types.ObjectId(event._id) }, update: { $setOnInsert: doc }, upsert: true } };
};

const isOnlyDuplicateKeyErrors = (err) => {
	const writeErrors = [].concat(err.writeErrors ?? []);
	return writeErrors.length > 0 && writeErrors.every((e) => (e.code ?? e.err?.code) === 11000);
};

await mongoose.connect(process.env.MONGO_DB_URI);
console.log("Consumer: connected to MongoDB");

const kafka = createKafka("chat-persister");
await ensureTopics(kafka);

const dlqProducer = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner });
await dlqProducer.connect();

const consumer = kafka.consumer({
	groupId: process.env.KAFKA_GROUP_ID || "chat-persister",
	maxWaitTimeInMs: 50, // flush small batches quickly: low persistence lag at low traffic, big batches under load
});
await consumer.connect();
await consumer.subscribe({ topic: TOPIC, fromBeginning: true });

const messages = mongoose.connection.collection("messages");
let persisted = 0;
let deadLettered = 0;

await consumer.run({
	eachBatchAutoResolve: false,
	eachBatch: async ({ batch, resolveOffset, heartbeat }) => {
		const ops = [];
		const dead = [];

		for (const m of batch.messages) {
			try {
				ops.push(toOperation(JSON.parse(m.value.toString())));
			} catch (err) {
				dead.push({ key: m.key, value: m.value, headers: { error: err.message, offset: m.offset } });
			}
		}

		if (dead.length) {
			await dlqProducer.send({ topic: DLQ_TOPIC, messages: dead });
			deadLettered += dead.length;
		}

		if (ops.length) {
			try {
				await messages.bulkWrite(ops, { ordered: false });
			} catch (err) {
				// e.g. the same clientId already stored under a different _id by the legacy direct-write path
				if (!isOnlyDuplicateKeyErrors(err)) throw err; // real failure (DB down...) => batch is retried, nothing lost
			}
			persisted += ops.length;
		}

		// only now is it safe to mark the batch as done
		resolveOffset(batch.messages[batch.messages.length - 1].offset);
		await heartbeat();
	},
});

console.log(`Consumer: running (topic ${TOPIC}, group ${process.env.KAFKA_GROUP_ID || "chat-persister"})`);
const stats = setInterval(() => {
	if (persisted || deadLettered) console.log(`Consumer: persisted=${persisted} deadLettered=${deadLettered}`);
}, 30_000);
stats.unref();

let stopping = false;
const shutdown = async (signal) => {
	if (stopping) return;
	stopping = true;
	console.log(`${signal} received, stopping consumer...`);
	setTimeout(() => process.exit(1), 10_000).unref();
	await consumer.disconnect().catch(() => {});
	await dlqProducer.disconnect().catch(() => {});
	await mongoose.disconnect().catch(() => {});
	process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
