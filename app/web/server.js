// Capstone 6 - Sample web frontend
// - Serves product catalog reads through ElastiCache (Redis) in front of RDS
// - Publishes "order" events onto SQS so a separate Fargate worker can process them async
const express = require("express");
const Redis = require("ioredis");
const mysql = require("mysql2/promise");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- Config (all injected as ECS task env vars, see infrastructure/05-ecs-services.yaml) ---
const REDIS_HOST = process.env.REDIS_HOST;
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const DB_HOST = process.env.DB_HOST;
const DB_USER = process.env.DB_USER;
const DB_PASSWORD = process.env.DB_PASSWORD;
const DB_NAME = process.env.DB_NAME || "capstone6";
const SQS_QUEUE_URL = process.env.SQS_QUEUE_URL;
const AWS_REGION = process.env.AWS_REGION || "us-east-1";

const redis = REDIS_HOST ? new Redis({ host: REDIS_HOST, port: Number(REDIS_PORT) }) : null;
const sqs = new SQSClient({ region: AWS_REGION });

let dbPool;
async function getDbPool() {
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

// Health check - used by ALB target group + Route 53 health check
app.get("/health", (req, res) => res.status(200).json({ status: "ok" }));

// Product catalog read, cached in Redis for CACHE_TTL seconds
const CACHE_TTL = 30;
app.get("/products", async (req, res) => {
  try {
    if (redis) {
      const cached = await redis.get("products:all");
      if (cached) {
        return res.json({ source: "cache", products: JSON.parse(cached) });
      }
    }

    let products;
    try {
      const pool = await getDbPool();
      const [rows] = await pool.query("SELECT id, name, price FROM products LIMIT 50");
      products = rows;
    } catch (dbErr) {
      // DB not reachable/seeded yet (e.g. local dev) - fall back to sample data
      products = [
        { id: 1, name: "Sample Widget", price: 9.99 },
        { id: 2, name: "Sample Gadget", price: 19.99 },
      ];
    }

    if (redis) {
      await redis.set("products:all", JSON.stringify(products), "EX", CACHE_TTL);
    }
    res.json({ source: "db", products });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// Order placement - decoupled via SQS. The worker service (app/worker) consumes this.
app.post("/orders", async (req, res) => {
  try {
    const order = {
      id: `order-${Date.now()}`,
      items: req.body.items || [],
      createdAt: new Date().toISOString(),
    };

    if (SQS_QUEUE_URL) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: SQS_QUEUE_URL,
          MessageBody: JSON.stringify(order),
        })
      );
    }

    res.status(202).json({ status: "queued", order });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

app.listen(PORT, () => console.log(`web listening on ${PORT}`));
