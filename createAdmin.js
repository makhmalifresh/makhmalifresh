// This is a one-time-use script to securely create your first admin user.
// Run it from your terminal like this:
// ADMIN_EMAIL="your-email@example.com" ADMIN_PASSWORD="your-strong-password" node src/scripts/seed_admin.js

import { hash } from 'bcrypt';
import { Pool } from 'pg';
// require('dotenv').config();
import dotenv from 'dotenv'
dotenv.config();
// --- Configuration ---
const ADMIN_EMAIL = 'admin@makhmali.com';
const ADMIN_PASSWORD = 'password123makhmali';
const SALT_ROUNDS = 12; // A strong salt round value for bcrypt

// --- Database Connection ---
// Ensure your .env file has your NeonDB connection string (e.g., DATABASE_URL=...)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function createAdmin() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error('ERROR: Please provide ADMIN_EMAIL and ADMIN_PASSWORD environment variables.');
    process.exit(1);
  }

  console.log(`Creating admin user for: ${ADMIN_EMAIL}`);

  try {
    // 1. Hash the password securely
    console.log('Hashing password...');
    const passwordHash = await hash(ADMIN_PASSWORD, SALT_ROUNDS);
    console.log('Password hashed successfully.');

    // 2. Connect to the database
    const client = await pool.connect();
    console.log('Connected to database.');

    // 3. Insert the new admin user
    const query = `
      INSERT INTO admins (email, password_hash)
      VALUES ($1, $2)
      ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
      RETURNING id, email, created_at;
    `;
    const values = [ADMIN_EMAIL, passwordHash];
    
    const result = await client.query(query, values);

    console.log('✅ Admin user created or updated successfully!');
    console.table(result.rows);

    client.release();
  } catch (error) {
    console.error('❌ Failed to create admin user:', error);
  } finally {
    await pool.end();
  }
}

createAdmin();
