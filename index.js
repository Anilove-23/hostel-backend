const express = require("express");
require("dotenv").config();
const cors = require("cors");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");

const signup = require("./auth/sigup.js");
const login = require("./auth/login.js");
const loginAuthority = require("./auth/login-authority.js");
const refresh = require("./auth/refresh.js");
const logout = require("./auth/logout.js");
const management = require("./authority/authority.js");
const dashboard = require("./authority/dashboard.js");
const students = require("./authority/students.js");
const chiefWarden = require("./authority/chiefWarden.js");
const outpass = require("./outpass/outpass.js");
const guard = require("./guard/guard.js");
const pool = require("./db/db");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Authentication routes
app.use("/api/auth", signup);
app.use("/api/auth", login);
app.use("/api/auth", refresh);
app.use("/api/auth", logout);
app.use("/api/authority", loginAuthority);
app.use("/api/authority", refresh);
app.use("/api/authority", logout);

// Role management routes
app.use("/api/management", management);

// Chief warden routes
app.use("/api/chief-warden", chiefWarden);

// Student outpass routes
app.use("/api/outpass", outpass);

// Authority & monitor outpass routes
app.use("/api/outpasses", dashboard);
app.use("/api/outpass", dashboard); // Alias to support single-path frontends

// Student and warden student management routes
app.use("/api/students", students);

// Guard routes
app.use("/api/guard", guard);

// Hostels & helper routes
app.get("/api/hostels", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT id, name, type, total_capacity, local_outpass_cutoff FROM hostel ORDER BY name ASC"
        );
        res.json({ success: true, hostels: result.rows });
    } catch (error) {
        console.error("Hostel list error:", error);
        res.status(500).json({ success: false, hostels: [] });
    }
});

// Mock endpoints to prevent frontend crashes
app.get("/complaint/all", (req, res) => res.json({ data: [] }));
app.get("/complaint/escalated", (req, res) => res.json({ data: [] }));

app.get("/", (req, res) => {
    res.json({ success: true, message: "Hostel Backend is running smoothly!" });
});

// Global Error Handler Middleware
app.use((err, req, res, next) => {
    const statusCode = err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    if (statusCode >= 500) {
        console.error("[SERVER ERROR]:", err);
    }

    return res.status(statusCode).json({
        statusCode,
        success: false,
        message,
        errors: err.errors || []
    });
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}

module.exports = app;
