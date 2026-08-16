const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const pool = require("../db/db");
const auth = require("../middleware/middleware"); // Middleware to verify student token

// POST /api/outpass/create
router.post("/create", auth, async (req, res) => {
    try {
        const {
            outpass_type,
            place_of_visit,
            purpose,
            departure_datetime,
            arrival_datetime,
            parent_contact,
            is_emergency = false
        } = req.body;

        // Note: req.user comes from the auth middleware
        const studentId = req.user?.id;

        if (!studentId) {
            return res.status(401).json({ success: false, message: "Unauthorized" });
        }

        if (!outpass_type || !parent_contact || !purpose || !departure_datetime || !arrival_datetime) {
            return res.status(400).json({ success: false, message: "Required fields are missing" });
        }

        // Generate UUID for the outpass
        const outpassId = crypto.randomUUID();

        // Format to match DB constraint exactly
        const validTypes = ["Home", "Local", "Outstation"];
        const normalizedType = outpass_type.charAt(0).toUpperCase() + outpass_type.slice(1).toLowerCase();
        
        if (!validTypes.includes(normalizedType)) {
            return res.status(400).json({ success: false, message: "Invalid outpass type" });
        }

        const query = `
            INSERT INTO outpass (
                id, student_id, outpass_type, place_of_visit, purpose, 
                departure_datetime, arrival_datetime, parent_contact, 
                outp_status, std_status, is_emergency
            ) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Pending', 'In', $9)
            RETURNING *, outp_status as status;
        `;

        const values = [
            outpassId, studentId, normalizedType, place_of_visit || null, purpose,
            departure_datetime, arrival_datetime, parent_contact, is_emergency
        ];

        const result = await pool.query(query, values);

        return res.status(201).json({
            success: true,
            message: "Outpass created successfully",
            data: result.rows[0]
        });

    } catch (err) {
        console.error("Create outpass error:", err);
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
});


// GET /api/outpass/me
router.get("/me", auth, async (req, res) => {
    try {
        const studentId = req.user?.id;
        if (!studentId) {
            return res.status(401).json({ success: false, message: "Unauthorized" });
        }

        const query = `
            SELECT *, outp_status as status FROM outpass 
            WHERE student_id = $1 
            ORDER BY created_at DESC;
        `;

        const result = await pool.query(query, [studentId]);

        return res.status(200).json({
            success: true,
            data: result.rows
        });

    } catch (err) {
        console.error("Get outpasses error:", err);
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
});


// PUT /api/outpass/:id/cancel
router.put("/:id/cancel", auth, async (req, res) => {
    try {
        const studentId = req.user?.id;
        const outpassId = req.params.id;

        if (!studentId) {
            return res.status(401).json({ success: false, message: "Unauthorized" });
        }

        // Check if outpass exists and is pending
        const checkQuery = `SELECT outp_status as status FROM outpass WHERE id = $1 AND student_id = $2`;
        const checkResult = await pool.query(checkQuery, [outpassId, studentId]);

        if (checkResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Outpass not found" });
        }

        if (checkResult.rows[0].status !== 'Pending') {
            return res.status(400).json({ success: false, message: "Only Pending outpasses can be cancelled" });
        }

        // Update status to Cancelled
        const updateQuery = `
            UPDATE outpass 
            SET outp_status = 'Cancelled', updated_at = CURRENT_TIMESTAMP 
            WHERE id = $1 AND student_id = $2 
            RETURNING *, outp_status as status;
        `;

        const updateResult = await pool.query(updateQuery, [outpassId, studentId]);

        return res.status(200).json({
            success: true,
            message: "Outpass cancelled successfully",
            data: updateResult.rows[0]
        });

    } catch (err) {
        console.error("Cancel outpass error:", err);
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
});

module.exports = router;
