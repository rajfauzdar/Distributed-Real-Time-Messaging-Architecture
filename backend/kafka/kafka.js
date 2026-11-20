import { Kafka, logLevel } from "kafkajs";

// Messages flow  API --(produce)--> Kafka topic --(consume)--> consumer.js --(bulk upsert)--> MongoDB
export const TOPIC = process.env.KAFKA_TOPIC || "chat.messages";
export const DLQ_TOPIC = `${TOPIC}.dlq`; // messages the consumer can't process (malformed) are parked here

// Kafka mode is opt-in: without KAFKA_BROKERS the API writes straight to MongoDB.
export const kafkaEnabled = () => Boolean(process.env.KAFKA_BROKERS);

export const createKafka = (clientId) =>
	new Kafka({
		clientId,
		brokers: process.env.KAFKA_BROKERS.split(",").map((b) => b.trim()),
		logLevel: logLevel.NOTHING, // kafkajs logs expected, self-healing conditions at ERROR; we log what matters ourselves
		connectionTimeout: 3000,
		requestTimeout: 8000,
		// fail fast so an API request errors (503 -> the client's outbox retries) instead of hanging
		retry: { initialRetryTime: 300, retries: 4 },
	});

export const ensureTopics = async (kafka) => {
	const admin = kafka.admin();
	await admin.connect();
	try {
		const replicationFactor = Number(process.env.KAFKA_REPLICATION || 1);
		await admin
			.createTopics({
				waitForLeaders: true,
				topics: [
					{ topic: TOPIC, numPartitions: Number(process.env.KAFKA_PARTITIONS || 3), replicationFactor },
					{ topic: DLQ_TOPIC, numPartitions: 1, replicationFactor },
				],
			})
			.catch(async (err) => {
				// the API and the consumer both call this at start-up, so an "already exists" race is expected;
				// anything else is only an error if the topics really aren't there
				const existing = await admin.listTopics();
				if (!existing.includes(TOPIC) || !existing.includes(DLQ_TOPIC)) throw err;
			});
	} finally {
		await admin.disconnect();
	}
};

// Partition key: both directions of a chat map to the same key, hence the same partition,
// so Kafka keeps every conversation's messages in order.
export const pairKey = (a, b) => [String(a), String(b)].sort().join(":");
