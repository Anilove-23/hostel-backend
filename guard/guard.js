const express = require("express");
const router = express.Router();
const pool = require("../db/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/apiError");
const ApiResponse = require("../utils/apiResponse");
const deviceAuthRoutes = require("./deviceAuth");
const { verifyGuardDevice } = require("../middleware/guardDeviceAuth");

// Mount device activation and verification endpoints (public to allow device pairing)
router.use("/device", deviceAuthRoutes);

// Protect all subsequent guard endpoints with device hardware verification
router.use(verifyGuardDevice);

/*
=================================================
GUARD MONITOR
GET /api/guard/monitor
=================================================
*/
router.get(
    "/monitor",
    asyncHandler(async (req, res) => {
        const { updated_since } = req.query;

        let query = `
            SELECT 
                o.*, 
                o.outp_status AS status,
                s.name AS name, 
                s.roll_no AS roll_no, 
                s.department AS department,
                s.phone AS phone, 
                s.hostel AS hostel,
                r.room_number AS room,
                r.room_number AS room_no,
                s.parent_number AS parent_contact,
                s.degree_type AS degree_type
            FROM outpass o 
            JOIN students s ON o.student_id = s.id
            LEFT JOIN room r ON r.id = s.physical_room_id
            WHERE 1=1
        `;

        const params = [];

        // Delta sync mode
        if (updated_since) {
            const ts = new Date(updated_since);
            if (isNaN(ts.getTime())) {
                throw new ApiError(400, "Invalid updated_since timestamp");
            }

            query += ` AND (o.updated_at >= $1 OR o.created_at >= $1) ORDER BY o.updated_at ASC`;
            params.push(ts.toISOString());

            const result = await pool.query(query, params);

            return res.status(200).json(
                new ApiResponse(
                    200,
                    {
                        data: result.rows,
                        outpasses: result.rows,
                        delta: true,
                        server_time: new Date().toISOString()
                    },
                    "Delta outpass data fetched successfully"
                )
            );
        }

        // Full initial sync mode
        query += ` AND o.outp_status = 'Approved' AND o.is_active = true ORDER BY o.created_at DESC`;

        const result = await pool.query(query, params);

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    data: result.rows,
                    outpasses: result.rows,
                    server_time: new Date().toISOString()
                },
                "Guard monitor data fetched successfully"
            )
        );
    })
);

/*
=================================================
REAL-TIME RECORD ENTRY / EXIT
POST /api/guard/record-entry
=================================================
*/
router.post(
    "/record-entry",
    asyncHandler(async (req, res) => {
        const { outpass_id, action, gate } = req.body;
        const guardId = req.user?.id || null;

        if (!outpass_id || !action) {
            throw new ApiError(400, "outpass_id and action ('exit' or 'enter') are required");
        }

        if (action !== "exit" && action !== "enter") {
            throw new ApiError(400, "Invalid action: must be 'exit' or 'enter'");
        }

        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            const outpassRes = await client.query(
                `SELECT o.*, s.name, s.roll_no
                 FROM outpass o
                 JOIN students s ON o.student_id = s.id
                 WHERE o.id = $1
                 FOR UPDATE;`,
                [outpass_id]
            );

            if (outpassRes.rows.length === 0) {
                throw new ApiError(404, "Outpass not found");
            }

            const outpass = outpassRes.rows[0];

            if (action === "exit") {
                if (outpass.outp_status !== "Approved") {
                    throw new ApiError(400, "Outpass is not approved");
                }

                if (outpass.std_status === "Out") {
                    throw new ApiError(400, "Student is already recorded as outside campus");
                }

                await client.query(
                    `INSERT INTO visit_log (outpass_id, student_id, gate, exit_guard_id, actual_departure)
                     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP);`,
                    [outpass.id, outpass.student_id, gate || "Main Gate", guardId]
                );

                await client.query(
                    `UPDATE outpass
                     SET std_status = 'Out', hostel_std_status = 'Out', updated_at = CURRENT_TIMESTAMP
                     WHERE id = $1;`,
                    [outpass.id]
                );

                await client.query("COMMIT");

                return res.status(200).json(
                    new ApiResponse(
                        200,
                        {
                            student_name: outpass.name,
                            roll_no: outpass.roll_no,
                            status: "Out"
                        },
                        "Exit recorded successfully"
                    )
                );
            }

            if (action === "enter") {
                if (outpass.std_status !== "Out") {
                    throw new ApiError(400, "Student is not recorded as outside campus");
                }

                await client.query(
                    `UPDATE visit_log
                     SET actual_arrival = CURRENT_TIMESTAMP,
                         entry_guard_id = $1,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = (
                         SELECT id
                         FROM visit_log
                         WHERE outpass_id = $2
                         ORDER BY created_at DESC
                         LIMIT 1
                     );`,
                    [guardId, outpass.id]
                );

                await client.query(
                    `UPDATE outpass
                     SET std_status = 'In', is_active = false, updated_at = CURRENT_TIMESTAMP
                     WHERE id = $1;`,
                    [outpass.id]
                );

                await client.query("COMMIT");

                return res.status(200).json(
                    new ApiResponse(
                        200,
                        {
                            student_name: outpass.name,
                            roll_no: outpass.roll_no,
                            status: "In"
                        },
                        "Entry recorded successfully"
                    )
                );
            }
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    })
);

/*
=================================================
OFFLINE GUARD LOGS SYNC
POST /api/guard/sync-logs
=================================================
*/
router.post(
    "/sync-logs",
    asyncHandler(async (req, res) => {
        const { logs } = req.body;

        if (!Array.isArray(logs) || logs.length === 0) {
            throw new ApiError(400, "logs array is required");
        }

        if (logs.length > 500) {
            throw new ApiError(400, "Maximum 500 logs allowed per sync request");
        }

        // Sort chronologically by timestamp so exits process before entries
        const sortedLogs = [...logs].sort((a, b) => {
            const timeA = new Date(a.timestamp || a.actioned_at || 0).getTime();
            const timeB = new Date(b.timestamp || b.actioned_at || 0).getTime();
            return timeA - timeB;
        });

        const synced_ids = [];
        const failed_ids = [];
        const guardId = req.user?.id || null;

        const client = await pool.connect();

        try {
            for (const log of sortedLogs) {
                const { id, outpass_id, action, gate, remark, timestamp } = log;

                if (!id || !outpass_id || !action) {
                    failed_ids.push(id || "unknown");
                    continue;
                }

                const actionedAt = timestamp ? new Date(timestamp) : new Date();

                // Check if already processed (idempotency)
                const existingLog = await client.query(
                    `SELECT id FROM guard_action_log WHERE id = $1;`,
                    [id]
                );

                if (existingLog.rows.length > 0) {
                    synced_ids.push(id);
                    continue;
                }

                try {
                    await client.query("BEGIN");

                    const outpassRes = await client.query(
                        `SELECT id, student_id, outp_status, std_status
                         FROM outpass
                         WHERE id = $1
                         FOR UPDATE;`,
                        [outpass_id]
                    );

                    if (outpassRes.rows.length === 0) {
                        await client.query("ROLLBACK");
                        failed_ids.push(id);
                        continue;
                    }

                    const outpass = outpassRes.rows[0];

                    if (action === "exit") {
                        if (outpass.std_status === "In" && outpass.outp_status === "Approved") {
                            await client.query(
                                `INSERT INTO visit_log (outpass_id, student_id, gate, exit_guard_id, actual_departure)
                                 VALUES ($1, $2, $3, $4, $5);`,
                                [outpass_id, outpass.student_id, gate || "Main Gate", guardId, actionedAt]
                            );

                                await client.query(
                                    `UPDATE outpass
                                     SET std_status = 'Out', hostel_std_status = 'Out', updated_at = CURRENT_TIMESTAMP
                                     WHERE id = $1;`,
                                    [outpass_id]
                                );
                        } else if (outpass.std_status === "Out") {
                            // Already outside
                        } else {
                            await client.query("ROLLBACK");
                            failed_ids.push(id);
                            continue;
                        }
                    } else if (action === "enter") {
                        if (outpass.std_status === "Out") {
                            await client.query(
                                `UPDATE visit_log
                                 SET actual_arrival = $1, entry_guard_id = $2, updated_at = CURRENT_TIMESTAMP
                                 WHERE outpass_id = $3 AND actual_arrival IS NULL;`,
                                [actionedAt, guardId, outpass_id]
                            );

                            await client.query(
                                `UPDATE outpass
                                 SET std_status = 'In', is_active = false, updated_at = CURRENT_TIMESTAMP
                                 WHERE id = $1;`,
                                [outpass_id]
                            );
                        } else if (outpass.std_status === "In") {
                            // Already inside
                        } else {
                            await client.query("ROLLBACK");
                            failed_ids.push(id);
                            continue;
                        }
                    } else {
                        await client.query("ROLLBACK");
                        failed_ids.push(id);
                        continue;
                    }

                    await client.query(
                        `INSERT INTO guard_action_log (id, outpass_id, action, gate, remark, guard_id, actioned_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7)
                         ON CONFLICT (id) DO NOTHING;`,
                        [id, outpass_id, action, gate || "Main Gate", remark || "", guardId, actionedAt]
                    );

                    await client.query("COMMIT");
                    synced_ids.push(id);
                } catch (err) {
                    try {
                        await client.query("ROLLBACK");
                    } catch (e) {}
                    failed_ids.push(id);
                }
            }
        } finally {
            client.release();
        }

        return res.status(200).json(
            new ApiResponse(
                200,
                { synced_ids, failed_ids },
                `Synced ${synced_ids.length} log(s), failed ${failed_ids.length}`
            )
        );
    })
);

/*
=================================================
DAY SCHOLAR MANAGEMENT
=================================================
*/

// GET all day scholars
router.get(
    "/dayscholar",
    asyncHandler(async (req, res) => {
        const scholars = await pool.query(
            `SELECT * FROM day_scholar ORDER BY name ASC;`
        );
        return res.status(200).json(scholars.rows);
    })
);

// GET day scholar logs
router.get(
    "/dayscholar/logs",
    asyncHandler(async (req, res) => {
        const logs = await pool.query(`
            SELECT 
                l.*,
                ds.name AS scholar_name,
                ds.roll_no AS scholar_roll_no
            FROM day_scholar_log l
            JOIN day_scholar ds ON l.day_scholar_id = ds.id
            ORDER BY l.timestamp DESC
            LIMIT 100;
        `);
        return res.status(200).json(logs.rows);
    })
);

// POST mark day scholar ENTRY or EXIT
router.post(
    "/dayscholar/log",
    asyncHandler(async (req, res) => {
        const { scholar_id, direction } = req.body;

        if (!scholar_id || !direction || !["ENTRY", "EXIT"].includes(direction)) {
            throw new ApiError(400, "Invalid request data. direction must be ENTRY or EXIT.");
        }

        const id = crypto.randomUUID();
        const newLog = await pool.query(
            `INSERT INTO day_scholar_log (id, day_scholar_id, direction, gate)
             VALUES ($1, $2, $3, $4)
             RETURNING *;`,
            [id, scholar_id, direction, "Main Gate"]
        );

        return res.status(201).json(newLog.rows[0]);
    })
);

// POST add a new day scholar
router.post(
    "/dayscholar",
    asyncHandler(async (req, res) => {
        const { name, roll_no, degree_type, phone } = req.body;

        if (!name || !roll_no) {
            throw new ApiError(400, "Name and roll_no are required");
        }

        const student = await pool.query(
            `SELECT name, degree_type FROM students WHERE roll_no = $1 LIMIT 1;`,
            [roll_no]
        );

        if (student.rowCount === 0) {
            throw new ApiError(400, "roll_no must belong to an existing student");
        }

        const canonicalStudent = student.rows[0];
        if (degree_type && degree_type !== canonicalStudent.degree_type) {
            throw new ApiError(400, "degree_type does not match the student record");
        }

        try {
            const newScholar = await pool.query(
                `INSERT INTO day_scholar (name, roll_no, degree_type, phone)
                 VALUES ($1, $2, $3, $4)
                 RETURNING *;`,
                [canonicalStudent.name, roll_no, canonicalStudent.degree_type, phone]
            );

            return res.status(201).json(newScholar.rows[0]);
        } catch (err) {
            if (err.code === "23505") {
                throw new ApiError(409, "Roll number already exists");
            }
            throw err;
        }
    })
);

module.exports = router;
