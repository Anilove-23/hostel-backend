const bcrypt = require('bcryptjs');
const pool = require('./db/db');

async function test() {
  const email = 'chiefwarden@nith.ac.in';
  const password = '1234';
  
  const userCheck = await pool.query('SELECT * FROM authority WHERE email = $1', [email]);
  if (userCheck.rows.length === 0) {
    console.log('User not found!');
    process.exit(1);
  }
  const user = userCheck.rows[0];
  console.log('User found:', user.email);
  console.log('Stored password hash:', user.password);
  
  const isValid = await bcrypt.compare(password, user.password);
  console.log('Is valid with 1234?', isValid);
  
  if (!isValid && !user.password.startsWith('')) {
    console.log('Wait, is it plaintext?', password === user.password);
  }
  process.exit(0);
}
test();
