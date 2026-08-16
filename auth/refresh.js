const express = require('express');
const router = express.Router();
const pool = require('../db/db');
const {
    getRefreshTokenExpiry,
    hashRefreshToken,
    compareRefreshTokens,
    generateRefreshToken,
    generateAccessToken,
} = require('../utils/authHelpers');
const { findSessionById, updateSessionRefresh } = require('../utils/sessionService');

router.post('/refresh', async (req, res) => {
    try {
        const refreshToken = req.body.refreshToken || req.cookies?.refreshToken;
        const sessionId = req.body.sessionId || req.headers['x-session-id'] || req.headers.sessionid;

        if (!refreshToken) {
            return res.status(400).json({
                success: false,
                message: 'Refresh token is required',
            });
        }

        let session = null;

        if (sessionId) {
            session = await findSessionById(sessionId);
        } else {
            // Find recent active sessions that might match this refresh token
            const result = await pool.query(
                `SELECT * FROM user_session
                 WHERE is_active = TRUE
                   AND refresh_expires_at > CURRENT_TIMESTAMP
                 ORDER BY login_time DESC
                 LIMIT 50;`
            );

            for (const row of result.rows) {
                if (row.refresh_token_hash) {
                    const match = await compareRefreshTokens(refreshToken, row.refresh_token_hash);
                    if (match) {
                        session = row;
                        break;
                    }
                }
            }
        }

        if (!session || !session.is_active) {
            return res.status(401).json({
                success: false,
                message: 'Session is inactive or does not exist. Please log in again.',
            });
        }

        if (session.refresh_expires_at && new Date() > new Date(session.refresh_expires_at)) {
            return res.status(401).json({
                success: false,
                message: 'Refresh token has expired. Please log in again.',
            });
        }

        // Verify hash if sessionId was directly supplied
        if (sessionId) {
            const isMatch = await compareRefreshTokens(refreshToken, session.refresh_token_hash);
            if (!isMatch) {
                return res.status(401).json({
                    success: false,
                    message: 'Invalid refresh token. Please log in again.',
                });
            }
        }

        // Retrieve user details for token payload
        let userPayload = {
            id: session.actor_id,
            role: session.role,
            sessionId: session.id,
        };

        if (session.actor_type === 'STUDENT') {
            const stu = await pool.query('SELECT email, hostel FROM students WHERE id = $1', [session.actor_id]);
            if (stu.rows.length > 0) {
                userPayload.email = stu.rows[0].email;
                userPayload.hostel = stu.rows[0].hostel;
            }
        } else {
            const auth = await pool.query('SELECT email, hostel FROM authority WHERE id = $1', [session.actor_id]);
            if (auth.rows.length > 0) {
                userPayload.email = auth.rows[0].email;
                userPayload.hostel = auth.rows[0].hostel;
                userPayload.status = session.role;
            }
        }

        // Rotate refresh token
        const newRefreshToken = generateRefreshToken();
        const newRefreshTokenHash = await hashRefreshToken(newRefreshToken);
        const newRefreshExpiresAt = new Date(Date.now() + getRefreshTokenExpiry(session.role));

        await updateSessionRefresh(session.id, {
            refreshTokenHash: newRefreshTokenHash,
            refreshExpiresAt: newRefreshExpiresAt,
            isActive: true,
        });

        // Generate new Access Token
        const newAccessToken = generateAccessToken(userPayload);

        // Set cookies
        res.cookie('token', newAccessToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production' });
        res.cookie('accessToken', newAccessToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production' });
        res.cookie('refreshToken', newRefreshToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production' });

        return res.status(200).json({
            success: true,
            token: newAccessToken,
            accessToken: newAccessToken,
            refreshToken: newRefreshToken,
            sessionId: session.id,
        });
    } catch (err) {
        console.error('Refresh token error:', err);
        return res.status(500).json({
            success: false,
            message: 'Internal server error during token refresh',
        });
    }
});

module.exports = router;
