const express = require("express");
const router = express.Router();
const pool = require("../db/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/apiError");
const ApiResponse = require("../utils/apiResponse");
const deviceAuthRoutes = require("./deviceAuth");
const { verifyGuardDevice } = require("../middleware/guardDeviceAuth");

// Mount device activation endpoints (public)
router.use("/device", deviceAuthRoutes);

// All subsequent hostel guard endpoints require device verification
router.use(verifyGuardDevice);

/*
=================================================
HOSTEL GUARD MONITOR
GET /api/guard/hostel-monitor
Returns approved active outpasses for the hostel this device guards.
Supports delta sync via ?updated_since=
=================================================
*/
router.get(
    "/hostel-monitor",
    asyncHandler(async (req, res) => {
        const { updated_since } = req.query;
        const device = req.guardDevice;

        // Hostel guard must have a hostel_id bound to their device
        const hostelId = device.hostel_id;
        if (!hostelId) {
            throw new ApiError(403, "This device is not assigned to any hostel. Please contact Chief Warden.");
        }

        let query = `
            SELECT
                o.*,
                o.outp_status  AS status,
                o.hostel_std_status,
                o.arrival_datetime AS return_by,
                s.name         AS name,
                s.roll_no      AS roll_no,
                s.department   AS department,
                s.phone        AS phone,
                s.hostel       AS hostel,
                s.hostel_id    AS hostel_id,
                COALESCE(
                    s.current_year,
                    CASE
                        WHEN s.roll_no IS NOT NULL
                             AND s.roll_no ~ '^[0-9]{2}[A-Za-z]'
                        THEN GREATEST(1,
                            EXTRACT(YEAR FROM NOW())::int
                            - (2000 + SUBSTRING(s.roll_no FROM 1 FOR 2)::int)
                            + 1
                        )
                        ELSE NULL
                    END
                ) AS current_year,
                s.degree_type  AS degree_type,
                r.room_number  AS room,
                r.room_number  AS room_no,
                s.parent_number AS parent_contact
            FROM outpass o
            JOIN students s ON o.student_id = s.id
            LEFT JOIN room r ON r.id = s.physical_room_id
            WHERE s.hostel_id = $1
        `;

        const params = [hostelId];

        // Delta sync mode
        if (updated_since) {
            const ts = new Date(updated_since);
            if (isNaN(ts.getTime())) {
                throw new ApiError(400, "Invalid updated_since timestamp");
            }

            query += ` AND (o.updated_at >= $2 OR o.created_at >= $2) ORDER BY o.updated_at ASC`;
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
                    "Delta hostel outpass data fetched successfully"
                )
            );
        }

        // Full sync: only Approved + active outpasses
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
                "Hostel guard monitor data fetched successfully"
            )
        );
    })
);

/*
=================================================
HOSTEL REAL-TIME RECORD ENTRY / EXIT
POST /api/guard/hostel-record-entry
action: 'hostel_exit' | 'hostel_enter'

Business rules:
  hostel_exit:
    - 1st year (current_year = 1): always required
    - 2nd+ year: skip allowed if hostel_std_status already 'Out' at outpass creation
                 (auto_exit was set on hostel_visit_log)
    - Cannot exit if already Out
  hostel_enter:
    - Always required for ALL students regardless of year
    - On hostel_enter: if outpass std_status is still 'In' (student never went
      through main gate — e.g. short local trip), mark outpass complete
=================================================
*/
router.post(
    "/hostel-record-entry",
    asyncHandler(async (req, res) => {
        const { outpass_id, action, remark } = req.body;
        const device = req.guardDevice;
        const guardId = device.id;

        if (!outpass_id || !action) {
            throw new ApiError(400, "outpass_id and action ('hostel_exit' or 'hostel_enter') are required");
        }

        if (action !== "hostel_exit" && action !== "hostel_enter") {
            throw new ApiError(400, "Invalid action: must be 'hostel_exit' or 'hostel_enter'");
        }

        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            // Fetch outpass + student with year info
            const outpassRes = await client.query(
                `SELECT
                    o.*,
                    s.name,
                    s.roll_no,
                    s.current_year,
                    s.hostel_id AS student_hostel_id
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
            const isFirstYear = outpass.current_year === 1;

            // Guard should only manage students in their hostel
            if (device.hostel_id && outpass.student_hostel_id && device.hostel_id !== outpass.student_hostel_id) {
                throw new ApiError(403, "This student does not belong to your assigned hostel.");
            }

            if (outpass.outp_status !== "Approved") {
                throw new ApiError(400, "Outpass is not approved");
            }

            // ─── HOSTEL EXIT ───────────────────────────────────────────────────
            if (action === "hostel_exit") {
                if (outpass.hostel_std_status === "Out") {
                    throw new ApiError(400, "Student is already recorded as outside hostel");
                }

                // Create hostel_visit_log row with exit time
                await client.query(
                    `INSERT INTO hostel_visit_log
                        (outpass_id, student_id, hostel_id, hostel_exit_time, exit_guard_id, remark, auto_exit)
                     VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4, $5, false);`,
                    [outpass.id, outpass.student_id, device.hostel_id, guardId, remark || ""]
                );

                // Update hostel_std_status
                await client.query(
                    `UPDATE outpass
                     SET hostel_std_status = 'Out', updated_at = CURRENT_TIMESTAMP
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
                            hostel_status: "Out",
                            is_first_year: isFirstYear
                        },
                        "Hostel exit recorded successfully"
                    )
                );
            }

            // ─── HOSTEL ENTER ──────────────────────────────────────────────────
            if (action === "hostel_enter") {
                if (outpass.hostel_std_status !== "Out") {
                    throw new ApiError(400, "Student is not recorded as outside hostel");
                }

                // Update existing hostel_visit_log with entry time
                await client.query(
                    `UPDATE hostel_visit_log
                     SET hostel_entry_time = CURRENT_TIMESTAMP,
                         entry_guard_id = $1,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = (
                         SELECT id FROM hostel_visit_log
                         WHERE outpass_id = $2
                         ORDER BY created_at DESC
                         LIMIT 1
                     );`,
                    [guardId, outpass.id]
                );

                // Update hostel status back to In
                await client.query(
                    `UPDATE outpass
                     SET hostel_std_status = 'In', updated_at = CURRENT_TIMESTAMP
                     WHERE id = $1;`,
                    [outpass.id]
                );

                // If student also never left campus (std_status still 'In'),
                // the outpass journey is fully complete — close it.
                if (outpass.std_status === "In") {
                    await client.query(
                        `UPDATE outpass
                         SET is_active = false, updated_at = CURRENT_TIMESTAMP
                         WHERE id = $1;`,
                        [outpass.id]
                    );
                }

                await client.query("COMMIT");

                return res.status(200).json(
                    new ApiResponse(
                        200,
                        {
                            student_name: outpass.name,
                            roll_no: outpass.roll_no,
                            hostel_status: "In",
                            outpass_closed: outpass.std_status === "In",
                            is_first_year: isFirstYear
                        },
                        "Hostel entry recorded successfully"
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
OFFLINE HOSTEL GUARD LOGS SYNC
POST /api/guard/hostel-sync-logs
=================================================
*/
router.post(
    "/hostel-sync-logs",
    asyncHandler(async (req, res) => {
        const { logs } = req.body;
        const device = req.guardDevice;
        const guardId = device.id;

        if (!Array.isArray(logs) || logs.length === 0) {
            throw new ApiError(400, "logs array is required");
        }

        if (logs.length > 500) {
            throw new ApiError(400, "Maximum 500 logs allowed per sync request");
        }

        // Sort chronologically — hostel_exit before hostel_enter
        const sortedLogs = [...logs].sort((a, b) => {
            return new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime();
        });

        const synced_ids = [];
        const failed_ids = [];

        const client = await pool.connect();

        try {
            for (const log of sortedLogs) {
                const { id, outpass_id, action, remark, timestamp } = log;

                if (!id || !outpass_id || !action) {
                    failed_ids.push(id || "unknown");
                    continue;
                }

                const actionedAt = timestamp ? new Date(timestamp) : new Date();

                // Idempotency: skip if already synced
                const existing = await client.query(
                    `SELECT id FROM hostel_guard_action_log WHERE id = $1;`,
                    [id]
                );
                if (existing.rows.length > 0) {
                    synced_ids.push(id);
                    continue;
                }

                try {
                    await client.query("BEGIN");

                    const outpassRes = await client.query(
                        `SELECT o.id, o.student_id, o.outp_status, o.hostel_std_status, o.std_status,
                                s.current_year, s.hostel_id AS student_hostel_id
                         FROM outpass o
                         JOIN students s ON o.student_id = s.id
                         WHERE o.id = $1
                         FOR UPDATE;`,
                        [outpass_id]
                    );

                    if (outpassRes.rows.length === 0) {
                        await client.query("ROLLBACK");
                        failed_ids.push(id);
                        continue;
                    }

                    const outpass = outpassRes.rows[0];

                    if (action === "hostel_exit") {
                        if (outpass.hostel_std_status === "In" && outpass.outp_status === "Approved") {
                            await client.query(
                                `INSERT INTO hostel_visit_log
                                    (outpass_id, student_id, hostel_id, hostel_exit_time, exit_guard_id, remark, auto_exit)
                                 VALUES ($1, $2, $3, $4, $5, $6, false)
                                 ON CONFLICT DO NOTHING;`,
                                [outpass_id, outpass.student_id, device.hostel_id, actionedAt, guardId, remark || ""]
                            );

                            await client.query(
                                `UPDATE outpass SET hostel_std_status = 'Out', updated_at = CURRENT_TIMESTAMP WHERE id = $1;`,
                                [outpass_id]
                            );
                        }
                        // If already Out — treat as already synced, no error
                    } else if (action === "hostel_enter") {
                        if (outpass.hostel_std_status === "Out") {
                            await client.query(
                                `UPDATE hostel_visit_log
                                 SET hostel_entry_time = $1, entry_guard_id = $2, updated_at = CURRENT_TIMESTAMP
                                 WHERE outpass_id = $3 AND hostel_entry_time IS NULL;`,
                                [actionedAt, guardId, outpass_id]
                            );

                            await client.query(
                                `UPDATE outpass SET hostel_std_status = 'In', updated_at = CURRENT_TIMESTAMP WHERE id = $1;`,
                                [outpass_id]
                            );

                            // Close outpass if student never went through main gate
                            if (outpass.std_status === "In") {
                                await client.query(
                                    `UPDATE outpass SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1;`,
                                    [outpass_id]
                                );
                            }
                        }
                        // If already In — treat as already synced
                    } else {
                        await client.query("ROLLBACK");
                        failed_ids.push(id);
                        continue;
                    }

                    // Insert audit record (idempotent via ON CONFLICT DO NOTHING)
                    await client.query(
                        `INSERT INTO hostel_guard_action_log
                            (id, outpass_id, action, gate, remark, guard_id, actioned_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7)
                         ON CONFLICT (id) DO NOTHING;`,
                        [id, outpass_id, action, device.gate || "Hostel Gate", remark || "", guardId, actionedAt]
                    );

                    await client.query("COMMIT");
                    synced_ids.push(id);
                } catch (err) {
                    try { await client.query("ROLLBACK"); } catch (_) {}
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
                `Synced ${synced_ids.length} hostel log(s), failed ${failed_ids.length}`
            )
        );
    })
);

module.exports = router;
