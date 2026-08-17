const pool = require("./db");

async function migrateGuardDevices() {
    const client = await pool.connect();
    try {
        console.log("Starting guard_devices migration...");
        await client.query("BEGIN");

        // 1. Create table if not exists
        await client.query(`
            CREATE TABLE IF NOT EXISTS guard_devices(
                id               TEXT PRIMARY KEY,
                device_name      VARCHAR(255) DEFAULT 'Main Gate Terminal',
                phone            VARCHAR(255) UNIQUE NOT NULL,
                gate             VARCHAR(100) DEFAULT 'Main Gate',
                activation_code  VARCHAR(50),
                fingerprint_hash TEXT,
                device_info      JSONB,
                device_token     TEXT,
                status           VARCHAR(50) DEFAULT 'PENDING_ACTIVATION',
                approved_by      TEXT REFERENCES authority(id) ON DELETE SET NULL,
                approved_at      TIMESTAMP,
                last_active_at   TIMESTAMP,
                last_ip          VARCHAR(50),
                created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 2. Add any missing columns to existing guard_devices table
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='guard_devices' AND column_name='device_name') THEN
                    ALTER TABLE guard_devices ADD COLUMN device_name VARCHAR(255) DEFAULT 'Main Gate Terminal';
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='guard_devices' AND column_name='gate') THEN
                    ALTER TABLE guard_devices ADD COLUMN gate VARCHAR(100) DEFAULT 'Main Gate';
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='guard_devices' AND column_name='activation_code') THEN
                    ALTER TABLE guard_devices ADD COLUMN activation_code VARCHAR(50);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='guard_devices' AND column_name='fingerprint_hash') THEN
                    ALTER TABLE guard_devices ADD COLUMN fingerprint_hash TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='guard_devices' AND column_name='device_info') THEN
                    ALTER TABLE guard_devices ADD COLUMN device_info JSONB;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='guard_devices' AND column_name='device_token') THEN
                    ALTER TABLE guard_devices ADD COLUMN device_token TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='guard_devices' AND column_name='approved_by') THEN
                    ALTER TABLE guard_devices ADD COLUMN approved_by TEXT REFERENCES authority(id) ON DELETE SET NULL;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='guard_devices' AND column_name='approved_at') THEN
                    ALTER TABLE guard_devices ADD COLUMN approved_at TIMESTAMP;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='guard_devices' AND column_name='last_active_at') THEN
                    ALTER TABLE guard_devices ADD COLUMN last_active_at TIMESTAMP;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='guard_devices' AND column_name='last_ip') THEN
                    ALTER TABLE guard_devices ADD COLUMN last_ip VARCHAR(50);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='guard_devices' AND column_name='updated_at') THEN
                    ALTER TABLE guard_devices ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
                END IF;
            END $$;
        `);

        // 3. Create guard_device_logs table
        await client.query(`
            CREATE TABLE IF NOT EXISTS guard_device_logs(
                id          TEXT PRIMARY KEY,
                device_id   TEXT REFERENCES guard_devices(id) ON DELETE CASCADE,
                event_type  VARCHAR(50) NOT NULL,
                ip_address  VARCHAR(50),
                details     TEXT,
                created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query("COMMIT");
        console.log("Migration completed successfully!");
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Migration failed:", err);
    } finally {
        client.release();
        process.exit(0);
    }
}

migrateGuardDevices();
