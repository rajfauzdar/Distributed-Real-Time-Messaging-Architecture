import { Partitioners } from "kafkajs";
import { createKafka, ensureTopics, pairKey, TOPIC } from "./kafka.js";

export class KafkaUnavailableError extends Error {}

const PUBLISH_DEADLINE_MS = 6000;

let producer = null;
let ready = false;
let retryTimer = null;

// Not idempotent at the broker level on purpose: duplicates (a retried produce) are harmless because
// message _ids are deterministic and the consumer upserts by _id. That lets many sends run in parallel
// instead of being serialized by maxInFlightRequests=1.
const connect = async () => {
	const kafka = createKafka("chat-api");
	await ensureTopics(kafka);
	producer = kafka.producer({ allowAutoTopicCreation: false, createPartitioner: Partitioners.DefaultPartitioner });
	await producer.connect();
	ready = true;
	console.log("Kafka producer connected");
};

// Never blocks server start-up: if the broker is down we keep retrying in the background
// and requests get a 503 (which the client retries) until it is back.
export const startProducer = async () => {
	try {
		await connect();
	} catch (err) {
		ready = false;
		console.error(`Kafka producer not ready (${err.message}); retrying in 5s`);
		retryTimer = setTimeout(startProducer, 5000);
		retryTimer.unref();
	}
};

export const publishMessage = async (doc) => {
	if (!ready) throw new KafkaUnavailableError("Kafka producer not connected");
	try {
		// Hard cap on how long a request may wait for Kafka: kafkajs' own retries can take 40s+ during an outage.
		// If the cap fires the send may still land later - harmless, the consumer upserts by deterministic _id.
		let timer;
		const deadline = new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error("Kafka publish timed out")), PUBLISH_DEADLINE_MS);
		});
		await Promise.race([
			producer.send({
				topic: TOPIC,
				acks: -1, // wait until the broker has the message (all in-sync replicas) before acknowledging the user
				timeout: 5000,
				messages: [{ key: pairKey(doc.senderId, doc.receiverId), value: JSON.stringify(doc) }],
			}),
			deadline,
		]).finally(() => clearTimeout(timer));
	} catch (err) {
		throw new KafkaUnavailableError(err.message);
	}
};

export const stopProducer = async () => {
	clearTimeout(retryTimer);
	ready = false;
	await producer?.disconnect().catch(() => {});
};
