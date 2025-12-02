import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import pkg from "pg";
const { Pool } = pkg;

const basePool = new Pool({
  connectionString: process.env.DATABASE_URL,

  max: 1,                     // FREE TIER LIMIT
  idleTimeoutMillis: 10000,   // must be SMALL (Neon kills after 5 mins)
  connectionTimeoutMillis: 5000,

  ssl: { rejectUnauthorized: false },
});

// Handle pool errors (Neon closes idle sessions)
basePool.on("error", (err) => {
  console.error("Postgres pool error:", err.message);
});

// Handle client errors to prevent crashes
basePool.on("connect", (client) => {
  client.on("error", (err) => {
    console.error("Postgres client error:", err.message);
  });
});

// SAFE QUERY WITH RECONNECT RETRY
async function safeQuery(text, params) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await basePool.query(text, params);
    } catch (err) {
      if (
        err.message.includes("Connection terminated") ||
        err.message.includes("ECONNRESET") ||
        err.message.includes("timeout") ||
        err.message.includes("Client has encountered a connection error")
      ) {
        console.log(`🔄 Retry ${attempt}/3 → ${err.message}`);
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      throw err;
    }
  }
  throw new Error("DB failed after 3 retries");
}

// Proxy pool to replace query()
const pool = new Proxy(basePool, {
  get(target, prop) {
    if (prop === "query") return safeQuery;
    return target[prop];
  },
});

export default pool;

// ---- KEEP CONNECTION ALIVE (NEON FREE-TIER SAFE) ---- //
setInterval(() => {
  basePool.query("SELECT 1").catch(() => {});
}, 30000);  // ping every 30s (important!)
