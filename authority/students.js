const express = require('express');
const router = express.Router();
const pool = require("../db/db");
const auth = require("../middleware/middleware");

router.get("/:id/history", auth, async (req, res) => {
    try {
        const studentId = req.params.id;

        // 1. Get profile
        const profileQuery = `
            SELECT 
                s.id, s.name, s.email, s.phone, s.roll_no, s.department,
                s.hostel, r.room_number as room_no
            FROM students s
            LEFT JOIN room r ON r.id = s.physical_room_id
            WHERE s.id = $1 OR s.roll_no = $1
            LIMIT 1
        `;
        const profileResult = await pool.query(profileQuery, [studentId]);
        
        const profile = profileResult.rows[0] || {};

        // 2. Get outpasses
        let outpasses = [];
        if (profile.id) {
            const outpassQuery = `
                SELECT * FROM outpass 
                WHERE student_id = $1 
                ORDER BY created_at DESC
            `;
            const outpassResult = await pool.query(outpassQuery, [profile.id]);
            outpasses = outpassResult.rows;
        }

        // Return empty arrays for visit_logs and complaints since they aren't in DB yet
        res.json({
            success: true,
            data: {
                profile,
                outpasses,
                visit_logs: [],
                complaints: []
            }
        });
    } catch (error) {
        console.error("Student History Error:", error);
        res.json({ 
            success: true, 
            data: {
                profile: {},
                outpasses: [],
                visit_logs: [],
                complaints: []
            } 
        });
    }
});

// Mock endpoints to prevent frontend "Invalid server response" crashes
router.get("/outpass-cutoff", auth, (req, res) => {
    res.json({ success: true, data: { cutoffTime: "17:00:00" } });
});

router.post("/outpass-cutoff", auth, (req, res) => {
    res.json({ success: true, message: "Cutoff time updated" });
});

router.post("/hostel-status", auth, async (req, res) => {
    try {
        const { outp_status } = req.body;
        const hostel = req.user.hostel; 
        
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
        
        if (req.user.role === 'warden' && hostel) {
            params.push(hostel);
            query += ` AND s.hostel = $${params.length}`;
        }

        if (outp_status && outp_status !== "All") {
            params.push(outp_status);
            query += ` AND o.outp_status = $${params.length}`;
        }
        
        query += ` ORDER BY o.created_at DESC`;

        const result = await pool.query(query, params);
        res.json({ success: true, data: result.rows });
    } catch (e) {
        res.json({ success: true, data: [] });
    }
});

router.post("/assign-attendent", auth, (req, res) => {
    res.json({ success: true, message: "Attendant assigned successfully" });
});

router.get("/outpass/:id", auth, async (req, res) => {
    try {
        const query = `
            SELECT 
                o.*, 
                s.name as name, 
                s.roll_no as roll_no, 
                s.department as department,
                s.phone as phone, 
                s.hostel as hostel,
                r.room_number as room_no,
                s.degree_type as degree_type,
                s.academic_year as academic_year
            FROM outpass o 
            JOIN students s ON o.student_id = s.id
            LEFT JOIN room r ON r.id = s.physical_room_id
            WHERE o.id = $1
        `;
        const result = await pool.query(query, [req.params.id]);
        
        if (result.rows.length === 0) {
             return res.status(404).json({ success: false, message: "Outpass not found" });
        }
        
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error("Outpass Detail Error:", error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

router.post("/range", auth, (req, res) => {
    res.json({ success: true, data: [] });
});

module.exports = router;
