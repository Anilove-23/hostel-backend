const pool = require("./db");

async function migrateHostelGuard() {
    const client = await pool.connect();
    try {
        console.log("Starting hostel guard migration...");
        await client.query("BEGIN");

        // ─── 1. Add hostel_std_status column to outpass ─────────────────────────
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'outpass' AND column_name = 'hostel_std_status'
                ) THEN
                    ALTER TABLE outpass ADD COLUMN hostel_std_status VARCHAR(50) DEFAULT 'In'
                        CHECK (hostel_std_status IN ('In', 'Out'));
                END IF;
            END $$;
        `);
        console.log("  ✓ outpass.hostel_std_status added");

        // ─── 2. Add guard_type + hostel_id to guard_devices ────────────────────
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'guard_devices' AND column_name = 'guard_type'
                ) THEN
                    ALTER TABLE guard_devices ADD COLUMN guard_type VARCHAR(20) DEFAULT 'MAIN_GATE'
                        CHECK (guard_type IN ('MAIN_GATE', 'HOSTEL_GATE'));
                END IF;

                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'guard_devices' AND column_name = 'hostel_id'
                ) THEN
                    ALTER TABLE guard_devices ADD COLUMN hostel_id UUID REFERENCES hostel(id) ON DELETE SET NULL;
                END IF;

                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'guard_devices' AND column_name = 'guard_id'
                ) THEN
                    -- guard_id used for FK references in action logs
                    ALTER TABLE guard_devices ADD COLUMN guard_id TEXT GENERATED ALWAYS AS (id) STORED;
                END IF;
            END $$;
        `);
        console.log("  ✓ guard_devices.guard_type and guard_devices.hostel_id added");

        // ─── 3. Add guard_id to guard_action_log if missing ────────────────────
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'guard_action_log' AND column_name = 'guard_id'
                ) THEN
                    ALTER TABLE guard_action_log ADD COLUMN guard_id TEXT REFERENCES guard_devices(id) ON DELETE SET NULL;
                END IF;
            END $$;
        `);

        // ─── 4. Create hostel_visit_log table ───────────────────────────────────
        await client.query(`
            CREATE TABLE IF NOT EXISTS hostel_visit_log (
                id                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                outpass_id         TEXT NOT NULL REFERENCES outpass(id) ON DELETE CASCADE,
                student_id         TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
                hostel_id          UUID REFERENCES hostel(id) ON DELETE SET NULL,
                hostel_exit_time   TIMESTAMPTZ,
                hostel_entry_time  TIMESTAMPTZ,
                exit_guard_id      TEXT REFERENCES guard_devices(id) ON DELETE SET NULL,
                entry_guard_id     TEXT REFERENCES guard_devices(id) ON DELETE SET NULL,
                remark             TEXT,
                auto_exit          BOOLEAN DEFAULT FALSE,
                created_at         TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                updated_at         TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("  ✓ hostel_visit_log table created");

        // ─── 5. Create hostel_guard_action_log table ────────────────────────────
        await client.query(`
            CREATE TABLE IF NOT EXISTS hostel_guard_action_log (
                id              TEXT PRIMARY KEY,
                outpass_id      TEXT NOT NULL,
                action          VARCHAR(20) NOT NULL CHECK (action IN ('hostel_exit', 'hostel_enter')),
                gate            VARCHAR(100) DEFAULT 'Hostel Gate',
                remark          TEXT,
                guard_id        TEXT REFERENCES guard_devices(id) ON DELETE SET NULL,
                actioned_at     TIMESTAMPTZ NOT NULL,
                received_at     TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("  ✓ hostel_guard_action_log table created");

        // ─── 6. Index for faster delta-sync queries ─────────────────────────────
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_outpass_hostel_std_status ON outpass(hostel_std_status);
            CREATE INDEX IF NOT EXISTS idx_hostel_visit_log_outpass ON hostel_visit_log(outpass_id);
            CREATE INDEX IF NOT EXISTS idx_hostel_guard_action_outpass ON hostel_guard_action_log(outpass_id);
        `);
        console.log("  ✓ Indexes created");

        await client.query("COMMIT");
        console.log("\nHostel guard migration completed successfully!");
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Migration failed:", err.message);
        throw err;
    } finally {
        client.release();
        await pool.end();
    }
}

migrateHostelGuard().catch((err) => {
    console.error("Fatal:", err.message);
    process.exitCode = 1;
});
