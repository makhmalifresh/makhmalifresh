import pkg from "pg";
import "dotenv/config";

const { Pool } = pkg;

// This is the single, centralized connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/**
 * A reusable query function that returns the ROWS directly.
 * @param {string} q The SQL query string
 * @param {Array} params The parameters for the query
 * @returns {Array} The rows from the database
 */
export const query = async (q, params) => {
  try {
    const { rows } = await pool.query(q, params);
    return rows;
  } catch (err) {
    console.error("Database query error:", err.message);
    throw err; // Re-throw the error to be caught by the route handler
  }
};

// We also export the pool itself for special cases like the login route
export default pool;