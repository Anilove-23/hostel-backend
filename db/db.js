const { Pool } = require("pg");
require("dotenv").config();

const connectionString = process.env.NEXT_PUBLIC_DATABASE || process.env.DATABASE_URL;

const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false
  },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// We removed pool.on("connect") because it triggers every time the pool opens a NEW underlying 
// socket connection (up to max: 20), which causes console spam.

pool.on("error", (err) => {
  console.error("Unexpected error on idle PostgreSQL client:", err.message);
  // Do not kill process on idle client drop from Neon serverless
});

module.exports = pool;
