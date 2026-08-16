const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const pool = require("../db/db");
const auth = require("../middleware/middleware");

router.get("/monitor", auth, async (req, res) => {
    try {
        let query = `
            SELECT 
                o.*, 
                s.name as name, 
                s.roll_no as roll_no, 
                s.department as department,
                s.phone as phone, 
                s.hostel as hostel,
                r.room_number as room_no
            FROM outpass o 
            JOIN students s ON o.student_id = s.id
            LEFT JOIN room r ON r.id = s.physical_room_id
            WHERE 1=1
        `;
        let params = [];

        let targetHostel = req.query.hostel;
        if (req.user.role === 'warden' || req.user.role === 'attendent') {
            targetHostel = req.user.hostel;
        }

        if (targetHostel && targetHostel !== 'All') {
            params.push(targetHostel);
            query += ` AND s.hostel = $1`;
        }

        query += ` ORDER BY o.created_at DESC`;

        const result = await pool.query(query, params);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("Monitor Error:", error);
        res.json({ success: true, data: [] });
    }
});

router.get("/late-returns", auth, async (req, res) => {
    try {
        let query = `
            SELECT 
                o.*, 
                s.name as name, 
                s.roll_no as roll_no, 
                s.department as department,
                s.phone as phone, 
                s.hostel as hostel
            FROM outpass o 
            JOIN students s ON o.student_id = s.id
            WHERE o.std_status = 'Out' AND o.arrival_datetime < NOW()
        `;
        let params = [];

        let targetHostel = req.query.hostel;
        if (req.user.role === 'warden' || req.user.role === 'attendent') {
            targetHostel = req.user.hostel;
        }

        if (targetHostel && targetHostel !== 'All') {
            params.push(targetHostel);
            query += ` AND s.hostel = $1`;
        }

        query += ` ORDER BY o.arrival_datetime ASC`;

        const result = await pool.query(query, params);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("Late Returns Error:", error);
        res.json({ success: true, data: [] });
    }
});

async function addRemark(client, outpassId, user, remarkText) {
    if (!remarkText || !remarkText.trim()) return;
    const remarkId = crypto.randomUUID();

    let adminRole = 'ATTENDANT';
    const rawRole = (user.status || user.role || '').toUpperCase();
    if (rawRole.includes('WARDEN')) adminRole = 'CHIEF_WARDEN';
    else if (rawRole === 'GUARD') adminRole = 'GUARD';
    else if (rawRole === 'SYSTEM') adminRole = 'SYSTEM';

    await client.query(`
        INSERT INTO outpass_remarks (id, outpass_id, admin_id, admin_role, remark)
        VALUES ($1, $2, $3, $4, $5)
    `, [remarkId, outpassId, user.id, adminRole, remarkText.trim()]);
}

router.patch("/approve/:id", auth, async (req, res) => {
    try {
        const outpassId = req.params.id;
        const { remark } = req.body;
        
        if (req.user.role === 'warden' || req.user.role === 'attendent') {
            const check = await pool.query(
                "SELECT s.hostel FROM outpass o JOIN students s ON o.student_id = s.id WHERE o.id = $1",
                [outpassId]
            );
            if (check.rows.length === 0 || check.rows[0].hostel !== req.user.hostel) {
                return res.status(403).json({ success: false, message: "Unauthorized to approve for this hostel" });
            }
        }

        await pool.query(
            "UPDATE outpass SET outp_status = 'Approved', approved_by = $1, approved_at = NOW(), updated_at = NOW() WHERE id = $2",
            [req.user.id, outpassId]
        );
        
        await addRemark(pool, outpassId, req.user, remark);

        res.json({ success: true, message: "Outpass approved" });
    } catch (error) {
        console.error("Approve Error:", error);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

router.patch("/reject/:id", auth, async (req, res) => {
    try {
        const outpassId = req.params.id;
        const { remark } = req.body;
        
        if (req.user.role === 'warden' || req.user.role === 'attendent') {
            const check = await pool.query(
                "SELECT s.hostel FROM outpass o JOIN students s ON o.student_id = s.id WHERE o.id = $1",
                [outpassId]
            );
            if (check.rows.length === 0 || check.rows[0].hostel !== req.user.hostel) {
                return res.status(403).json({ success: false, message: "Unauthorized to reject for this hostel" });
            }
        }

        await pool.query(
            "UPDATE outpass SET outp_status = 'Rejected', is_active = false, updated_at = NOW() WHERE id = $1",
            [outpassId]
        );
        
        await addRemark(pool, outpassId, req.user, remark);

        res.json({ success: true, message: "Outpass rejected" });
    } catch (error) {
        console.error("Reject Error:", error);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

router.patch("/bulk-action", auth, async (req, res) => {
    try {
        const { ids, action, remark } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, message: "No IDs provided" });
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            for (const outpassId of ids) {
                if (req.user.role === 'warden' || req.user.role === 'attendent') {
                    const check = await client.query(
                        "SELECT s.hostel FROM outpass o JOIN students s ON o.student_id = s.id WHERE o.id = $1",
                        [outpassId]
                    );
                    if (check.rows.length === 0 || check.rows[0].hostel !== req.user.hostel) {
                        throw new Error("Unauthorized hostel access");
                    }
                }
                
                if (action === "approve") {
                    await client.query(
                        "UPDATE outpass SET outp_status = 'Approved', approved_by = $1, approved_at = NOW(), updated_at = NOW() WHERE id = $2",
                        [req.user.id, outpassId]
                    );
                } else if (action === "reject") {
                    await client.query(
                        "UPDATE outpass SET outp_status = 'Rejected', is_active = false, updated_at = NOW() WHERE id = $1",
                        [outpassId]
                    );
                }
                await addRemark(client, outpassId, req.user, remark);
            }
            await client.query("COMMIT");
            res.json({ success: true, message: "Bulk action successful" });
        } catch (e) {
            await client.query("ROLLBACK");
            throw e;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error("Bulk Action Error:", error);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

router.get("/:id/remarks", auth, async (req, res) => {
    try {
        const outpassId = req.params.id;
        const result = await pool.query(
            `SELECT r.id, r.outpass_id, r.remark, r.created_at,
                    r.admin_id as author_id, 
                    r.admin_role as author_role,
                    COALESCE(a.name, 'System') as author_name
             FROM outpass_remarks r
             LEFT JOIN authority a ON r.admin_id = a.id
             WHERE r.outpass_id = $1 
             ORDER BY r.created_at ASC`,
            [outpassId]
        );
        res.json({ success: true, remarks: result.rows });
    } catch (error) {
        console.error("Remarks Error:", error);
        res.json({ success: true, remarks: [] });
    }
});

module.exports = router;
