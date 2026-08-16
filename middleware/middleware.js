const jwt = require("jsonwebtoken");
require("dotenv").config();
const { findSessionById } = require("../utils/sessionService");

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    throw new Error('FATAL: JWT_SECRET environment variable is not defined.');
}

module.exports = async function auth(req, res, next) {
    let token = req.cookies?.accessToken || req.cookies?.token;
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

        // If the JWT contains a sessionId, enforce database session validity
        if (decoded.sessionId) {
            const session = await findSessionById(decoded.sessionId);
            if (!session || !session.is_active) {
                return res.status(401).json({
                    statusCode: 401,
                    success: false,
                    message: "Your session has expired or been revoked. Please log in again."
                });
            }
            req.session = session;
        }

        req.user = decoded;
        return next();
    } catch (err) {
        return res.status(401).json({
            statusCode: 401,
            success: false,
            message: "Invalid or expired token"
        });
    }
};