const express = require("express");
const router = express.Router();
const pool = require("../db/db");

// ─── GET /api/guard/monitor ─────────────────────────────────
// Fetch all approved outpasses for guard terminal (with delta sync support)
router.get("/monitor", async (req, res) => {
    try {
        let query = `
            SELECT 
                o.*, 
                s.name       AS name, 
                s.roll_no    AS roll_no, 
                s.department AS department,
                s.phone      AS phone, 
                s.hostel     AS hostel,
                s.physical_room_id AS room,
                s.parent_number    AS parent_contact,
                s.degree_type      AS degree_type
            FROM outpass o 
            JOIN students s ON o.student_id = s.id
            WHERE o.outp_status = 'Approved'
        `;
        
        const params = [];
        
        // Optional delta sync — only return records updated since last sync
        if (req.query.updated_since) {
            query += ` AND o.updated_at >= $1`;
            params.push(req.query.updated_since);
            // Also flag this response as a delta so the client does an upsert
            // instead of replacing the whole cache
            query += ` ORDER BY o.created_at DESC`;
            const result = await pool.query(query, params);
            return res.json({
                success: true,
                delta: true,
                data: result.rows,
                server_time: new Date().toISOString()
            });
        }

        query += ` ORDER BY o.created_at DESC`;

        const result = await pool.query(query, params);
        res.json({ success: true, data: result.rows, server_time: new Date().toISOString() });
    } catch (error) {
        console.error("Guard Monitor Error:", error);
        res.status(500).json({ success: false, data: [] });
    }
});

// ─── POST /api/guard/sync-logs ──────────────────────────────
// Receive offline action logs from guard terminal and apply them to the DB.
// Frontend sends: { action: 'exit' | 'enter', outpass_id, timestamp, ... }
// 'exit'  → student leaving campus  → std_status = 'Out'
// 'enter' → student returning       → std_status = 'In'
router.post("/sync-logs", async (req, res) => {
    try {
        const { logs } = req.body;
        if (!logs || !Array.isArray(logs)) {
            return res.status(400).json({ success: false, message: "Logs array required" });
        }

        const synced_ids = [];
        const failed_ids = [];

        for (const log of logs) {
            try {
                const { id, outpass_id, action, timestamp } = log;
                
                if (action === 'exit') {
                    // Student leaving — mark as Out, record departure
                    await pool.query(
                        `UPDATE outpass 
                         SET std_status = 'Out', departure_datetime = $1, updated_at = NOW() 
                         WHERE id = $2`,
                        [timestamp, outpass_id]
                    );
                } else if (action === 'enter') {
                    // Student returning — mark as In, record arrival
                    await pool.query(
                        `UPDATE outpass 
                         SET std_status = 'In', arrival_datetime = $1, updated_at = NOW() 
                         WHERE id = $2`,
                        [timestamp, outpass_id]
                    );
                }
                
                synced_ids.push(id);
            } catch (err) {
                console.error("Failed to sync log:", log.id, err.message);
                failed_ids.push(log.id);
            }
        }

        res.json({ success: true, data: { synced_ids, failed_ids } });
    } catch (error) {
        console.error("Sync Logs Error:", error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// ─── GET /api/guard/dayscholar ──────────────────────────────
// Get all day scholars
router.get("/dayscholar", async (req, res) => {
    try {
        const scholars = await pool.query(
            `SELECT * FROM day_scholar ORDER BY name ASC`
        );
        res.status(200).json(scholars.rows);
    } catch (err) {
        console.error("Error fetching day scholars:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// ─── GET /api/guard/dayscholar/logs ────────────────────────
// Get day scholar movement logs
router.get("/dayscholar/logs", async (req, res) => {
    try {
        const logs = await pool.query(`
            SELECT 
                l.*,
                ds.name    AS scholar_name,
                ds.roll_no AS scholar_roll_no
            FROM day_scholar_log l
            JOIN day_scholar ds ON l.day_scholar_id = ds.id
            ORDER BY l.timestamp DESC
            LIMIT 100
        `);
        res.status(200).json(logs.rows);
    } catch (err) {
        console.error("Error fetching day scholar logs:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// ─── POST /api/guard/dayscholar/log ────────────────────────
// Mark day scholar ENTRY or EXIT
router.post("/dayscholar/log", async (req, res) => {
    const { scholar_id, direction } = req.body;
    
    if (!scholar_id || !direction || !['ENTRY', 'EXIT'].includes(direction)) {
        return res.status(400).json({ error: "Invalid request data. direction must be ENTRY or EXIT." });
    }

    try {
        const newLog = await pool.query(`
            INSERT INTO day_scholar_log (id, day_scholar_id, direction, gate)
            VALUES (gen_random_uuid()::text, $1, $2, $3)
            RETURNING *
        `, [scholar_id, direction, "Main Gate"]);
        
        res.status(201).json(newLog.rows[0]);
    } catch (err) {
        console.error("Error creating day scholar log:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// ─── POST /api/guard/dayscholar ────────────────────────────
// Add a new day scholar
router.post("/dayscholar", async (req, res) => {
    const { name, roll_no, degree_type, phone } = req.body;

    if (!name || !roll_no) {
        return res.status(400).json({ error: "Name and roll_no are required" });
    }

    try {
        const newScholar = await pool.query(`
            INSERT INTO day_scholar (id, name, roll_no, degree_type, phone)
            VALUES (gen_random_uuid(), $1, $2, $3, $4)
            RETURNING *
        `, [name, roll_no, degree_type, phone]);

        res.status(201).json(newScholar.rows[0]);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ error: "Roll number already exists" });
        }
        console.error("Error creating day scholar:", err);
        res.status(500).json({ error: "Server error" });
    }
});

module.exports = router;