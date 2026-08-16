const express = require('express');
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db/db");

const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret";

router.post("/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        const authCheck = await pool.query("SELECT * FROM authority WHERE email = $1", [email]);
        if (authCheck.rows.length === 0) {
            return res.status(401).json({ success: false, message: "Invalid email or password" });
        }

        const user = authCheck.rows[0];

        // Verify password (assuming it's stored as plain text for now, but using bcrypt just in case)
        let isValidPassword = false;
        
        // If password in DB is hashed, use bcrypt. If it's plain text (like some seeded data), check directly.
        if (user.password.startsWith('$2a$') || user.password.startsWith('$2b$')) {
            isValidPassword = await bcrypt.compare(password, user.password);
        } else {
            isValidPassword = (password === user.password);
        }

        if (!isValidPassword) {
            return res.status(401).json({ success: false, message: "Invalid email or password" });
        }

        // Check if approved (chief-wardens are always approved)
        const normalizedRole = user.status.toLowerCase().replace(/[\s_]+/g, "-");
        
        if (normalizedRole !== 'chief-warden' && !user.approved_by) {
            return res.status(403).json({ success: false, message: "Account not approved by admin yet." });
        }

        // Generate JWT
        const token = jwt.sign(
            { id: user.id, email: user.email, role: normalizedRole, hostel: user.hostel, status: normalizedRole },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        delete user.password;
        
        // Ensure the frontend receives the normalized role
        user.status = normalizedRole;
        user.role = normalizedRole;

        return res.status(200).json({ success: true, token, user });
    } catch (err) {
        console.error("Authority login error:", err);
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
});

module.exports = router;