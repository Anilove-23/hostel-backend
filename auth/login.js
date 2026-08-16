const express = require('express');
const router = express.Router();
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const pool = require("../db/db");
const { generateOtp, sendOtpEmail } = require("./otp");
const {
    getClientIp,
    getRefreshTokenExpiry,
    hashRefreshToken,
    generateRefreshToken,
    generateAccessToken
} = require("../utils/authHelpers");
const { createSession } = require("../utils/sessionService");

router.post("/login", async (req, res) => {
    try {
        const { email, password, role } = req.body;

        // Note: Currently only supporting "student" role logic.
        const userCheck = await pool.query(
            `SELECT s.*, r.room_number AS room_number
             FROM students s
             LEFT JOIN room r ON r.id = s.physical_room_id
             WHERE s.email = $1`,
            [email]
        );
        if (userCheck.rows.length === 0) {
            return res.status(401).json({ success: false, message: "Invalid email or password" });
        }

        const user = userCheck.rows[0];

        // Verify password
        const isValidPassword = await bcrypt.compare(password, user.password);
        if (!isValidPassword) {
            return res.status(401).json({ success: false, message: "Invalid email or password" });
        }

        // Generate and send OTP
        const otp = generateOtp();
        await sendOtpEmail(email, otp);

        const expiresAt = new Date(Date.now() + 5 * 60000);
        const otpId = crypto.randomUUID();
        
        await pool.query(
            "INSERT INTO otp_verification (id, person_id, otp, expires_at) VALUES ($1, $2, $3, $4)",
            [otpId, email, otp, expiresAt]
        );

        return res.status(200).json({ success: true, message: "OTP generated" });
    } catch (err) {
        console.error("Login error:", err);
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
});

router.post("/verify-login-otp", async (req, res) => {
    try {
        const { email, otp, role } = req.body;

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

        // Fetch user data for payload
        const userCheck = await pool.query(
            `SELECT s.*, r.room_number AS room_number
             FROM students s
             LEFT JOIN room r ON r.id = s.physical_room_id
             WHERE s.email = $1`,
            [email]
        );
        const user = userCheck.rows[0];

        // 1. Prepare session details
        const refreshToken = generateRefreshToken();
        const refreshTokenHash = await hashRefreshToken(refreshToken);
        const refreshExpiresAt = new Date(Date.now() + getRefreshTokenExpiry("student"));
        const ipAddress = getClientIp(req);
        const userAgent = req.headers["user-agent"] || null;

        // 2. Create user_session in DB
        const session = await createSession({
            actorId: user.id,
            actorType: "STUDENT",
            ipAddress,
            userAgent,
            role: "student",
            refreshTokenHash,
            refreshExpiresAt,
            machineId: req.body.machineId || null
        });

        // 3. Generate short-lived Access Token containing sessionId
        const accessToken = generateAccessToken({
            id: user.id,
            email: user.email,
            role: "student",
            hostel: user.hostel,
            sessionId: session.id
        });

        // Remove sensitive fields
        delete user.password;
        user.physical_room_id = user.room_number || user.physical_room_id;
        delete user.room_number;

        // Cleanup OTPs
        await pool.query("DELETE FROM otp_verification WHERE person_id = $1", [email]);

        // Optional cookie setting
        res.cookie("token", accessToken, { httpOnly: true, secure: process.env.NODE_ENV === "production" });
        res.cookie("accessToken", accessToken, { httpOnly: true, secure: process.env.NODE_ENV === "production" });
        res.cookie("refreshToken", refreshToken, { httpOnly: true, secure: process.env.NODE_ENV === "production" });

        return res.status(200).json({
            success: true,
            token: accessToken,
            accessToken,
            refreshToken,
            sessionId: session.id,
            user
        });
    } catch (err) {
        console.error("OTP verify error:", err);
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
});

module.exports = router;
