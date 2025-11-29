// db.js
import dns from "dns";
dns.setDefaultResultOrder("ipv4first"); // Fixes ENOTFOUND on Neon
import pkg from "pg";
const { Pool } = pkg;

const basePool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },

  max: 1,
  idleTimeoutMillis: 0,
  connectionTimeoutMillis: 20000,
});

// Prevent app from crashing when Neon drops connections
basePool.on("error", (err) => {
  console.error("Postgres pool error:", err.message);
});

// Prevent client-level errors from crashing the app
basePool.on("connect", (client) => {
  client.on("error", (err) => {
    console.error("Postgres client error:", err.message);
  });
});

// ---- RETRY WRAPPER OVER pool.query() ---- //
async function safeQuery(text, params) {
  for (let i = 0; i < 3; i++) {
    try {
      return await basePool.query(text, params);
    } catch (err) {
      const retryable =
        err.message.includes("Connection terminated unexpectedly") ||
        err.message.includes("ENOTFOUND") ||
        err.message.includes("ETIMEDOUT") ||
        err.message.includes("timeout");

      if (retryable) {
        console.warn(`DB retry ${i + 1}/3: ${err.message}`);
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      throw err;
    }
  }

  throw new Error("DB failed after 3 retries");
}

// ---- Proxy: replaces only pool.query, everything else untouched ---- //
const pool = new Proxy(basePool, {
  get(target, prop) {
    if (prop === "query") return safeQuery;
    return target[prop];
  },
});

export default pool;
