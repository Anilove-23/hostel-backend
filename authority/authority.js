const express = require('express');
const router = express.Router();
const pool = require("../db/db");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const authenticateAdmin = require("../middleware/middleware");
const { findOrCreateHostel } = require("../db/hostel");

// ==========================================
// 1. WARDENS MANAGEMENT (Chief Warden Only)
// ==========================================

// GET all wardens
router.get("/wardens", authenticateAdmin, async (req, res) => {
    try {
        if (req.user.role !== "chief-warden") {
            return res.status(403).json({ success: false, message: "Unauthorized" });
        }
        
        const result = await pool.query("SELECT id, name, email, phone, hostel, hostel_id, status, approved_by, created_at FROM authority WHERE status = 'warden' ORDER BY created_at DESC");
        res.json({ success: true, wardens: result.rows });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// POST allot a warden
router.post("/wardens", authenticateAdmin, async (req, res) => {
    try {
        if (req.user.role !== "chief-warden") {
            return res.status(403).json({ success: false, message: "Unauthorized" });
        }

        const { name, email, password, phone, hostel, hostel_id } = req.body;
        
        if (!name || !email || !password || !phone || !hostel || !hostel_id) {
            return res.status(400).json({ success: false, message: "All fields are required" });
        }

        // Hash the password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const id = crypto.randomUUID();
        const hostelRecord = await findOrCreateHostel(pool, { name: hostel, id: hostel_id });
        if (!hostelRecord) {
            return res.status(400).json({ success: false, message: "A valid hostel is required" });
        }

        await pool.query(
            "INSERT INTO authority (id, name, email, password, phone, hostel, hostel_id, status, approved_by) VALUES ($1, $2, $3, $4, $5, $6, $7, 'warden', true)",
            [id, name, email, hashedPassword, phone, hostelRecord.name, hostelRecord.id]
        );

        res.json({ success: true, message: "Warden allotted successfully" });
    } catch (error) {
        console.error(error);
        if (error.code === '23505') { // Unique violation
            return res.status(400).json({ success: false, message: "Email already exists" });
        }
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// DELETE revoke a warden
router.delete("/wardens/:id", authenticateAdmin, async (req, res) => {
    try {
        if (req.user.role !== "chief-warden") {
            return res.status(403).json({ success: false, message: "Unauthorized" });
        }
        
        await pool.query("DELETE FROM authority WHERE id = $1 AND status = 'warden'", [req.params.id]);
        res.json({ success: true, message: "Warden removed" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// PATCH toggle warden approval
router.patch("/wardens/:id/toggle-approval", authenticateAdmin, async (req, res) => {
    try {
        if (req.user.role !== "chief-warden") {
            return res.status(403).json({ success: false, message: "Unauthorized" });
        }
        
        const { approved_by } = req.body;
        await pool.query("UPDATE authority SET approved_by = $1 WHERE id = $2 AND status = 'warden'", [approved_by, req.params.id]);
        res.json({ success: true, message: "Warden approval status updated" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// ==========================================
// 2. ATTENDANTS MANAGEMENT (Warden Only)
// ==========================================

// GET all attendants for Warden's hostel
router.get("/attendants", authenticateAdmin, async (req, res) => {
    try {
        if (req.user.role !== "warden" && req.user.role !== "chief-warden") {
            return res.status(403).json({ success: false, message: "Unauthorized" });
        }
        
        let query = "SELECT id, name, email, phone, hostel, hostel_id, status, approved_by, created_at FROM authority WHERE status = 'attendent'";
        let params = [];
        
        if (req.user.role === "warden") {
            query += " AND hostel = $1";
            params.push(req.user.hostel);
        }
        
        query += " ORDER BY created_at DESC";
        
        const result = await pool.query(query, params);
        res.json({ success: true, attendants: result.rows });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// POST allot an attendant
router.post("/attendants", authenticateAdmin, async (req, res) => {
    try {
        if (req.user.role !== "warden" && req.user.role !== "chief-warden") {
            return res.status(403).json({ success: false, message: "Unauthorized" });
        }

        const { name, email, password, phone, hostel, hostel_id } = req.body;
        
        if (!name || !email || !password || !phone || !hostel || !hostel_id) {
            return res.status(400).json({ success: false, message: "All fields are required" });
        }

        if (req.user.role === "warden" && req.user.hostel !== hostel) {
             return res.status(403).json({ success: false, message: "Cannot assign to a different hostel" });
        }

        // Hash the password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const id = crypto.randomUUID();
        const hostelRecord = await findOrCreateHostel(pool, { name: hostel, id: hostel_id });
        if (!hostelRecord) {
            return res.status(400).json({ success: false, message: "A valid hostel is required" });
        }

        await pool.query(
            "INSERT INTO authority (id, name, email, password, phone, hostel, hostel_id, status, approved_by) VALUES ($1, $2, $3, $4, $5, $6, $7, 'attendent', true)",
            [id, name, email, hashedPassword, phone, hostelRecord.name, hostelRecord.id]
        );

        res.json({ success: true, message: "Attendant allotted successfully" });
    } catch (error) {
        console.error(error);
        if (error.code === '23505') { // Unique violation
            return res.status(400).json({ success: false, message: "Email already exists" });
        }
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// DELETE revoke an attendant
router.delete("/attendants/:id", authenticateAdmin, async (req, res) => {
    try {
        if (req.user.role !== "warden" && req.user.role !== "chief-warden") {
            return res.status(403).json({ success: false, message: "Unauthorized" });
        }

        let query = "DELETE FROM authority WHERE id = $1 AND status = 'attendent'";
        let params = [req.params.id];

        if (req.user.role === "warden") {
             query += " AND hostel = $2";
             params.push(req.user.hostel);
        }

        const result = await pool.query(query, params);
        if (result.rowCount === 0) {
             return res.status(404).json({ success: false, message: "Attendant not found or permission denied" });
        }
        res.json({ success: true, message: "Attendant removed" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// ==========================================
// 3. GUARD DEVICES MANAGEMENT
// ==========================================

// Helper function to generate clean 6-character activation code
function generateActivationCode() {
    const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // Avoid ambiguous chars 0/O, 1/I
    let code = "GD-";
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// GET all guard devices
router.get("/devices", authenticateAdmin, async (req, res) => {
    try {
        if (req.user.role !== "chief-warden") {
            return res.status(403).json({ success: false, message: "Unauthorized" });
        }
        
        const result = await pool.query(`
            SELECT 
                d.id,
                d.device_name,
                d.phone,
                d.gate,
                d.activation_code,
                d.fingerprint_hash,
                d.device_info,
                d.status,
                d.approved_at,
                d.last_active_at,
                d.last_ip,
                d.created_at,
                d.updated_at,
                a.name AS approved_by_name
            FROM guard_devices d
            LEFT JOIN authority a ON d.approved_by = a.id
            ORDER BY d.created_at DESC
        `);
        res.json({ success: true, devices: result.rows });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// POST add a guard device
router.post("/devices", authenticateAdmin, async (req, res) => {
    try {
        if (req.user.role !== "chief-warden") {
            return res.status(403).json({ success: false, message: "Unauthorized" });
        }

        const { phone, device_name, gate } = req.body;
        if (!phone) {
            return res.status(400).json({ success: false, message: "Phone number is required" });
        }

        const id = crypto.randomUUID();
        const activationCode = generateActivationCode();
        const deviceName = device_name || "Main Gate Terminal";
        const gateLocation = gate || "Main Gate";

        await pool.query(
            `INSERT INTO guard_devices 
             (id, phone, device_name, gate, activation_code, status, approved_by, approved_at) 
             VALUES ($1, $2, $3, $4, $5, 'PENDING_ACTIVATION', $6, CURRENT_TIMESTAMP)`,
            [id, phone.trim(), deviceName.trim(), gateLocation.trim(), activationCode, req.user.id]
        );

        // Add log
        await pool.query(
            "INSERT INTO guard_device_logs (id, device_id, event_type, details) VALUES ($1, $2, 'DEVICE_REGISTERED', $3)",
            [crypto.randomUUID(), id, `Registered by Chief Warden ${req.user.name || req.user.id}`]
        );

        res.json({ 
            success: true, 
            message: "Guard device registered successfully", 
            activation_code: activationCode,
            device_id: id 
        });
    } catch (error) {
        console.error(error);
        if (error.code === '23505') {
            return res.status(400).json({ success: false, message: "Phone number is already registered" });
        }
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// POST reset device binding (for replacement phone/browser)
router.post("/devices/:id/reset", authenticateAdmin, async (req, res) => {
    try {
        if (req.user.role !== "chief-warden") {
            return res.status(403).json({ success: false, message: "Unauthorized" });
        }

        const newActivationCode = generateActivationCode();

        const result = await pool.query(
            `UPDATE guard_devices 
             SET fingerprint_hash = NULL,
                 device_info = NULL,
                 device_token = NULL,
                 activation_code = $1,
                 status = 'PENDING_ACTIVATION',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2
             RETURNING *`,
            [newActivationCode, req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Device not found" });
        }

        await pool.query(
            "INSERT INTO guard_device_logs (id, device_id, event_type, details) VALUES ($1, $2, 'DEVICE_RESET', $3)",
            [crypto.randomUUID(), req.params.id, `Device binding reset by Chief Warden ${req.user.name || req.user.id}. New code generated.`]
        );

        res.json({ 
            success: true, 
            message: "Device binding reset! Provide the new activation code to the guard.", 
            activation_code: newActivationCode 
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// PATCH toggle device status (ACTIVE <-> REVOKED)
router.patch("/devices/:id/status", authenticateAdmin, async (req, res) => {
    try {
        if (req.user.role !== "chief-warden") {
            return res.status(403).json({ success: false, message: "Unauthorized" });
        }

        const { status } = req.body;
        if (!status || !["ACTIVE", "REVOKED", "BLOCKED", "PENDING_ACTIVATION"].includes(status)) {
            return res.status(400).json({ success: false, message: "Invalid status" });
        }

        const result = await pool.query(
            `UPDATE guard_devices 
             SET status = $1, updated_at = CURRENT_TIMESTAMP 
             WHERE id = $2 
             RETURNING *`,
            [status, req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Device not found" });
        }

        await pool.query(
            "INSERT INTO guard_device_logs (id, device_id, event_type, details) VALUES ($1, $2, 'STATUS_CHANGED', $3)",
            [crypto.randomUUID(), req.params.id, `Status changed to ${status} by Chief Warden`]
        );

        res.json({ success: true, message: `Device status updated to ${status}`, device: result.rows[0] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// GET device logs
router.get("/devices/:id/logs", authenticateAdmin, async (req, res) => {
    try {
        if (req.user.role !== "chief-warden") {
            return res.status(403).json({ success: false, message: "Unauthorized" });
        }

        const result = await pool.query(
            "SELECT * FROM guard_device_logs WHERE device_id = $1 ORDER BY created_at DESC LIMIT 50",
            [req.params.id]
        );

        res.json({ success: true, logs: result.rows });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// DELETE remove a guard device
router.delete("/devices/:id", authenticateAdmin, async (req, res) => {
    try {
        if (req.user.role !== "chief-warden") {
            return res.status(403).json({ success: false, message: "Unauthorized" });
        }

        await pool.query("DELETE FROM guard_devices WHERE id = $1", [req.params.id]);
        res.json({ success: true, message: "Guard device removed" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// PATCH toggle attendant approval
router.patch("/attendants/:id/toggle-approval", authenticateAdmin, async (req, res) => {
    try {
        if (req.user.role !== "warden" && req.user.role !== "chief-warden") {
            return res.status(403).json({ success: false, message: "Unauthorized" });
        }
        
        const { approved_by } = req.body;
        // Wardens can only toggle attendants in their own hostel
        if (req.user.role === "warden") {
            await pool.query("UPDATE authority SET approved_by = $1 WHERE id = $2 AND status = 'attendent' AND hostel = $3", [approved_by, req.params.id, req.user.hostel]);
        } else {
            await pool.query("UPDATE authority SET approved_by = $1 WHERE id = $2 AND status = 'attendent'", [approved_by, req.params.id]);
        }
        
        res.json({ success: true, message: "Attendant approval status updated" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});
router.get("/outpass-cutoff", authenticateAdmin, async (req, res) => {
    try {
        if (req.user.role !== "warden") {
            return res.status(403).json({
                success: false,
                message: "Only wardens can access outpass cutoff."
            });
        }

        const result = await pool.query(
            `
            SELECT
                h.id,
                h.name,
                h.local_outpass_cutoff
            FROM authority a
            JOIN hostel h
                ON h.id = a.hostel_id
            WHERE a.id = $1
              AND a.status = 'warden'
            LIMIT 1
            `,
            [req.user.id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({
                success: false,
                message: "Warden or hostel not found."
            });
        }

        return res.status(200).json({
            success: true,
            data: {
                cutoffTime: result.rows[0].local_outpass_cutoff,
                hostel: result.rows[0].name
            },
            message: "Outpass submission deadline fetched successfully."
        });
    } catch (error) {
        console.error("Get outpass cutoff error:", error);

        return res.status(500).json({
            success: false,
            message: "Server Error"
        });
    }
});

router.patch("/outpass-cutoff", authenticateAdmin, async (req, res) => {
    try {
        if (req.user.role !== "warden") {
            return res.status(403).json({
                success: false,
                message: "Only wardens can update outpass cutoff."
            });
        }

        const { cutoffTime } = req.body;

        if (!cutoffTime) {
            return res.status(400).json({
                success: false,
                message: "Cutoff time is required."
            });
        }

        const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

        if (!timeRegex.test(cutoffTime)) {
            return res.status(400).json({
                success: false,
                message: "Invalid time format. Expected HH:MM or HH:MM:SS."
            });
        }

        const result = await pool.query(
            `
            UPDATE hostel h
            SET local_outpass_cutoff = $1
            FROM authority a
            WHERE a.id = $2
              AND a.status = 'warden'
              AND h.id = a.hostel_id
            RETURNING h.id, h.name, h.local_outpass_cutoff
            `,
            [cutoffTime, req.user.id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({
                success: false,
                message: "Warden or hostel not found."
            });
        }

        return res.status(200).json({
            success: true,
            data: {
                cutoffTime: result.rows[0].local_outpass_cutoff,
                hostel: result.rows[0].name
            },
            message: "Outpass submission deadline updated successfully."
        });
    } catch (error) {
        console.error("Update outpass cutoff error:", error);

        return res.status(500).json({
            success: false,
            message: "Server Error"
        });
    }
});
module.exports = router;
