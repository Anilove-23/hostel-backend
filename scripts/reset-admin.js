const bcrypt = require('bcryptjs');
const pool = require('../db/db');

async function resetAdmin(email, newPassword) {
  try {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    const result = await pool.query(
      'UPDATE authority SET password = $1 WHERE email = $2 RETURNING email, status',
      [hashedPassword, email]
    );

    if (result.rows.length > 0) {
      console.log(`Successfully reset password for ${result.rows[0].email} (${result.rows[0].status})`);
      console.log(`New password is: ${newPassword}`);
    } else {
      console.log(`No admin found with email ${email}`);
    }
  } catch (err) {
    console.error('Error resetting password:', err);
  } finally {
    pool.end();
  }
}

// Default to chiefwarden@nith.ac.in if no argument is passed
const targetEmail = process.argv[2] || 'chiefwarden@nith.ac.in';
resetAdmin(targetEmail, '1234');
