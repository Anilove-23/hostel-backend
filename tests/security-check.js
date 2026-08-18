/**
 * Security & Access Control Verification Suite
 * 
 * Uses Node.js native test runner (node:test / node:assert)
 * Runs against the local Express app without requiring open ports or external tools.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

// Load environment variables and Express app instance
require('dotenv').config();
const app = require('../index');

const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_audit';

// Helper to make test HTTP requests to the Express app
async function makeRequest(path, options = {}) {
    return new Promise((resolve, reject) => {
        const http = require('http');
        const server = app.listen(0, () => {
            const port = server.address().port;
            const url = 'http://127.0.0.1:' + port + path;
            
            fetch(url, options)
                .then(async (res) => {
                    let body = {};
                    try {
                        body = await res.json();
                    } catch (_) {
                        body = {};
                    }
                    server.close(() => resolve({ status: res.status, headers: res.headers, body }));
                })
                .catch((err) => {
                    server.close(() => reject(err));
                });
        });
    });
}

describe('1. Unauthenticated Endpoint Protection', () => {
    it('rejects /api/outpass/me without token (401)', async () => {
        const res = await makeRequest('/api/outpass/me');
        assert.equal(res.status, 401, 'Protected student route must return 401 when no token is present');
        assert.equal(res.body.success, false);
    });

    it('rejects /api/management/devices without token (401)', async () => {
        const res = await makeRequest('/api/management/devices');
        assert.equal(res.status, 401, 'Chief warden route must return 401 when unauthenticated');
    });

    it('rejects /api/students/hostel-status without token (401)', async () => {
        const res = await makeRequest('/api/students/hostel-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'Pending' })
        });
        assert.equal(res.status, 401, 'Warden student status route must return 401');
    });
});

describe('2. Token Integrity & Signature Verification', () => {
    it('rejects tokens signed with a fake/wrong secret (401)', async () => {
        const fakeToken = jwt.sign(
            { id: 'fake-user-id', role: 'chief_warden' },
            'completely_wrong_secret_key'
        );

        const res = await makeRequest('/api/management/devices', {
            headers: { 'Authorization': 'Bearer ' + fakeToken }
        });

        assert.equal(res.status, 401, 'Tokens with invalid signature must be rejected');
    });

    it('rejects expired tokens (401)', async () => {
        const expiredToken = jwt.sign(
            { id: 'student-1', role: 'student' },
            JWT_SECRET,
            { expiresIn: '-10s' }
        );

        const res = await makeRequest('/api/outpass/me', {
            headers: { 'Authorization': 'Bearer ' + expiredToken }
        });

        assert.equal(res.status, 401, 'Expired tokens must be rejected');
    });
});

describe('3. Role-Based Access Control Boundaries', () => {
    it('prevents student role from accessing chief warden routes (403)', async () => {
        const validStudentToken = jwt.sign(
            { id: 'test-student-id', role: 'student' },
            JWT_SECRET,
            { expiresIn: '1h' }
        );

        const res = await makeRequest('/api/management/devices', {
            headers: { 'Authorization': 'Bearer ' + validStudentToken }
        });

        assert.ok([401, 403].includes(res.status), 'Student token must not access chief warden endpoints');
    });

    it('ignores client-spoofed role headers', async () => {
        const validStudentToken = jwt.sign(
            { id: 'test-student-id', role: 'student' },
            JWT_SECRET,
            { expiresIn: '1h' }
        );

        // Attempt to send a fake role header while using student token
        const res = await makeRequest('/api/management/devices', {
            headers: {
                'Authorization': 'Bearer ' + validStudentToken,
                'role': 'chief_warden'
            }
        });

        assert.ok([401, 403].includes(res.status), 'Header spoofing must not bypass JWT role checks');
    });
});

describe('4. Input Validation & Error Handling', () => {
    it('handles empty login bodies gracefully with 400 Bad Request', async () => {
        const res = await makeRequest('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        assert.equal(res.status, 400, 'Server should return 400 when required fields are missing');
        assert.equal(res.body.success, false);
    });
});

describe('5. CSRF Origin Verification Defense', () => {
    it('blocks mutating requests originating from unauthorized third-party domains (403)', async () => {
        const res = await makeRequest('/api/auth/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Origin': 'https://malicious-attacker-website.com'
            },
            body: JSON.stringify({ email: 'test@nith.ac.in', password: '123' })
        });

        assert.equal(res.status, 403, 'Cross-origin requests from unapproved domains must be blocked');
        assert.equal(res.body.success, false);
    });

    it('allows mutating requests from legitimate deployed Render domains', async () => {
        const res = await makeRequest('/api/auth/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Origin': 'https://hostel-frontend-1-59yg.onrender.com'
            },
            body: JSON.stringify({})
        });

        // 400 because body was empty, but NOT 403 (origin was accepted)
        assert.equal(res.status, 400, 'Legitimate Render origins must pass CSRF origin check');
    });
});

describe('6. Sensitive Data Exposure & Header Hardening', () => {
    it('ensures security headers (Helmet / CSP) are set on responses', async () => {
        const res = await makeRequest('/');
        assert.ok(res.headers.get('x-content-type-options'), 'X-Content-Type-Options header must be set');
        assert.ok(res.headers.get('x-frame-options'), 'X-Frame-Options (Clickjacking defense) must be set');
    });

    it('ensures API error responses do not leak internal database stack traces', async () => {
        const res = await makeRequest('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'nonexistent@nith.ac.in', password: 'invalid' })
        });

        assert.equal(res.body.stack, undefined, 'Stack traces must not be exposed in production API responses');
    });
});
