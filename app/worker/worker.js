// Capstone 6 - Sample SQS worker
// Long-polls the order queue and "processes" each order (writes to RDS if configured).
// This is what the ECS worker service scales on: SQS ApproximateNumberOfMessagesVisible.
const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require("@aws-sdk/client-sqs");
const mysql = require("mysql2/promise");

const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const SQS_QUEUE_URL = process.env.SQS_QUEUE_URL;
const DB_HOST = process.env.DB_HOST;
const DB_USER = process.env.DB_USER;
const DB_PASSWORD = process.env.DB_PASSWORD;
const DB_NAME = process.env.DB_NAME || "capstone6";

if (!SQS_QUEUE_URL) {
  console.error("SQS_QUEUE_URL is required");
  process.exit(1);
}

const sqs = new SQSClient({ region: AWS_REGION });

let dbPool;
async function getDbPool() {
  if (!DB_HOST) return null;
  if (!dbPool) {
    dbPool = mysql.createPool({
      host: DB_HOST,
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_NAME,
      waitForConnections: true,
      connectionLimit: 5,
    });
  }
  return dbPool;
}

async function processOrder(order) {
  console.log("Processing order", order.id);
  const pool = await getDbPool();
  if (pool) {
    try {
      await pool.query(
        "INSERT INTO orders (id, payload, created_at) VALUES (?, ?, NOW())",
        [order.id, JSON.stringify(order)]
      );
    } catch (err) {
      console.error("DB write failed (continuing):", err.message);
    }
  }
  // Simulate variable processing time so scaling behavior is visible under load tests
  await new Promise((r) => setTimeout(r, 200));
}

async function pollLoop() {
  for (;;) {
    try {
      const { Messages } = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: SQS_QUEUE_URL,
          MaxNumberOfMessages: 5,
          WaitTimeSeconds: 15, // long polling
          VisibilityTimeout: 30,
        })
      );

      if (!Messages || Messages.length === 0) continue;

      for (const msg of Messages) {
        try {
          const order = JSON.parse(msg.Body);
          await processOrder(order);
          await sqs.send(
            new DeleteMessageCommand({
              QueueUrl: SQS_QUEUE_URL,
              ReceiptHandle: msg.ReceiptHandle,
            })
          );
        } catch (err) {
          console.error("Failed to process message, leaving for retry/DLQ:", err.message);
        }
      }
    } catch (err) {
      console.error("Poll loop error:", err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

console.log("worker started, polling", SQS_QUEUE_URL);
pollLoop();
