const { neon } = require('@neondatabase/serverless');
require('dotenv').config();

// Create a connection to the Neon database
const sql = neon(process.env.DATABASE_URL);

module.exports = { sql };
