require('dotenv').config({ path: require('path').resolve(__dirname, './.env') });
const http = require('http');
const app = require('./index');
const pool = require('./db/db');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

let server;
let baseUrl;

async function startServer() {
    return new Promise((resolve) => {
        server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            baseUrl = `http://127.0.0.1:${port}`;
            console.log(`Ephemeral test server started on ${baseUrl}`);
            resolve();
        });
    });
}

async function stopServer() {
    if (server) {
        await new Promise((resolve) => server.close(resolve));
    }
    await pool.end();
}

async function makeRequest(path, options = {}) {
    const url = `${baseUrl}${path}`;
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    const res = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await res.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        data = text;
    }
    return { status: res.status, data };
}

async function runTests() {
    console.log('🧪 Starting Session & Refresh Token Authentication Tests...\n');
    await startServer();

    let passed = 0;
    let failed = 0;

    const assert = (condition, name, details = '') => {
        if (condition) {
            console.log(`  ✅ [PASS] ${name}`);
            passed++;
        } else {
            console.error(`  ❌ [FAIL] ${name} ${details ? `(${details})` : ''}`);
            failed++;
        }
    };

    const TEST_SUFFIX = Date.now().toString().slice(-6);
    const testStudentId = crypto.randomUUID();
    const testEmail = `student_${TEST_SUFFIX}@nith.ac.in`;
    const testPassword = 'Password@123';
    const hashedPassword = await bcrypt.hash(testPassword, 10);

    const hostelRes = await pool.query('SELECT id, name FROM hostel LIMIT 1');
    const hostel = hostelRes.rows[0];

    try {
        // Setup test student
        await pool.query(
            `INSERT INTO students (id, name, email, password, phone, hostel, hostel_id, roll_no, department)
             VALUES ($1, $2, $3, $4, '9876543210', $5, $6, $7, 'CSE')`,
            [testStudentId, `Test Student ${TEST_SUFFIX}`, testEmail, hashedPassword, hostel.name, hostel.id, `24BCS${TEST_SUFFIX}`]
        );

        // 1. Test Login Step 1: Request OTP
        const otpRes = await makeRequest('/api/auth/login', {
            method: 'POST',
            body: { email: testEmail, password: testPassword }
        });
        assert(otpRes.status === 200 && otpRes.data.success, 'Request OTP for login');

        // Grab OTP from DB
        const otpDb = await pool.query('SELECT otp FROM otp_verification WHERE person_id = $1 ORDER BY created_at DESC LIMIT 1', [testEmail]);
        const testOtp = otpDb.rows[0].otp;

        // 2. Test Login Step 2: Verify OTP & Issue Session Tokens
        const verifyRes = await makeRequest('/api/auth/verify-login-otp', {
            method: 'POST',
            body: { email: testEmail, otp: testOtp }
        });

        assert(verifyRes.status === 200, 'Verify login OTP status 200');
        assert(Boolean(verifyRes.data.accessToken && verifyRes.data.refreshToken && verifyRes.data.sessionId), 'Login returns accessToken, refreshToken, and sessionId');

        const { accessToken, refreshToken, sessionId } = verifyRes.data;

        // 3. Verify session was created in DB and is active
        const sessionDb = await pool.query('SELECT * FROM user_session WHERE id = $1', [sessionId]);
        assert(sessionDb.rows.length === 1 && sessionDb.rows[0].is_active === true, 'Session is stored as active in user_session table');

        // 4. Test accessing protected endpoint with valid Access Token and Session
        const meRes = await makeRequest('/api/outpass/me', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        assert(meRes.status === 200 && meRes.data.success, 'Access protected endpoint with valid access token & session');

        // 5. Test Token Refresh: Rotate Refresh Token and get new Access Token
        const refreshRes = await makeRequest('/api/auth/refresh', {
            method: 'POST',
            body: { refreshToken, sessionId }
        });

        assert(refreshRes.status === 200 && refreshRes.data.success, 'Refresh token request status 200');
        assert(Boolean(refreshRes.data.accessToken && refreshRes.data.refreshToken), 'Refresh returns new accessToken and rotated refreshToken');
        assert(refreshRes.data.refreshToken !== refreshToken, 'Refresh token was rotated (new != old)');

        const newAccessToken = refreshRes.data.accessToken;
        const newRefreshToken = refreshRes.data.refreshToken;

        // 6. Verify old refresh token is no longer valid
        const oldRefreshRes = await makeRequest('/api/auth/refresh', {
            method: 'POST',
            body: { refreshToken: refreshToken, sessionId }
        });
        assert(oldRefreshRes.status === 401, 'Old refresh token is rejected after rotation');

        // 7. Verify new Access Token works on protected routes
        const newMeRes = await makeRequest('/api/outpass/me', {
            headers: { Authorization: `Bearer ${newAccessToken}` }
        });
        assert(newMeRes.status === 200 && newMeRes.data.success, 'New access token works on protected routes');

        // 8. Test Logout / Session Invalidation
        const logoutRes = await makeRequest('/api/auth/logout', {
            method: 'POST',
            headers: { Authorization: `Bearer ${newAccessToken}` },
            body: { sessionId }
        });
        assert(logoutRes.status === 200 && logoutRes.data.success, 'Logout endpoint returns 200 success');

        // 9. Verify session in DB is now inactive
        const sessionAfterLogout = await pool.query('SELECT * FROM user_session WHERE id = $1', [sessionId]);
        assert(sessionAfterLogout.rows[0].is_active === false, 'Session is marked is_active = FALSE in DB');

        // 10. Verify that previously valid Access Token is now REJECTED due to session revocation
        const revokedAccessRes = await makeRequest('/api/outpass/me', {
            headers: { Authorization: `Bearer ${newAccessToken}` }
        });
        assert(revokedAccessRes.status === 401, 'Access token is immediately blocked after session logout/revocation');

        // 11. Verify refresh is blocked for inactive session
        const postLogoutRefresh = await makeRequest('/api/auth/refresh', {
            method: 'POST',
            body: { refreshToken: newRefreshToken, sessionId }
        });
        assert(postLogoutRefresh.status === 401, 'Refresh is rejected for revoked session');

        // 12. Test Authority Login session creation
        const wardenEmail = `warden_${TEST_SUFFIX}@nith.ac.in`;
        const wardenId = crypto.randomUUID();
        await pool.query(
            `INSERT INTO authority (id, email, password, name, phone, hostel, hostel_id, status, approved_by)
             VALUES ($1, $2, $3, 'Test Warden', '9876543211', $4, $5, 'warden', true)`,
            [wardenId, wardenEmail, hashedPassword, hostel.name, hostel.id]
        );

        const authLoginRes = await makeRequest('/api/authority/login', {
            method: 'POST',
            body: { email: wardenEmail, password: testPassword }
        });

        assert(authLoginRes.status === 200, 'Authority login status 200');
        assert(Boolean(authLoginRes.data.accessToken && authLoginRes.data.refreshToken && authLoginRes.data.sessionId), 'Authority login returns access, refresh, and session ID');

        // Clean up test data
        await pool.query('DELETE FROM user_session WHERE actor_id IN ($1, $2)', [testStudentId, wardenId]);
        await pool.query('DELETE FROM students WHERE id = $1', [testStudentId]);
        await pool.query('DELETE FROM authority WHERE id = $1', [wardenId]);

    } catch (err) {
        console.error('Unexpected error during test execution:', err);
    } finally {
        await stopServer();
    }

    console.log(`\n========================================`);
    console.log(`SESSION AUTH TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
    console.log(`========================================\n`);

    if (failed > 0) {
        process.exit(1);
    }
}

runTests();
