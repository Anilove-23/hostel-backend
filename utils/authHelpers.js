const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';
const ACCESS_TOKEN_EXPIRY = process.env.ACCESS_TOKEN_EXPIRY || '15m';

const DEFAULT_REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const GUARD_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getRefreshTokenExpiry(role) {
    const normalizedRole = String(role || '').trim().toLowerCase();
    if (normalizedRole === 'guard') {
        return GUARD_REFRESH_TOKEN_TTL_MS;
    }
    return DEFAULT_REFRESH_TOKEN_TTL_MS;
}

function getClientIp(req) {
    if (!req) return null;
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
        return forwarded.split(',')[0].trim();
    }
    if (Array.isArray(forwarded) && forwarded.length > 0) {
        return forwarded[0];
    }
    return req.ip || req.connection?.remoteAddress || null;
}

async function hashRefreshToken(token) {
    return bcrypt.hash(token, 10);
}

async function compareRefreshTokens(token, hash) {
    if (!token || !hash) return false;
    return bcrypt.compare(token, hash);
}

function generateRefreshToken() {
    return crypto.randomBytes(32).toString('hex');
}

function generateAccessToken(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
}

module.exports = {
    JWT_SECRET,
    ACCESS_TOKEN_EXPIRY,
    getRefreshTokenExpiry,
    getClientIp,
    hashRefreshToken,
    compareRefreshTokens,
    generateRefreshToken,
    generateAccessToken,
};
