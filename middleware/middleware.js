const jwt = require("jsonwebtoken");
require("dotenv").config();

const JWT_SECRET = process.env.JWT_SECRET || "default_secret";

module.exports = function auth(req, res, next) {
    let token = req.cookies?.token;
    const authHeader = req.headers.authorization || "";

    if (!token && authHeader.startsWith("Bearer ")) {
        token = authHeader.slice(7).trim();
    } else if (!token && req.headers.token) {
        token = req.headers.token;
    }

    if (!token) {
        return res.status(401).json({
            statusCode: 401,
            success: false,
            message: "Authentication token is required"
        });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({
            statusCode: 401,
            success: false,
            message: "Invalid or expired token"
        });
    }
};