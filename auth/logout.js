const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { closeSession, deactivateUserSessions } = require('../utils/sessionService');
const { JWT_SECRET } = require('../utils/authHelpers');

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
                // If token is expired, we still proceed with logout using sessionId from body
            }
        }

        // Option to logout of all devices
        if (req.body?.allDevices && actorId) {
            await deactivateUserSessions(actorId, actorType);
        } else if (sessionId) {
            await closeSession(sessionId);
        }

        // Clear cookies
        res.clearCookie('token');
        res.clearCookie('accessToken');
        res.clearCookie('refreshToken');

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
