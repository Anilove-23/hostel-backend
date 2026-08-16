const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.NEXT_PUBLIC_DATABASE,
});

pool.on("connect", () => {
  console.log("Connected to the Neon PostgreSQL database");
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle client", err);
  process.exit(-1);
});

module.exports = pool;
