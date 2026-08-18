const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { closeSession, deactivateUserSessions, findSessionById } = require('../utils/sessionService');
const { JWT_SECRET, getCookieOptions } = require('../utils/authHelpers');

router.post('/logout', async (req, res) => {
    try {
        let token = req.cookies?.accessToken || req.cookies?.token;
        const authHeader = req.headers.authorization || '';

        if (!token && authHeader.startsWith('Bearer ')) {
            token = authHeader.slice(7).trim();
        } else if (!token && req.headers.token) {
            token = req.headers.token;
        }

        let sessionId = req.body?.sessionId || req.headers['x-session-id'] || null;
        let actorId = null;
        let actorType = null;

        if (token) {
            try {
                const decoded = jwt.verify(token, JWT_SECRET);
                if (decoded.sessionId && !sessionId) {
                    sessionId = decoded.sessionId;
                }
                actorId = decoded.id;
                actorType = decoded.role;
            } catch (ignore) {
                // If token is invalid or expired
            }
        }

        // Option to logout of all devices (requires authenticated token)
        if (req.body?.allDevices && actorId) {
            await deactivateUserSessions(actorId, actorType);
        } else if (sessionId) {
            // Verify session ownership if actorId is known, or ensure session exists
            const existingSession = await findSessionById(sessionId);
            if (existingSession) {
                // Only allow session closure if the authenticated actor owns this session or token matches
                if (!actorId || String(existingSession.actor_id) === String(actorId)) {
                    await closeSession(sessionId);
                }
            }
        }

        // Clear cookies with matching options
        const cookieOpts = getCookieOptions(req);
        res.clearCookie('token', cookieOpts);
        res.clearCookie('accessToken', cookieOpts);
        res.clearCookie('refreshToken', cookieOpts);

        return res.status(200).json({
            success: true,
            message: 'Logged out successfully',
        });
    } catch (err) {
        console.error('Logout error:', err);
        return res.status(500).json({
            success: false,
            message: 'Internal server error during logout',
        });
    }
});

module.exports = router;
