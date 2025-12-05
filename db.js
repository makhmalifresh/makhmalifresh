import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import pkg from "pg";
const { Pool } = pkg;


// --------------------------------------------------
// CREATE SINGLE POOL (NEON FREE TIER SAFE CONFIG)
// --------------------------------------------------
const basePool = new Pool({
  connectionString: process.env.DATABASE_URL,

  max: 1,                    // Free tier limit
  idleTimeoutMillis: 10000,  // recycle before Neon kills idle conn
  connectionTimeoutMillis: 8000,

  ssl: { rejectUnauthorized: false },
});

console.log("db loaded")


// Log pool-level errors
basePool.on("error", (err) => {
  console.error("Postgres pool error:", err.message);
});

// Log client-level errors
basePool.on("connect", (client) => {
  client.on("error", (err) => {
    console.error("Postgres client error:", err.message);
  });
});

// --------------------------------------------------
// SAFE QUERY (with retry)
// --------------------------------------------------
async function safeQuery(text, params) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await basePool.query(text, params);
    } catch (err) {
      const retryable =
        err.message.includes("Connection terminated") ||
        err.message.includes("ECONNRESET") ||
        err.message.includes("timeout") ||
        err.code === "ECONNRESET" ||
        err.message.includes("Client has encountered a connection error");

      if (retryable) {
        console.log(`🔄 DB retry ${attempt}/3 → ${err.message}`);
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }

      throw err; // non-retryable
    }
  }

  throw new Error("DB failed after 3 retries");
}

// --------------------------------------------------
// GLOBAL QUEUE → ENSURES ONLY 1 QUERY AT A TIME
// This is **mandatory** for Neon Free Tier
// --------------------------------------------------
let last = Promise.resolve();

function queuedQuery(text, params) {
  // Chain promise → ensures FIFO execution
  last = last.then(() => safeQuery(text, params));
  return last;
}

// --------------------------------------------------
// PROXY: Replace pool.query() → queuedQuery()
// Everything else stays the same
// You do NOT change code anywhere else.
// --------------------------------------------------
const pool = new Proxy(basePool, {
  get(target, prop) {
    if (prop === "query") return queuedQuery;
    return target[prop];
  },
});

export default pool;

// --------------------------------------------------
// KEEP NEON CONNECTION ALIVE
// --------------------------------------------------
// setInterval(() => {
//   basePool.query("SELECT 1").catch(() => {});
// }, 30000);
