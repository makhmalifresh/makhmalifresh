import pkg from "pg";
import "dotenv/config";

const { Pool } = pkg;

// This is your single, centralized connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// --- THIS IS THE DEFINITIVE FIX ---
// This code listens for idle connection errors in the background.
// If NeonDB terminates a connection, this will log the error
// but IT WILL NOT CRASH YOUR SERVER.
pool.on('error', (err, client) => {
  console.error('Database pool idle client error:', err.message, err.stack);
  // We do not exit the process. The pool will handle this.
});

/**
 * A reusable query function that returns the ROWS directly.
 * @param {string} q The SQL query string
 * @param {Array} params The parameters for the query
 * @returns {Array} The rows from the database
 */
export const query = async (q, params) => {
  const start = Date.now();
  try {
    const { rows } = await pool.query(q, params);
    const duration = Date.now() - start;
    // This log is helpful for debugging query performance
    // console.log('Executed query', { duration: `${duration}ms`, rows: rows.length });
    return rows;
  } catch (err) {
    console.error("Database query error:", err.message);
    throw err; // Re-throw the error to be caught by the route handler
  }
};

// We also export the pool itself for the special login route
export default pool;