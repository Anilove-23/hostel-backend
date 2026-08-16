const pool = require('./db/db');
(async () => {
  try {
    await pool.query('ALTER TABLE outpass DROP CONSTRAINT outpass_outp_status_check');
    await pool.query("ALTER TABLE outpass ADD CONSTRAINT outpass_outp_status_check CHECK (outp_status IN ('Pending', 'Approved', 'Rejected', 'Cancelled'))");
    console.log('Fixed Constraint');
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
})();
