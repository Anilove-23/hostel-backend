const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const pool = require("../db/db");
const auth = require("../middleware/middleware");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/apiError");
const ApiResponse = require("../utils/apiResponse");

// Helper to resolve admin/attendant hostel
async function resolveHostel(clientOrPool, user) {
    const role = (user.role || user.status || "").toLowerCase().replace(/[_-]/g, "");

    if (role === "chiefwarden") {
        return null; // Chief warden has universal access
    }

    if (role === "warden") {
        const res = await clientOrPool.query(
            `SELECT hostel, hostel_id FROM authority WHERE id = $1 AND status = 'warden' LIMIT 1`,
            [user.id]
        );
        if (res.rows.length > 0) {
            return { hostel: res.rows[0].hostel, hostelId: res.rows[0].hostel_id };
        }
        if (user.hostel) {
            return { hostel: user.hostel, hostelId: user.hostel_id || null };
        }
        throw new ApiError(404, "Warden hostel mapping not found");
    }

    if (role === "attendant" || role === "attendent") {
        const res = await clientOrPool.query(
            `SELECT hostel, hostel_id FROM authority WHERE id = $1 AND status = 'attendent' LIMIT 1`,
            [user.id]
        );
        if (res.rows.length > 0) {
            return { hostel: res.rows[0].hostel, hostelId: res.rows[0].hostel_id };
        }
        if (user.hostel) {
            return { hostel: user.hostel, hostelId: user.hostel_id || null };
        }
        throw new ApiError(404, "Attendant hostel mapping not found");
    }

    throw new ApiError(403, "Unauthorized role for outpass authority operations");
}

// Helper to insert a remark within a transaction client
async function addRemarkTx(client, outpassId, user, remarkText) {
    if (!remarkText || !remarkText.trim()) return null;

    const remarkId = crypto.randomUUID();
    let adminRole = "ATTENDANT";
    const rawRole = (user.role || user.status || "").toUpperCase().replace(/[_-]/g, "");

    if (rawRole.includes("CHIEF")) {
        adminRole = "CHIEF_WARDEN";
    } else if (rawRole.includes("WARDEN")) {
        adminRole = "CHIEF_WARDEN"; // DB enum allows ATTENDANT, CHIEF_WARDEN, GUARD, SYSTEM
    } else if (rawRole.includes("GUARD")) {
        adminRole = "GUARD";
    } else if (rawRole.includes("SYSTEM")) {
        adminRole = "SYSTEM";
    }

    const res = await client.query(
        `INSERT INTO outpass_remarks (id, outpass_id, admin_id, admin_role, remark, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING *;`,
        [remarkId, outpassId, user.id, adminRole, remarkText.trim()]
    );
    return res.rows[0];
}

/*
=================================================
GET PENDING OUTPASSES
GET /api/outpasses/pending
=================================================
*/
router.get(
    "/pending",
    auth,
    asyncHandler(async (req, res) => {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
        const offset = (page - 1) * limit;

        const hostelInfo = await resolveHostel(pool, req.user);

        let query = `
            SELECT
                o.*,
                o.outp_status AS status,
                s.name,
                s.email,
                s.roll_no,
                s.phone,
                s.department,
                r.room_number AS room,
                s.hostel,
                s.hostel_id,
                s.degree_type
            FROM outpass o
            JOIN students s ON o.student_id = s.id
            LEFT JOIN room r ON s.physical_room_id = r.id
            WHERE o.outp_status = 'Pending' AND o.is_active = true
        `;
        const params = [];

        if (hostelInfo) {
            params.push(hostelInfo.hostel);
            query += ` AND s.hostel = $${params.length}`;
        } else if (req.query.hostel && req.query.hostel !== "All") {
            params.push(req.query.hostel);
            query += ` AND s.hostel = $${params.length}`;
        }

        query += ` ORDER BY o.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        const dataValues = [...params, limit, offset];

        let countQuery = `
            SELECT COUNT(*) AS total
            FROM outpass o
            JOIN students s ON o.student_id = s.id
            WHERE o.outp_status = 'Pending' AND o.is_active = true
        `;
        if (hostelInfo) {
            countQuery += ` AND s.hostel = $1`;
        } else if (req.query.hostel && req.query.hostel !== "All") {
            countQuery += ` AND s.hostel = $1`;
        }

        const [result, countResult] = await Promise.all([
            pool.query(query, dataValues),
            pool.query(countQuery, params)
        ]);

        const total = parseInt(countResult.rows[0].total, 10);

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    outpasses: result.rows,
                    pagination: {
                        page,
                        limit,
                        total,
                        totalPages: Math.ceil(total / limit),
                        hasNextPage: page < Math.ceil(total / limit),
                        hasPrevPage: page > 1
                    }
                },
                "Pending outpasses fetched successfully"
            )
        );
    })
);

/*
=================================================
MONITOR DASHBOARD
GET /api/outpasses/monitor
=================================================
*/
router.get(
    "/monitor",
    auth,
    asyncHandler(async (req, res) => {
        const { updated_since } = req.query;
        const hostelInfo = await resolveHostel(pool, req.user).catch(() => null);

        let targetHostel = null;
        if (hostelInfo) {
            targetHostel = hostelInfo.hostel;
        } else if (req.query.hostel && req.query.hostel !== "All") {
            targetHostel = req.query.hostel;
        }

        if (updated_since) {
            const ts = new Date(updated_since);
            if (isNaN(ts.getTime())) {
                throw new ApiError(400, "Invalid updated_since timestamp");
            }

            let deltaQuery = `
                SELECT
                    o.*,
                    o.outp_status AS status,
                    s.name,
                    s.roll_no,
                    s.department,
                    s.email,
                    s.phone,
                    r.room_number AS room,
                    s.hostel,
                    s.hostel_id,
                    s.degree_type
                FROM outpass o
                JOIN students s ON o.student_id = s.id
                LEFT JOIN room r ON s.physical_room_id = r.id
                WHERE (o.updated_at >= $1 OR o.created_at >= $1)
            `;
            const params = [ts.toISOString()];

            if (targetHostel) {
                params.push(targetHostel);
                deltaQuery += ` AND s.hostel = $2`;
            }

            deltaQuery += ` ORDER BY o.updated_at ASC`;

            const result = await pool.query(deltaQuery, params);

            return res.status(200).json(
                new ApiResponse(
                    200,
                    {
                        outpasses: result.rows,
                        delta: true,
                        server_time: new Date().toISOString()
                    },
                    "Delta outpass updates fetched successfully"
                )
            );
        }

        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 50;
        const offset = (page - 1) * limit;

        let query = `
            SELECT 
                o.*, 
                o.outp_status AS status,
                s.name, 
                s.roll_no, 
                s.department,
                s.phone, 
                s.hostel,
                s.degree_type,
                r.room_number AS room,
                r.room_number AS room_no
            FROM outpass o 
            JOIN students s ON o.student_id = s.id
            LEFT JOIN room r ON s.physical_room_id = r.id
            WHERE 1=1
        `;
        const params = [];

        if (targetHostel) {
            params.push(targetHostel);
            query += ` AND s.hostel = $${params.length}`;
        }

        query += ` ORDER BY o.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

        const result = await pool.query(query, [...params, limit, offset]);

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    data: result.rows,
                    outpasses: result.rows,
                    server_time: new Date().toISOString()
                },
                "Monitor outpasses fetched successfully"
            )
        );
    })
);

/*
=================================================
LATE RETURNS
GET /api/outpasses/late-returns
=================================================
*/
router.get(
    "/late-returns",
    auth,
    asyncHandler(async (req, res) => {
        const hostelInfo = await resolveHostel(pool, req.user).catch(() => null);

        let targetHostel = null;
        if (hostelInfo) {
            targetHostel = hostelInfo.hostel;
        } else if (req.query.hostel && req.query.hostel !== "All") {
            targetHostel = req.query.hostel;
        }

        let query = `
            SELECT 
                o.*, 
                o.outp_status AS status,
                s.name, 
                s.roll_no, 
                s.department,
                s.phone, 
                s.hostel,
                r.room_number AS room,
                vl.actual_arrival
            FROM outpass o 
            JOIN students s ON o.student_id = s.id
            LEFT JOIN room r ON s.physical_room_id = r.id
            LEFT JOIN visit_log vl ON vl.outpass_id = o.id
            WHERE (o.std_status = 'Out' AND o.arrival_datetime < NOW())
               OR (o.outpass_type = 'Local' AND vl.actual_arrival IS NOT NULL AND vl.actual_arrival::time > '20:00:00'::time)
        `;
        const params = [];

        if (targetHostel) {
            params.push(targetHostel);
            query += ` AND s.hostel = $1`;
        }

        query += ` ORDER BY o.arrival_datetime ASC`;

        const result = await pool.query(query, params);

        return res.status(200).json(
            new ApiResponse(200, result.rows, "Late returns fetched successfully")
        );
    })
);

/*
=================================================
APPROVE OUTPASS
PATCH /api/outpasses/approve/:id
=================================================
*/
router.patch(
    "/approve/:id",
    auth,
    asyncHandler(async (req, res) => {
        const outpassId = req.params.id;
        const { remark } = req.body;
        const adminId = req.user?.id;

        if (!outpassId) {
            throw new ApiError(400, "Outpass ID is required");
        }

        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            const hostelInfo = await resolveHostel(client, req.user);

            let verifyQuery = `
                SELECT o.id, s.hostel
                FROM outpass o
                JOIN students s ON o.student_id = s.id
                WHERE o.id = $1 AND o.outp_status = 'Pending' AND o.is_active = true
                FOR UPDATE;
            `;
            const verifyParams = [outpassId];

            if (hostelInfo) {
                verifyQuery = `
                    SELECT o.id, s.hostel
                    FROM outpass o
                    JOIN students s ON o.student_id = s.id
                    WHERE o.id = $1 AND s.hostel = $2 AND o.outp_status = 'Pending' AND o.is_active = true
                    FOR UPDATE;
                `;
                verifyParams.push(hostelInfo.hostel);
            }

            const check = await client.query(verifyQuery, verifyParams);

            if (check.rowCount === 0) {
                throw new ApiError(403, "Unauthorized hostel access or outpass is not pending");
            }

            const updateResult = await client.query(
                `UPDATE outpass
                 SET outp_status = 'Approved',
                     approved_by = $1,
                     approved_at = CURRENT_TIMESTAMP,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2 AND outp_status = 'Pending' AND is_active = true
                 RETURNING *, outp_status as status;`,
                [adminId, outpassId]
            );

            if (updateResult.rowCount === 0) {
                throw new ApiError(400, "Failed to approve outpass");
            }

            if (remark && remark.trim()) {
                await addRemarkTx(client, outpassId, req.user, remark);
            }

            await client.query("COMMIT");

            return res.status(200).json(
                new ApiResponse(200, updateResult.rows[0], "Outpass approved successfully")
            );
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
REJECT OUTPASS
PATCH /api/outpasses/reject/:id
=================================================
*/
router.patch(
    "/reject/:id",
    auth,
    asyncHandler(async (req, res) => {
        const outpassId = req.params.id;
        const { remark } = req.body;

        if (!outpassId) {
            throw new ApiError(400, "Outpass ID is required");
        }

        const trimmedRemark = remark?.trim();
        if (!trimmedRemark) {
            throw new ApiError(400, "Remark is required while rejecting an outpass");
        }

        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            const hostelInfo = await resolveHostel(client, req.user);

            let verifyQuery = `
                SELECT o.id, s.hostel
                FROM outpass o
                JOIN students s ON o.student_id = s.id
                WHERE o.id = $1 AND o.outp_status = 'Pending' AND o.is_active = true
                FOR UPDATE;
            `;
            const verifyParams = [outpassId];

            if (hostelInfo) {
                verifyQuery = `
                    SELECT o.id, s.hostel
                    FROM outpass o
                    JOIN students s ON o.student_id = s.id
                    WHERE o.id = $1 AND s.hostel = $2 AND o.outp_status = 'Pending' AND o.is_active = true
                    FOR UPDATE;
                `;
                verifyParams.push(hostelInfo.hostel);
            }

            const check = await client.query(verifyQuery, verifyParams);

            if (check.rowCount === 0) {
                throw new ApiError(403, "Unauthorized hostel access or outpass is not pending");
            }

            const updateResult = await client.query(
                `UPDATE outpass
                 SET outp_status = 'Rejected',
                     is_active = false,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1 AND outp_status = 'Pending' AND is_active = true
                 RETURNING *, outp_status as status;`,
                [outpassId]
            );

            if (updateResult.rowCount === 0) {
                throw new ApiError(400, "Failed to reject outpass");
            }

            await addRemarkTx(client, outpassId, req.user, trimmedRemark);

            await client.query("COMMIT");

            return res.status(200).json(
                new ApiResponse(200, updateResult.rows[0], "Outpass rejected successfully")
            );
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
BULK ACTION (APPROVE / REJECT)
PATCH /api/outpasses/bulk-action
=================================================
*/
router.patch(
    "/bulk-action",
    auth,
    asyncHandler(async (req, res) => {
        const { ids, outpass_ids, action, remark } = req.body;
        const targetIds = ids || outpass_ids;

        if (!Array.isArray(targetIds) || targetIds.length === 0) {
            throw new ApiError(400, "ids array is required");
        }

        if (action !== "approve" && action !== "reject") {
            throw new ApiError(400, "Invalid action: must be 'approve' or 'reject'");
        }

        const trimmedRemark = remark?.trim();
        if (action === "reject" && !trimmedRemark) {
            throw new ApiError(400, "Remark is required while rejecting outpasses in bulk");
        }

        const uniqueIds = [...new Set(targetIds.map(String))];
        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            const hostelInfo = await resolveHostel(client, req.user);

            let verifyQuery = `
                SELECT o.id
                FROM outpass o
                JOIN students s ON o.student_id = s.id
                WHERE o.id = ANY($1::text[]) AND o.outp_status = 'Pending' AND o.is_active = true
                FOR UPDATE;
            `;
            const verifyParams = [uniqueIds];

            if (hostelInfo) {
                verifyQuery = `
                    SELECT o.id
                    FROM outpass o
                    JOIN students s ON o.student_id = s.id
                    WHERE o.id = ANY($1::text[]) AND s.hostel = $2 AND o.outp_status = 'Pending' AND o.is_active = true
                    FOR UPDATE;
                `;
                verifyParams.push(hostelInfo.hostel);
            }

            const verifyResult = await client.query(verifyQuery, verifyParams);
            const validIds = verifyResult.rows.map((r) => r.id);

            if (validIds.length === 0) {
                throw new ApiError(400, "No valid pending outpasses found for this action");
            }

            let updateResult;
            if (action === "approve") {
                updateResult = await client.query(
                    `UPDATE outpass
                     SET outp_status = 'Approved',
                         approved_by = $1,
                         approved_at = CURRENT_TIMESTAMP,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = ANY($2::text[])
                     RETURNING *, outp_status as status;`,
                    [req.user.id, validIds]
                );
            } else {
                updateResult = await client.query(
                    `UPDATE outpass
                     SET outp_status = 'Rejected',
                         is_active = false,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = ANY($1::text[])
                     RETURNING *, outp_status as status;`,
                    [validIds]
                );
            }

            if (trimmedRemark) {
                for (const vid of validIds) {
                    await addRemarkTx(client, vid, req.user, trimmedRemark);
                }
            }

            await client.query("COMMIT");

            return res.status(200).json(
                new ApiResponse(
                    200,
                    {
                        action,
                        affected_count: updateResult.rows.length,
                        outpasses: updateResult.rows
                    },
                    `Bulk ${action} completed successfully for ${updateResult.rows.length} outpass(es)`
                )
            );
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
GET REMARKS FOR AN OUTPASS
GET /api/outpasses/:id/remarks
=================================================
*/
router.get(
    "/:id/remarks",
    auth,
    asyncHandler(async (req, res) => {
        const outpassId = req.params.id;

        const result = await pool.query(
            `SELECT r.id, r.outpass_id, r.remark, r.created_at,
                    r.admin_id AS author_id, 
                    r.admin_role AS author_role,
                    COALESCE(a.name, 'System') AS author_name
             FROM outpass_remarks r
             LEFT JOIN authority a ON r.admin_id = a.id
             WHERE r.outpass_id = $1 
             ORDER BY r.created_at ASC;`,
            [outpassId]
        );

        return res.status(200).json(
            new ApiResponse(200, result.rows, "Remarks fetched successfully")
        );
    })
);

module.exports = router;
