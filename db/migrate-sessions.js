require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const pool = require('./db');

async function migrateSessions() {
    const client = await pool.connect();
    try {
        console.log('🔄 Starting user_session table migration...');
        await client.query('BEGIN');

        // 1. Ensure uuid extension is available
        await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);

        // 2. Create user_session table
        await client.query(`
            CREATE TABLE IF NOT EXISTS user_session (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                actor_id TEXT NOT NULL,
                actor_type VARCHAR(50) NOT NULL,
                role VARCHAR(50),
                login_time TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
                logout_time TIMESTAMP WITH TIME ZONE,
                ip_address VARCHAR(100),
                user_agent TEXT,
                refresh_token_hash TEXT,
                refresh_expires_at TIMESTAMP WITH TIME ZONE,
                is_active BOOLEAN DEFAULT TRUE,
                machine_id VARCHAR(255)
            );
        `);

        // 3. Create helpful indexes
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_user_session_actor_active
            ON user_session(actor_id, actor_type, is_active);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_user_session_id_active
            ON user_session(id, is_active);
        `);

        await client.query('COMMIT');
        console.log('✅ user_session table and indexes created successfully!');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Migration failed:', err);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

migrateSessions();
