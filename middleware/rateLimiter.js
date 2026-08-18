const rateLimit = require("express-rate-limit");

// Limiter for OTP send requests (prevents email spamming and quota exhaustion)
const otpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // Max 5 OTP requests per window per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        statusCode: 429,
        message: "Too many OTP requests from this IP. Please try again after 15 minutes."
    }
});

// Limiter for OTP verification attempts (prevents 6-digit brute force)
const otpVerifyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // Max 10 verification attempts per window per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        statusCode: 429,
        message: "Too many OTP verification attempts. Please try again after 15 minutes."
    }
});

// Limiter for Login endpoints (prevents brute force / credential stuffing)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 15, // Max 15 login attempts per window per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        statusCode: 429,
        message: "Too many login attempts from this IP. Please try again after 15 minutes."
    }
});

module.exports = {
    otpLimiter,
    otpVerifyLimiter,
    authLimiter
};
