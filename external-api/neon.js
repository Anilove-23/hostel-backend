const { neon } = require('@neondatabase/serverless');
require('dotenv').config();

// Create a connection to the Neon database
const sql = neon(process.env.NEXT_PUBLIC_DATABASE);

module.exports = { sql };
