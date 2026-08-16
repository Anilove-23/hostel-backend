const express = require('express');
const router = express.Router();
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db/db");
const { findOrCreateHostel, findOrCreateRoom } = require("../db/hostel");
const { generateOtp, sendOtpEmail } = require("./otp");

const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret";

// 1. /send-otp
router.post("/send-otp", async (req, res) => {
    try {
        const { email } = req.body;
        
        // Validation
        if (!email || !email.endsWith("@nith.ac.in")) {
            return res.status(400).json({ success: false, message: "Invalid college email" });
        }

        // Check if user already exists
        const userCheck = await pool.query("SELECT id FROM students WHERE email = $1", [email]);
        if (userCheck.rows.length > 0) {
            return res.status(409).json({ success: false, message: "Account already exists. Please login." });
        }

        // Generate and send OTP
        const otp = generateOtp();
        await sendOtpEmail(email, otp);

        // Store OTP in database
        const expiresAt = new Date(Date.now() + 5 * 60000); // 5 mins from now
        const otpId = crypto.randomUUID();
        
        await pool.query(
            "INSERT INTO otp_verification (id, person_id, otp, expires_at) VALUES ($1, $2, $3, $4)",
            [otpId, email, otp, expiresAt]
        );

        return res.status(200).json({ success: true, message: "OTP sent successfully" });
    } catch (err) {
        console.error("OTP generation error:", err);
        return res.status(500).json({ success: false, message: "Internal Server Error while sending OTP" });
    }
});

// 2. /verify-signup-otp
router.post("/verify-signup-otp", async (req, res) => {
    try {
        const { email, otp } = req.body;

        const otpCheck = await pool.query(
            "SELECT id, expires_at FROM otp_verification WHERE person_id = $1 AND otp = $2 ORDER BY created_at DESC LIMIT 1",
            [email, otp]
        );

        if (otpCheck.rows.length === 0) {
            return res.status(400).json({ success: false, message: "Invalid OTP" });
        }

        const otpRecord = otpCheck.rows[0];
        if (new Date() > new Date(otpRecord.expires_at)) {
            return res.status(400).json({ success: false, message: "OTP has expired" });
        }

        // Mark as verified
        await pool.query(
            "UPDATE otp_verification SET is_verified = true WHERE id = $1",
            [otpRecord.id]
        );

        return res.status(200).json({ success: true, message: "OTP verified" });
    } catch (err) {
        console.error("OTP verification error:", err);
        return res.status(500).json({ success: false, message: "Internal Server Error during OTP verification" });
    }
});

// 3. /signup
router.post("/signup", async (req, res) => {
    try {
        const { name, email, password, phone, hostel, room, department, rollno, degree_type, academic_year } = req.body;

        // Verify that email was verified
        const verifyCheck = await pool.query(
            "SELECT is_verified FROM otp_verification WHERE person_id = $1 ORDER BY created_at DESC LIMIT 1",
            [email]
        );

        if (verifyCheck.rows.length === 0 || !verifyCheck.rows[0].is_verified) {
            return res.status(403).json({ success: false, message: "Email not verified via OTP" });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);
        const studentId = crypto.randomUUID();

        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            const hostelRecord = await findOrCreateHostel(client, { name: hostel });
            if (!hostelRecord) {
                await client.query("ROLLBACK");
                return res.status(400).json({ success: false, message: "A valid hostel is required" });
            }

            // Keep the existing signup flow (users enter a room number) while storing
            // the normalized room UUID required by the new schema.
            const roomRecord = await findOrCreateRoom(client, {
                hostelId: hostelRecord.id,
                roomNumber: room,
            });
            if (!roomRecord) {
                await client.query("ROLLBACK");
                return res.status(400).json({ success: false, message: "A valid room number is required" });
            }

            await client.query(
                `INSERT INTO students
                (id, name, email, password, phone, hostel, hostel_id, physical_room_id, department, roll_no, degree_type, academic_year)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                [studentId, name, email, hashedPassword, phone, hostelRecord.name, hostelRecord.id, roomRecord.id, department, rollno, degree_type, academic_year]
            );

            await client.query("COMMIT");
            return res.status(201).json({ 
                success: true, 
                message: "Signup successful. Please login.",
                user: { id: studentId, email, name, role: "student" }
            });
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error("Signup error:", err);
        // Handle unique constraint errors (e.g. roll_no already exists)
        if (err.code === '23505') {
             return res.status(400).json({ success: false, message: "Roll number or email already in use." });
        }
        return res.status(500).json({ success: false, message: "Internal Server Error during signup" });
    }
});

module.exports = router;
