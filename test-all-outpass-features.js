const http = require("http");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const app = require("./index");
const pool = require("./db/db");

const JWT_SECRET = process.env.JWT_SECRET || "default_secret";

let server;
let baseUrl;

// Test context IDs
const TEST_SUFFIX = Date.now().toString().slice(-6);
const TEST_HOSTEL_NAME = `Test_Hostel_${TEST_SUFFIX}`;
let testHostelId;
let testStudentId = `test_student_${TEST_SUFFIX}`;
let testStudent2Id = `test_student2_${TEST_SUFFIX}`;
let testStudent3Id = `test_student3_${TEST_SUFFIX}`;
let testWardenId = `test_warden_${TEST_SUFFIX}`;
let testAttendantId = `test_attendant_${TEST_SUFFIX}`;
let testChiefWardenId = `test_chief_${TEST_SUFFIX}`;
let testGuardId = `test_guard_${TEST_SUFFIX}`;

let studentToken;
let student2Token;
let student3Token;
let wardenToken;
let attendantToken;
let chiefWardenToken;
let guardToken;

let createdLocalOutpassId;
let createdOutstationOutpassId;

const results = [];

function recordTest(name, passed, details = "") {
    results.push({ name, passed, details });
    const status = passed ? "✅ PASS" : "❌ FAIL";
    console.log(`${status}: ${name} ${details ? "(" + details + ")" : ""}`);
}

async function request(path, options = {}) {
    const url = `${baseUrl}${path}`;
    const headers = options.headers || {};
    if (options.token) {
        headers["Authorization"] = `Bearer ${options.token}`;
    }
    if (options.body) {
        headers["Content-Type"] = "application/json";
    }

    const res = await fetch(url, {
        method: options.method || "GET",
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined
    });

    let json;
    try {
        json = await res.json();
    } catch (e) {
        json = null;
    }

    return { status: res.status, data: json };
}

// Helpers for timestamps that are always valid today
function getValidTodayDeparture() {
    return new Date(Date.now() + 2 * 60 * 1000); // 2 mins from now
}

function getValidTodayArrival() {
    return new Date(Date.now() + 30 * 60 * 1000); // 30 mins from now
}

async function setup() {
    console.log("=== Setting up test fixtures ===");

    // 1. Create or get test hostel with a late cutoff (23:59:00) so local outpasses pass
    const hostelRes = await pool.query(
        `INSERT INTO hostel (name, type, total_capacity, local_outpass_cutoff)
         VALUES ($1, 'Boys', 100, '23:59:00')
         RETURNING id, name;`,
        [TEST_HOSTEL_NAME]
    );
    testHostelId = hostelRes.rows[0].id;

    // 2. Create test students
    await pool.query(
        `INSERT INTO students (id, name, email, roll_no, department, hostel, hostel_id, phone, parent_number)
         VALUES ($1, $2, $3, $4, 'CSE', $5, $6, '9999999999', '8888888888'),
                ($7, $8, $9, $10, 'ECE', $5, $6, '9999999998', '8888888887'),
                ($11, $12, $13, $14, 'MECH', $5, $6, '9999999997', '8888888886');`,
        [
            testStudentId,
            `Test Student ${TEST_SUFFIX}`,
            `student_${TEST_SUFFIX}@nith.ac.in`,
            `ROLL_${TEST_SUFFIX}`,
            TEST_HOSTEL_NAME,
            testHostelId,
            testStudent2Id,
            `Test Student2 ${TEST_SUFFIX}`,
            `student2_${TEST_SUFFIX}@nith.ac.in`,
            `ROLL2_${TEST_SUFFIX}`,
            testStudent3Id,
            `Test Student3 ${TEST_SUFFIX}`,
            `student3_${TEST_SUFFIX}@nith.ac.in`,
            `ROLL3_${TEST_SUFFIX}`
        ]
    );

    // 3. Create test warden
    await pool.query(
        `INSERT INTO authority (id, name, email, password, phone, hostel, hostel_id, status, approved_by)
         VALUES ($1, $2, $3, 'hashed_pass', '9876543210', $4, $5, 'warden', true);`,
        [
            testWardenId,
            `Test Warden ${TEST_SUFFIX}`,
            `warden_${TEST_SUFFIX}@nith.ac.in`,
            TEST_HOSTEL_NAME,
            testHostelId
        ]
    );

    // 4. Create test attendant
    await pool.query(
        `INSERT INTO authority (id, name, email, password, phone, hostel, hostel_id, status, approved_by)
         VALUES ($1, $2, $3, 'hashed_pass', '9876543211', $4, $5, 'attendent', true);`,
        [
            testAttendantId,
            `Test Attendant ${TEST_SUFFIX}`,
            `attendant_${TEST_SUFFIX}@nith.ac.in`,
            TEST_HOSTEL_NAME,
            testHostelId
        ]
    );

    // 5. Create test chief-warden
    await pool.query(
        `INSERT INTO authority (id, name, email, password, phone, hostel, hostel_id, status, approved_by)
         VALUES ($1, $2, $3, 'hashed_pass', '9876543212', $4, $5, 'chief-warden', true);`,
        [
            testChiefWardenId,
            `Test Chief Warden ${TEST_SUFFIX}`,
            `chief_${TEST_SUFFIX}@nith.ac.in`,
            TEST_HOSTEL_NAME,
            testHostelId
        ]
    );

    // 6. Generate JWT tokens
    studentToken = jwt.sign(
        { id: testStudentId, role: "student", hostel: TEST_HOSTEL_NAME, hostel_id: testHostelId },
        JWT_SECRET,
        { expiresIn: "1h" }
    );
    student2Token = jwt.sign(
        { id: testStudent2Id, role: "student", hostel: TEST_HOSTEL_NAME, hostel_id: testHostelId },
        JWT_SECRET,
        { expiresIn: "1h" }
    );
    student3Token = jwt.sign(
        { id: testStudent3Id, role: "student", hostel: TEST_HOSTEL_NAME, hostel_id: testHostelId },
        JWT_SECRET,
        { expiresIn: "1h" }
    );
    wardenToken = jwt.sign(
        { id: testWardenId, role: "warden", hostel: TEST_HOSTEL_NAME, hostel_id: testHostelId },
        JWT_SECRET,
        { expiresIn: "1h" }
    );
    attendantToken = jwt.sign(
        { id: testAttendantId, role: "attendent", hostel: TEST_HOSTEL_NAME, hostel_id: testHostelId },
        JWT_SECRET,
        { expiresIn: "1h" }
    );
    chiefWardenToken = jwt.sign(
        { id: testChiefWardenId, role: "chief-warden", hostel: TEST_HOSTEL_NAME, hostel_id: testHostelId },
        JWT_SECRET,
        { expiresIn: "1h" }
    );
    guardToken = jwt.sign(
        { id: testGuardId, role: "guard" },
        JWT_SECRET,
        { expiresIn: "1h" }
    );

    // Start server on ephemeral port
    await new Promise((resolve) => {
        server = app.listen(0, () => {
            const port = server.address().port;
            baseUrl = `http://127.0.0.1:${port}`;
            console.log(`Test server running at ${baseUrl}`);
            resolve();
        });
    });
}

async function runTests() {
    console.log("\n=== 1. STUDENT OUTPASS ACTIONS ===");

    // Test 1.1: Create Local Outpass with auto-filled values
    const depTime = getValidTodayDeparture();
    const arrTime = getValidTodayArrival();

    const createRes = await request("/api/outpass/create", {
        method: "POST",
        token: studentToken,
        body: {
            outpass_type: "Local",
            parent_contact: "9999988888",
            departure_datetime: depTime.toISOString(),
            arrival_datetime: arrTime.toISOString()
        }
    });

    const isCreated = createRes.status === 201 && createRes.data?.data?.id;
    if (isCreated) {
        createdLocalOutpassId = createRes.data.data.id;
    }
    recordTest(
        "POST /api/outpass/create (Local Outpass)",
        isCreated,
        `Status: ${createRes.status}, ID: ${createdLocalOutpassId}`
    );

    // Test 1.2: Reject duplicate active Local outpass
    const dupRes = await request("/api/outpass/create", {
        method: "POST",
        token: studentToken,
        body: {
            outpass_type: "Local",
            parent_contact: "9999988888",
            departure_datetime: depTime.toISOString(),
            arrival_datetime: arrTime.toISOString()
        }
    });
    recordTest(
        "POST /api/outpass/create (Reject 2nd Active Local)",
        dupRes.status === 400,
        `Status: ${dupRes.status}, Msg: ${dupRes.data?.message}`
    );

    // Test 1.3: Create Outstation Outpass (Long trip allowed alongside Local)
    const futureDep = new Date();
    futureDep.setDate(futureDep.getDate() + 2);
    const futureArr = new Date();
    futureArr.setDate(futureArr.getDate() + 5);

    const outstationRes = await request("/api/outpass/create", {
        method: "POST",
        token: studentToken,
        body: {
            outpass_type: "Outstation",
            place_of_visit: "Delhi",
            purpose: "Hackathon",
            parent_contact: "9999988888",
            departure_datetime: futureDep.toISOString(),
            arrival_datetime: futureArr.toISOString()
        }
    });
    const isOutstationCreated = outstationRes.status === 201 && outstationRes.data?.data?.id;
    if (isOutstationCreated) {
        createdOutstationOutpassId = outstationRes.data.data.id;
    }
    recordTest(
        "POST /api/outpass/create (Outstation Outpass allowed alongside Local)",
        isOutstationCreated,
        `Status: ${outstationRes.status}, ID: ${createdOutstationOutpassId}`
    );

    // Test 1.4: Reject Home outpass when active Outstation exists
    const dupHomeRes = await request("/api/outpass/create", {
        method: "POST",
        token: studentToken,
        body: {
            outpass_type: "Home",
            place_of_visit: "Home Town",
            purpose: "Vacation",
            parent_contact: "9999988888",
            departure_datetime: futureDep.toISOString(),
            arrival_datetime: futureArr.toISOString()
        }
    });
    recordTest(
        "POST /api/outpass/create (Reject duplicate Home when Outstation active)",
        dupHomeRes.status === 400,
        `Status: ${dupHomeRes.status}`
    );

    // Test 1.5: GET /api/outpass/my and /me
    const myRes = await request("/api/outpass/my", { token: studentToken });
    recordTest(
        "GET /api/outpass/my",
        myRes.status === 200 && Array.isArray(myRes.data?.data) && myRes.data.data.length >= 2,
        `Count: ${myRes.data?.data?.length}`
    );

    const meRes = await request("/api/outpass/me", { token: studentToken });
    recordTest("GET /api/outpass/me (alias)", meRes.status === 200 && meRes.data?.data?.length >= 2);

    // Test 1.6: GET /api/outpass/active
    const activeRes = await request("/api/outpass/active", { token: studentToken });
    recordTest(
        "GET /api/outpass/active",
        activeRes.status === 200 && Array.isArray(activeRes.data?.data) && activeRes.data.data.length >= 2,
        `Active count: ${activeRes.data?.data?.length}`
    );

    // Test 1.7: GET /api/outpass/:id
    const singleRes = await request(`/api/outpass/${createdLocalOutpassId}`, { token: studentToken });
    recordTest(
        "GET /api/outpass/:id (Student single view)",
        singleRes.status === 200 && singleRes.data?.data?.outpass?.id === createdLocalOutpassId
    );

    // Test 1.8: Cancel Outstation outpass
    const cancelRes = await request(`/api/outpass/cancel/${createdOutstationOutpassId}`, {
        method: "PATCH",
        token: studentToken
    });
    recordTest(
        "PATCH /api/outpass/cancel/:id",
        cancelRes.status === 200 && cancelRes.data?.data?.is_active === false,
        `Cancelled status: ${cancelRes.data?.data?.outp_status}`
    );

    console.log("\n=== 2. WARDEN & ATTENDANT OUTPASS ACTIONS ===");

    // Test 2.1: GET /api/outpasses/pending
    const pendingRes = await request("/api/outpasses/pending", { token: wardenToken });
    const hasLocalPending = pendingRes.data?.data?.outpasses?.some((o) => o.id === createdLocalOutpassId);
    recordTest(
        "GET /api/outpasses/pending (Warden scoped)",
        pendingRes.status === 200 && hasLocalPending,
        `Pending count: ${pendingRes.data?.data?.outpasses?.length}`
    );

    // Test 2.2: Reject without remark should fail
    const rejectNoRemark = await request(`/api/outpasses/reject/${createdLocalOutpassId}`, {
        method: "PATCH",
        token: wardenToken,
        body: { remark: "" }
    });
    recordTest(
        "PATCH /api/outpasses/reject/:id (Reject without remark should fail)",
        rejectNoRemark.status === 400,
        `Status: ${rejectNoRemark.status}`
    );

    // Test 2.3: Approve with remark
    const approveRes = await request(`/api/outpasses/approve/${createdLocalOutpassId}`, {
        method: "PATCH",
        token: wardenToken,
        body: { remark: "Approved for local market visit" }
    });
    recordTest(
        "PATCH /api/outpasses/approve/:id (Warden approve with remark)",
        approveRes.status === 200 && approveRes.data?.data?.outp_status === "Approved",
        `Approved status: ${approveRes.data?.data?.outp_status}`
    );

    // Test 2.4: GET /api/outpasses/:id/remarks
    const remarksRes = await request(`/api/outpasses/${createdLocalOutpassId}/remarks`, {
        token: wardenToken
    });
    const hasRemark = remarksRes.data?.data?.some((r) => r.remark.includes("local market"));
    recordTest(
        "GET /api/outpasses/:id/remarks",
        remarksRes.status === 200 && hasRemark,
        `Remarks count: ${remarksRes.data?.data?.length}`
    );

    // Test 2.5: Create another outpass to test Bulk Action
    const bulkOutpassRes = await request("/api/outpass/create", {
        method: "POST",
        token: studentToken,
        body: {
            outpass_type: "Home",
            place_of_visit: "Chandigarh",
            purpose: "Family visit",
            parent_contact: "9999988888",
            departure_datetime: futureDep.toISOString(),
            arrival_datetime: futureArr.toISOString()
        }
    });
    const bulkOutpassId = bulkOutpassRes.data?.data?.id;

    const bulkActionRes = await request("/api/outpasses/bulk-action", {
        method: "PATCH",
        token: wardenToken,
        body: {
            ids: [bulkOutpassId],
            action: "approve",
            remark: "Bulk approved"
        }
    });
    recordTest(
        "PATCH /api/outpasses/bulk-action (Atomic bulk approve)",
        bulkActionRes.status === 200 && bulkActionRes.data?.data?.affected_count === 1
    );

    console.log("\n=== 3. GUARD OPERATIONS ===");

    // Test 3.1: Guard Monitor
    const guardMonRes = await request("/api/guard/monitor");
    const foundApproved = guardMonRes.data?.data?.outpasses?.some((o) => o.id === createdLocalOutpassId);
    recordTest(
        "GET /api/guard/monitor (Approved active outpasses)",
        guardMonRes.status === 200 && foundApproved
    );

    // Test 3.2: Real-time record EXIT
    const exitRes = await request("/api/guard/record-entry", {
        method: "POST",
        token: guardToken,
        body: {
            outpass_id: createdLocalOutpassId,
            action: "exit",
            gate: "Gate 1"
        }
    });
    recordTest(
        "POST /api/guard/record-entry (EXIT action)",
        exitRes.status === 200 && exitRes.data?.data?.status === "Out",
        `Student status: ${exitRes.data?.data?.status}`
    );

    // Test 3.3: Real-time record ENTER
    const enterRes = await request("/api/guard/record-entry", {
        method: "POST",
        token: guardToken,
        body: {
            outpass_id: createdLocalOutpassId,
            action: "enter",
            gate: "Gate 1"
        }
    });
    recordTest(
        "POST /api/guard/record-entry (ENTER action & visit_log update)",
        enterRes.status === 200 && enterRes.data?.data?.status === "In",
        `Student status: ${enterRes.data?.data?.status}`
    );

    // Test 3.4: Offline Guard Sync Logs (Idempotency test)
    const logUuid1 = crypto.randomUUID();
    const logUuid2 = crypto.randomUUID();

    // Create a fresh approved outpass using student2
    const syncTestOutpass = await request("/api/outpass/create", {
        method: "POST",
        token: student2Token,
        body: {
            outpass_type: "Local",
            parent_contact: "9999988888",
            departure_datetime: getValidTodayDeparture().toISOString(),
            arrival_datetime: getValidTodayArrival().toISOString()
        }
    });
    const syncOutpassId = syncTestOutpass.data?.data?.id;
    await request(`/api/outpasses/approve/${syncOutpassId}`, {
        method: "PATCH",
        token: wardenToken,
        body: { remark: "Auto approve" }
    });

    const syncBatch = [
        {
            id: logUuid1,
            outpass_id: syncOutpassId,
            action: "exit",
            gate: "Main Gate",
            timestamp: new Date(Date.now() - 60000).toISOString()
        },
        {
            id: logUuid2,
            outpass_id: syncOutpassId,
            action: "enter",
            gate: "Main Gate",
            timestamp: new Date().toISOString()
        }
    ];

    const syncRes1 = await request("/api/guard/sync-logs", {
        method: "POST",
        token: guardToken,
        body: { logs: syncBatch }
    });
    recordTest(
        "POST /api/guard/sync-logs (1st sync pass)",
        syncRes1.status === 200 && syncRes1.data?.data?.synced_ids?.length === 2,
        `Synced: ${syncRes1.data?.data?.synced_ids?.length}`
    );

    // Replay exact same sync batch - must be idempotent!
    const syncRes2 = await request("/api/guard/sync-logs", {
        method: "POST",
        token: guardToken,
        body: { logs: syncBatch }
    });
    recordTest(
        "POST /api/guard/sync-logs (2nd pass - Idempotency deduplication)",
        syncRes2.status === 200 && syncRes2.data?.data?.synced_ids?.length === 2,
        `Synced deduplicated: ${syncRes2.data?.data?.synced_ids?.length}`
    );

    console.log("\n=== 4. STUDENT SEARCH, HISTORY, CUTOFF & OPS ===");

    // Test 4.1: GET /api/students/:id/history
    const historyRes = await request(`/api/students/${testStudentId}/history`, {
        token: wardenToken
    });
    const hasHistory =
        historyRes.status === 200 &&
        historyRes.data?.data?.profile?.id === testStudentId &&
        Array.isArray(historyRes.data?.data?.visit_logs) &&
        historyRes.data?.data?.visit_logs.length >= 1; // from record-entry
    recordTest(
        "GET /api/students/:id/history (With visit_log joined)",
        hasHistory,
        `Visit logs count: ${historyRes.data?.data?.visit_logs?.length}`
    );

    // Test 4.2: GET & POST /api/students/search
    const searchGet = await request(`/api/students/search?q=Test`, { token: wardenToken });
    recordTest("GET /api/students/search?q=", searchGet.status === 200 && searchGet.data?.data?.students?.length > 0);

    const searchPost = await request("/api/students/search", {
        method: "POST",
        token: wardenToken,
        body: { name: "Test" }
    });
    recordTest(
        "POST /api/students/search (Paginated)",
        searchPost.status === 200 && searchPost.data?.data?.students?.length > 0
    );

    // Test 4.3: GET /api/students/directory
    const dirRes = await request("/api/students/directory?q=Test", { token: wardenToken });
    recordTest(
        "GET /api/students/directory (Warden locator)",
        dirRes.status === 200 && Array.isArray(dirRes.data?.data?.students)
    );

    // Test 4.4: POST /api/students/range
    const rangeRes = await request("/api/students/range", {
        method: "POST",
        token: wardenToken,
        body: {
            departure_datetime: new Date(Date.now() - 86400000).toISOString(),
            arrival_datetime: new Date(Date.now() + 86400000 * 10).toISOString()
        }
    });
    recordTest("POST /api/students/range", rangeRes.status === 200 && rangeRes.data?.data?.students?.length > 0);

    // Test 4.5: POST /api/students/hostel-status
    const hostelStatusRes = await request("/api/students/hostel-status", {
        method: "POST",
        token: wardenToken,
        body: { outp_status: "All" }
    });
    recordTest(
        "POST /api/students/hostel-status",
        hostelStatusRes.status === 200 && hostelStatusRes.data?.data?.outpasses?.length > 0
    );

    // Test 4.6: POST /api/students/status (Global)
    const globalStatusRes = await request("/api/students/status", {
        method: "POST",
        token: wardenToken,
        body: { outp_status: "Approved" }
    });
    recordTest(
        "POST /api/students/status (Global outpasses)",
        globalStatusRes.status === 200 && Array.isArray(globalStatusRes.data?.data?.outpasses)
    );

    // Test 4.7: GET & PATCH /api/students/outpass-cutoff
    const cutoffGet = await request("/api/students/outpass-cutoff", { token: wardenToken });
    recordTest("GET /api/students/outpass-cutoff", cutoffGet.status === 200 && cutoffGet.data?.data?.cutoffTime);

    const cutoffPatch = await request("/api/students/outpass-cutoff", {
        method: "PATCH",
        token: wardenToken,
        body: { cutoffTime: "23:59:00" } // Update and leave open for subsequent tests
    });
    recordTest(
        "PATCH /api/students/outpass-cutoff",
        cutoffPatch.status === 200 && cutoffPatch.data?.data?.cutoffTime.startsWith("23:59")
    );

    // Test 4.8: POST /api/students/bulk-record-entry (Atomic CTE)
    // Create and approve outpass for student3 for atomic CTE test
    const atomicOutpass = await request("/api/outpass/create", {
        method: "POST",
        token: student3Token,
        body: {
            outpass_type: "Local",
            parent_contact: "9999988888",
            departure_datetime: getValidTodayDeparture().toISOString(),
            arrival_datetime: getValidTodayArrival().toISOString()
        }
    });
    const atomicId = atomicOutpass.data?.data?.id;
    await request(`/api/outpasses/approve/${atomicId}`, {
        method: "PATCH",
        token: wardenToken,
        body: { remark: "Approved for bulk CTE test" }
    });

    const bulkCteExit = await request("/api/students/bulk-record-entry", {
        method: "POST",
        token: guardToken,
        body: {
            outpass_ids: [atomicId],
            action: "exit",
            gate: "Gate 2"
        }
    });
    recordTest(
        "POST /api/students/bulk-record-entry (Atomic Exit CTE)",
        bulkCteExit.status === 200 && bulkCteExit.data?.data?.processed_count === 1
    );

    const bulkCteEnter = await request("/api/students/bulk-record-entry", {
        method: "POST",
        token: guardToken,
        body: {
            outpass_ids: [atomicId],
            action: "enter"
        }
    });
    recordTest(
        "POST /api/students/bulk-record-entry (Atomic Enter CTE)",
        bulkCteEnter.status === 200 && bulkCteEnter.data?.data?.processed_count === 1
    );

    console.log("\n=== 5. CHIEF WARDEN EXCLUSIVE OPERATIONS ===");

    // Test 5.1: Chief Warden GET /api/chief-warden/outpasses/:id
    const chiefGet = await request(`/api/chief-warden/outpasses/${createdLocalOutpassId}`, {
        token: chiefWardenToken
    });
    recordTest(
        "GET /api/chief-warden/outpasses/:id (Unrestricted access)",
        chiefGet.status === 200 && chiefGet.data?.data?.outpass?.id === createdLocalOutpassId
    );

    // Test 5.2: Chief Warden POST remark
    const chiefRemark = await request(`/api/chief-warden/outpasses/${createdLocalOutpassId}/remarks`, {
        method: "POST",
        token: chiefWardenToken,
        body: { remark: "Special note from Chief Warden" }
    });
    recordTest(
        "POST /api/chief-warden/outpasses/:id/remarks",
        chiefRemark.status === 201 && chiefRemark.data?.data?.remark?.admin_role === "CHIEF_WARDEN"
    );

    console.log("\n=== 6. DAY SCHOLAR OPERATIONS ===");

    // Test 6.1: Add Day Scholar
    const dsRes = await request("/api/guard/dayscholar", {
        method: "POST",
        token: guardToken,
        body: {
            name: `Test Student ${TEST_SUFFIX}`,
            roll_no: `ROLL_${TEST_SUFFIX}`,
            phone: "9876500000"
        }
    });
    const dsId = dsRes.data?.id;
    recordTest("POST /api/guard/dayscholar", dsRes.status === 201 && dsId);

    // Test 6.2: Day Scholar Movement Log
    if (dsId) {
        const dsLogRes = await request("/api/guard/dayscholar/log", {
            method: "POST",
            token: guardToken,
            body: {
                scholar_id: dsId,
                direction: "ENTRY"
            }
        });
        recordTest("POST /api/guard/dayscholar/log", dsLogRes.status === 201);
    }

    // Test 6.3: Fetch Day Scholar list & logs
    const dsList = await request("/api/guard/dayscholar");
    recordTest("GET /api/guard/dayscholar", dsList.status === 200 && Array.isArray(dsList.data));

    const dsLogs = await request("/api/guard/dayscholar/logs");
    recordTest("GET /api/guard/dayscholar/logs", dsLogs.status === 200 && Array.isArray(dsLogs.data));
}

async function cleanup() {
    console.log("\n=== Cleaning up test data ===");
    try {
        await pool.query(`DELETE FROM students WHERE id IN ($1, $2, $3);`, [
            testStudentId,
            testStudent2Id,
            testStudent3Id
        ]);
        await pool.query(`DELETE FROM authority WHERE id IN ($1, $2, $3);`, [
            testWardenId,
            testAttendantId,
            testChiefWardenId
        ]);
        await pool.query(`DELETE FROM hostel WHERE id = $1;`, [testHostelId]);
        console.log("Cleanup completed.");
    } catch (e) {
        console.error("Cleanup warning:", e.message);
    }

    if (server) {
        await new Promise((res) => server.close(res));
    }
    await pool.end();
}

async function main() {
    try {
        await setup();
        await runTests();
    } catch (error) {
        console.error("Fatal Test Execution Error:", error);
    } finally {
        await cleanup();
    }

    const passedCount = results.filter((r) => r.passed).length;
    const totalCount = results.length;

    console.log("\n=================================");
    console.log(`TEST SUMMARY: ${passedCount} / ${totalCount} PASSED`);
    console.log("=================================\n");

    if (passedCount < totalCount) {
        process.exit(1);
    } else {
        process.exit(0);
    }
}

main();
