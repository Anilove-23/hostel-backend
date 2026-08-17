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

pool.on("connect", () => {
  console.log("Connected to the Neon PostgreSQL database");
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle PostgreSQL client:", err.message);
  // Do not kill process on idle client drop from Neon serverless
});

module.exports = pool;
