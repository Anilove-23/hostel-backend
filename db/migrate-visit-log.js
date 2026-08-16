const pool = require("./db");

async function migrateVisitLog() {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Create visit_log table
        await client.query(`
            CREATE TABLE IF NOT EXISTS visit_log (
                id SERIAL PRIMARY KEY,
                outpass_id TEXT NOT NULL REFERENCES outpass(id) ON DELETE CASCADE,
                student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
                actual_departure TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                actual_arrival TIMESTAMP,
                remarks TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                gate VARCHAR(100) DEFAULT 'Main Gate',
                exit_guard_id TEXT,
                entry_guard_id TEXT
            );
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_visit_log_student ON visit_log(student_id);
            CREATE INDEX IF NOT EXISTS idx_visit_log_outpass ON visit_log(outpass_id);
        `);

        // 2. Ensure guard_action_log has guard_id column
        await client.query(`
            ALTER TABLE guard_action_log ADD COLUMN IF NOT EXISTS guard_id TEXT;
        `);

        await client.query("COMMIT");
        console.log("Visit log table and guard_action_log migration completed successfully.");
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Migration error:", err);
        throw err;
    } finally {
        client.release();
    }
}

if (require.main === module) {
    migrateVisitLog()
        .then(() => pool.end())
        .catch(() => pool.end());
}

module.exports = migrateVisitLog;
