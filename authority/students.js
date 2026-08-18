const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const router = express.Router();
const pool = require("../db/db");
const auth = require("../middleware/middleware");
const authorizeRoles = require("../middleware/authorizeRoles");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/apiError");
const ApiResponse = require("../utils/apiResponse");

// Helper to resolve admin/attendant hostel
async function resolveHostel(clientOrPool, user) {
    const role = (user.role || user.status || "").toLowerCase().replace(/[_-]/g, "");

    if (role === "chiefwarden") {
        return null;
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

    throw new ApiError(403, "Unauthorized role");
}

/*
=================================================
GET STUDENT HISTORY
GET /api/students/:id/history
=================================================
*/
router.get(
    "/:id/history",
    auth,
    asyncHandler(async (req, res) => {
        const studentId = req.params.id;
        if (!studentId) {
            throw new ApiError(400, "Student ID is required");
        }

        // 1. Fetch Student Profile
        const profileQuery = `
            SELECT 
                s.id, s.name, s.father_name, s.email, s.phone, s.roll_no, s.department,
                s.degree_type, s.current_year, s.joining_year,
                s.hostel, s.hostel_id,
                r.room_number AS room,
                r.room_number AS room_no
            FROM students s
            LEFT JOIN room r ON r.id = s.physical_room_id
            WHERE s.id = $1 OR s.roll_no = $1
            LIMIT 1;
        `;
        const profileResult = await pool.query(profileQuery, [studentId]);

        if (profileResult.rowCount === 0) {
            throw new ApiError(404, "Student not found");
        }

        const profile = profileResult.rows[0];
        const canonicalId = profile.id;

        // RBAC & Ownership Security Verification
        const userRole = (req.user?.role || req.user?.status || "").toLowerCase().replace(/[_-]/g, "");
        if (userRole === "student") {
            if (req.user.id !== profile.id && req.user.roll_no !== profile.roll_no && req.user.email !== profile.email) {
                throw new ApiError(403, "Access denied: You are only authorized to view your own profile and history");
            }
        } else if (userRole === "warden" || userRole === "attendant" || userRole === "attendent") {
            const hostelInfo = await resolveHostel(pool, req.user);
            if (hostelInfo && hostelInfo.hostel && profile.hostel !== hostelInfo.hostel) {
                throw new ApiError(403, `Access denied: Student is assigned to ${profile.hostel}, outside your assigned hostel (${hostelInfo.hostel})`);
            }
        } else if (userRole === "chiefwarden" || userRole === "guard") {
            // Full institutional access granted
        } else {
            throw new ApiError(403, "Access denied: Unauthorized role");
        }

        // 2. Fetch Outpasses
        const outpassQuery = `
            SELECT o.*, o.outp_status AS status
            FROM outpass o 
            WHERE o.student_id = $1 
            ORDER BY o.created_at DESC;
        `;

        // 3. Fetch Visit Logs
        const visitLogQuery = `
            SELECT vl.*, o.outpass_type, o.place_of_visit, o.purpose
            FROM visit_log vl
            JOIN outpass o ON vl.outpass_id = o.id
            WHERE vl.student_id = $1
            ORDER BY vl.actual_departure DESC NULLS LAST;
        `;

        const [outpassResult, visitLogResult] = await Promise.all([
            pool.query(outpassQuery, [canonicalId]),
            pool.query(visitLogQuery, [canonicalId])
        ]);

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    profile,
                    outpasses: outpassResult.rows,
                    visit_logs: visitLogResult.rows,
                    complaints: []
                },
                "Student history fetched successfully"
            )
        );
    })
);

/*
=================================================
SEARCH STUDENTS (QUERY STRING)
GET /api/students/search?q=
=================================================
*/
router.get(
    "/search",
    auth,
    authorizeRoles("warden", "chief-warden", "attendent", "guard"),
    asyncHandler(async (req, res) => {
        const q = (req.query.q || "").trim();
        if (!q || q.length < 2) {
            throw new ApiError(400, "Search query must be at least 2 characters");
        }

        const hostelInfo = await resolveHostel(pool, req.user).catch(() => null);
        let query = `SELECT id, name, roll_no, department, hostel
                     FROM students
                     WHERE (name ILIKE $1 OR roll_no ILIKE $1)`;
        const params = [`%${q}%`];

        if (hostelInfo && hostelInfo.hostel) {
            params.push(hostelInfo.hostel);
            query += ` AND hostel = $2`;
        }

        query += ` ORDER BY name ASC LIMIT 20`;

        const result = await pool.query(query, params);

        return res.status(200).json(
            new ApiResponse(200, { students: result.rows }, "Students search results")
        );
    })
);

/*
=================================================
SEARCH STUDENTS (POST BODY, PAGINATED)
POST /api/students/search
=================================================
*/
router.post(
    "/search",
    auth,
    authorizeRoles("warden", "chief-warden", "attendent", "guard"),
    asyncHandler(async (req, res) => {
        const { name, roll_no } = req.body;
        const page = parseInt(req.query.page, 10) || 1;
        const limit = Math.min(parseInt(req.query.limit, 10) || 10, 100);
        const offset = (page - 1) * limit;

        if (!name && !roll_no) {
            throw new ApiError(400, "Provide either name or roll number");
        }

        const hostelInfo = await resolveHostel(pool, req.user).catch(() => null);

        const conditions = [];
        const values = [];

        if (roll_no) {
            values.push(roll_no);
            conditions.push(`s.roll_no = $${values.length}`);
        }

        if (name) {
            values.push(name);
            conditions.push(`s.name ILIKE '%' || $${values.length} || '%'`);
        }

        let whereClause = `(${conditions.join(" OR ")})`;

        if (hostelInfo && hostelInfo.hostel) {
            values.push(hostelInfo.hostel);
            whereClause += ` AND s.hostel = $${values.length}`;
        }

        const dataQuery = `
            SELECT
                s.id,
                s.name,
                s.roll_no,
                s.email,
                s.phone,
                s.department,
                s.hostel,
                s.hostel_id,
                r.room_number AS room,
                s.created_at
            FROM students s
            LEFT JOIN room r ON s.physical_room_id = r.id
            WHERE ${whereClause}
            ORDER BY s.created_at DESC
            LIMIT $${values.length + 1} OFFSET $${values.length + 2};
        `;

        const countQuery = `
            SELECT COUNT(*) AS total
            FROM students s
            WHERE ${whereClause};
        `;

        const dataValues = [...values, limit, offset];

        const [result, countResult] = await Promise.all([
            pool.query(dataQuery, dataValues),
            pool.query(countQuery, values)
        ]);

        const total = parseInt(countResult.rows[0].total, 10);

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    students: result.rows,
                    pagination: {
                        page,
                        limit,
                        total,
                        totalPages: Math.ceil(total / limit),
                        hasNextPage: page < Math.ceil(total / limit),
                        hasPrevPage: page > 1
                    }
                },
                result.rows.length ? "Students fetched successfully" : "No matching students found"
            )
        );
    })
);

/*
=================================================
STUDENT DIRECTORY (WARDEN ONLY)
GET /api/students/directory?q=
=================================================
*/
router.get(
    "/directory",
    auth,
    authorizeRoles("warden", "chief-warden"),
    asyncHandler(async (req, res) => {
        const q = (req.query.q || "").trim();
        if (!q || q.length < 2) {
            throw new ApiError(400, "Query must be at least 2 characters");
        }

        const result = await pool.query(
            `SELECT s.id, s.name, s.roll_no, s.department, s.hostel, s.hostel_id,
                    r.id AS room_id, r.room_number, r.room_type AS room_status
             FROM students s
             LEFT JOIN room r ON s.physical_room_id = r.id
             WHERE s.name ILIKE $1 OR s.roll_no ILIKE $1
             ORDER BY s.name ASC
             LIMIT 20`,
            [`%${q}%`]
        );

        const students = result.rows.map((row) => ({
            id: row.id,
            name: row.name,
            rollNo: row.roll_no,
            department: row.department,
            allocation: row.room_id
                ? {
                      hostelId: row.hostel_id,
                      hostelName: row.hostel,
                      roomId: row.room_id,
                      roomNumber: row.room_number,
                      roomStatus: row.room_status
                  }
                : null
        }));

        return res.status(200).json(
            new ApiResponse(200, { students }, "Directory search successful")
        );
    })
);

/*
=================================================
OUTPASSES IN RANGE
POST /api/students/range
=================================================
*/
router.post(
    "/range",
    auth,
    authorizeRoles("warden", "chief-warden", "attendent", "guard"),
    asyncHandler(async (req, res) => {
        const { departure_datetime, arrival_datetime } = req.body;

        const page = parseInt(req.query.page, 10) || 1;
        const limit = Math.min(parseInt(req.query.limit, 10) || 10, 100);
        const offset = (page - 1) * limit;

        if (!departure_datetime || !arrival_datetime) {
            throw new ApiError(400, "Provide departure_datetime and arrival_datetime");
        }

        const hostelInfo = await resolveHostel(pool, req.user);

        let whereConditions = ["o.departure_datetime <= $2", "o.arrival_datetime >= $1"];
        let params = [departure_datetime, arrival_datetime];

        if (hostelInfo) {
            params.push(hostelInfo.hostel);
            whereConditions.push(`s.hostel = $${params.length}`);
        } else if (req.body.hostel && req.body.hostel !== "All") {
            params.push(req.body.hostel);
            whereConditions.push(`s.hostel = $${params.length}`);
        }

        const whereSql = whereConditions.join(" AND ");

        const dataQuery = `
            SELECT
                s.id AS student_id,
                s.name,
                s.roll_no,
                s.department,
                s.email,
                s.phone,
                s.hostel,
                r.room_number AS room,
                o.id AS outpass_id,
                o.parent_contact,
                o.outpass_type,
                o.place_of_visit,
                o.purpose,
                o.departure_datetime,
                o.arrival_datetime,
                o.outp_status,
                o.std_status,
                o.created_at
            FROM students s
            JOIN outpass o ON o.student_id = s.id
            LEFT JOIN room r ON s.physical_room_id = r.id
            WHERE ${whereSql}
            ORDER BY o.departure_datetime DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2};
        `;

        const countQuery = `
            SELECT COUNT(*) AS total
            FROM students s
            JOIN outpass o ON o.student_id = s.id
            WHERE ${whereSql};
        `;

        const dataValues = [...params, limit, offset];

        const [result, countResult] = await Promise.all([
            pool.query(dataQuery, dataValues),
            pool.query(countQuery, params)
        ]);

        const total = parseInt(countResult.rows[0].total, 10);

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    students: result.rows,
                    data: result.rows,
                    pagination: {
                        page,
                        limit,
                        total,
                        totalPages: Math.ceil(total / limit),
                        hasNextPage: page < Math.ceil(total / limit),
                        hasPrevPage: page > 1
                    }
                },
                result.rows.length ? "Students fetched successfully" : "No students found in range"
            )
        );
    })
);

/*
=================================================
GET HOSTEL OUTPASSES BY STATUS
POST /api/students/hostel-status
=================================================
*/
router.post(
    "/hostel-status",
    auth,
    authorizeRoles("warden", "chief-warden", "attendent", "guard"),
    asyncHandler(async (req, res) => {
        const { outp_status } = req.body;
        const page = parseInt(req.query.page, 10) || 1;
        const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
        const offset = (page - 1) * limit;

        const hostelInfo = await resolveHostel(pool, req.user);

        let whereConditions = [];
        let params = [];

        if (hostelInfo) {
            params.push(hostelInfo.hostel);
            whereConditions.push(`s.hostel = $${params.length}`);
        } else if (req.body.hostel && req.body.hostel !== "All") {
            params.push(req.body.hostel);
            whereConditions.push(`s.hostel = $${params.length}`);
        }

        if (outp_status && outp_status !== "All") {
            params.push(outp_status);
            whereConditions.push(`o.outp_status = $${params.length}`);
        }

        const whereSql = whereConditions.length > 0 ? `WHERE ${whereConditions.join(" AND ")}` : "";

        const dataQuery = `
            SELECT
                o.id AS outpass_id,
                o.id,
                o.student_id,
                o.parent_contact,
                o.outpass_type,
                o.place_of_visit,
                o.purpose,
                o.departure_datetime,
                o.arrival_datetime,
                o.outp_status,
                o.std_status,
                o.created_at,
                s.name,
                s.roll_no,
                s.department,
                s.email,
                s.phone,
                s.hostel,
                r.room_number AS room,
                r.room_number AS room_no
            FROM outpass o
            JOIN students s ON o.student_id = s.id
            LEFT JOIN room r ON s.physical_room_id = r.id
            ${whereSql}
            ORDER BY o.created_at DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2};
        `;

        const countQuery = `
            SELECT COUNT(*) AS total
            FROM outpass o
            JOIN students s ON o.student_id = s.id
            ${whereSql};
        `;

        const dataValues = [...params, limit, offset];

        const [result, countResult] = await Promise.all([
            pool.query(dataQuery, dataValues),
            pool.query(countQuery, params)
        ]);

        const total = parseInt(countResult.rows[0].total, 10);

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    data: result.rows,
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
                "Hostel outpasses fetched successfully"
            )
        );
    })
);

/*
=================================================
GET ALL OUTPASSES BY STATUS (GLOBAL)
POST /api/students/status
=================================================
*/
router.post(
    "/status",
    auth,
    authorizeRoles("warden", "chief-warden", "attendent", "guard"),
    asyncHandler(async (req, res) => {
        const { outp_status } = req.body;
        const page = parseInt(req.query.page, 10) || 1;
        const limit = Math.min(parseInt(req.query.limit, 10) || 10, 100);
        const offset = (page - 1) * limit;

        if (!outp_status) {
            throw new ApiError(400, "Outpass status is required");
        }

        const hostelInfo = await resolveHostel(pool, req.user);
        let whereConditions = ["o.outp_status = $1"];
        let params = [outp_status];

        if (hostelInfo) {
            params.push(hostelInfo.hostel);
            whereConditions.push(`s.hostel = $${params.length}`);
        } else if (req.body.hostel && req.body.hostel !== "All") {
            params.push(req.body.hostel);
            whereConditions.push(`s.hostel = $${params.length}`);
        }

        const whereSql = `WHERE ${whereConditions.join(" AND ")}`;

        const dataQuery = `
            SELECT
                o.id AS outpass_id,
                o.id,
                o.student_id,
                o.parent_contact,
                o.outpass_type,
                o.place_of_visit,
                o.purpose,
                o.departure_datetime,
                o.arrival_datetime,
                o.outp_status,
                o.std_status,
                o.created_at,
                s.name,
                s.roll_no,
                s.department,
                s.email,
                s.phone,
                s.hostel,
                r.room_number AS room
            FROM outpass o
            JOIN students s ON o.student_id = s.id
            LEFT JOIN room r ON s.physical_room_id = r.id
            ${whereSql}
            ORDER BY o.created_at DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2};
        `;

        const countQuery = `
            SELECT COUNT(*) AS total
            FROM outpass o
            JOIN students s ON o.student_id = s.id
            ${whereSql};
        `;

        const dataValues = [...params, limit, offset];

        const [result, countResult] = await Promise.all([
            pool.query(dataQuery, dataValues),
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
                `${outp_status} outpasses fetched successfully`
            )
        );
    })
);

/*
=================================================
GET OUTPASS DETAILS
GET /api/students/outpass/:id
=================================================
*/
router.get(
    "/outpass/:id",
    auth,
    authorizeRoles("warden", "chief-warden", "attendent", "guard"),
    asyncHandler(async (req, res) => {
        const { id } = req.params;

        const outpassQuery = `
            SELECT 
                o.*, 
                s.name AS name, 
                s.roll_no AS roll_no, 
                s.department AS department,
                s.phone AS phone, 
                s.hostel AS hostel,
                s.degree_type AS degree_type,
                s.academic_year AS academic_year,
                r.room_number AS room,
                r.room_number AS room_no
            FROM outpass o 
            JOIN students s ON o.student_id = s.id
            LEFT JOIN room r ON r.id = s.physical_room_id
            WHERE o.id = $1;
        `;

        const outpassResult = await pool.query(outpassQuery, [id]);

        if (outpassResult.rows.length === 0) {
            throw new ApiError(404, "Outpass not found");
        }

        const outpassRecord = outpassResult.rows[0];

        // Scope check for warden/attendant
        const userRole = (req.user?.role || req.user?.status || "").toLowerCase().replace(/[_-]/g, "");
        if (userRole === "warden" || userRole === "attendant" || userRole === "attendent") {
            const hostelInfo = await resolveHostel(pool, req.user);
            if (hostelInfo && hostelInfo.hostel && outpassRecord.hostel !== hostelInfo.hostel) {
                throw new ApiError(403, `Access denied: Outpass belongs to ${outpassRecord.hostel}, outside your assigned hostel (${hostelInfo.hostel})`);
            }
        }

        const remarksQuery = `
            SELECT
                r.id,
                r.admin_id,
                r.admin_role,
                r.remark,
                r.created_at,
                COALESCE(a.name, 'System') AS author_name
            FROM outpass_remarks r
            LEFT JOIN authority a ON r.admin_id = a.id
            WHERE r.outpass_id = $1
            ORDER BY r.created_at ASC;
        `;

        const remarksResult = await pool.query(remarksQuery, [id]);

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    ...outpassRecord,
                    outpass: outpassRecord,
                    remarks: remarksResult.rows
                },
                "Outpass details fetched successfully"
            )
        );
    })
);

/*
=================================================
BULK RECORD ENTRY (GUARD / WARDEN / ATTENDANT)
POST /api/students/bulk-record-entry
=================================================
*/
router.post(
    "/bulk-record-entry",
    auth,
    authorizeRoles("warden", "chief-warden", "guard", "attendent"),
    asyncHandler(async (req, res) => {
        const { outpass_ids, action, gate } = req.body;
        const guardId = req.user?.id;

        if (!Array.isArray(outpass_ids) || outpass_ids.length === 0) {
            throw new ApiError(400, "No outpasses selected");
        }

        if (action !== "exit" && action !== "enter") {
            throw new ApiError(400, "Invalid action: must be 'exit' or 'enter'");
        }

        const ids = [...new Set(outpass_ids.map(String))];
        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            let processed = [];

            if (action === "exit") {
                /* ============ ATOMIC EXIT CTE ============ */
                const result = await client.query(
                    `
                    WITH updated AS (
                        UPDATE outpass o
                        SET
                            std_status = 'Out',
                            updated_at = CURRENT_TIMESTAMP
                        WHERE
                            o.id = ANY($1::text[])
                            AND o.outp_status = 'Approved'
                            AND o.std_status IS DISTINCT FROM 'Out'
                        RETURNING o.id AS outpass_id, o.student_id
                    ),
                    inserted AS (
                        INSERT INTO visit_log (
                            outpass_id,
                            student_id,
                            gate,
                            exit_guard_id,
                            actual_departure
                        )
                        SELECT
                            outpass_id,
                            student_id,
                            $2,
                            $3,
                            CURRENT_TIMESTAMP
                        FROM updated
                        RETURNING outpass_id
                    )
                    SELECT
                        u.outpass_id,
                        u.student_id,
                        s.name,
                        s.roll_no
                    FROM updated u
                    JOIN students s ON s.id = u.student_id;
                    `,
                    [ids, gate || "Main Gate", guardId]
                );

                processed = result.rows.map((row) => ({
                    outpass_id: row.outpass_id,
                    student_name: row.name,
                    roll_no: row.roll_no,
                    status: "Out"
                }));
            } else {
                /* ============ ATOMIC ENTRY CTE ============ */
                const result = await client.query(
                    `
                    WITH updated AS (
                        UPDATE outpass o
                        SET
                            std_status = 'In',
                            is_active = false,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE
                            o.id = ANY($1::text[])
                            AND o.std_status = 'Out'
                        RETURNING o.id AS outpass_id, o.student_id
                    ),
                    latest_visit AS (
                        SELECT DISTINCT ON (v.outpass_id)
                            v.id,
                            v.outpass_id
                        FROM visit_log v
                        WHERE v.outpass_id IN (SELECT outpass_id FROM updated)
                        ORDER BY v.outpass_id, v.created_at DESC
                    ),
                    updated_visit AS (
                        UPDATE visit_log v
                        SET
                            actual_arrival = CURRENT_TIMESTAMP,
                            entry_guard_id = $2,
                            updated_at = CURRENT_TIMESTAMP
                        FROM latest_visit lv
                        WHERE v.id = lv.id
                        RETURNING v.outpass_id
                    )
                    SELECT
                        u.outpass_id,
                        u.student_id,
                        s.name,
                        s.roll_no
                    FROM updated u
                    JOIN students s ON s.id = u.student_id;
                    `,
                    [ids, guardId]
                );

                processed = result.rows.map((row) => ({
                    outpass_id: row.outpass_id,
                    student_name: row.name,
                    roll_no: row.roll_no,
                    status: "In"
                }));
            }

            /* ============ Skipped IDs with Reasons ============ */
            const processedIds = new Set(processed.map((p) => p.outpass_id));
            const remainingIds = ids.filter((id) => !processedIds.has(id));

            let skipped = [];

            if (remainingIds.length > 0) {
                const statusResult = await client.query(
                    `SELECT id, outp_status, std_status FROM outpass WHERE id = ANY($1::text[]);`,
                    [remainingIds]
                );

                const statusMap = new Map(statusResult.rows.map((row) => [row.id, row]));

                skipped = remainingIds.map((id) => {
                    const row = statusMap.get(id);
                    if (!row) {
                        return { outpass_id: id, reason: "Not Found" };
                    }
                    if (action === "exit") {
                        if (row.outp_status !== "Approved") {
                            return { outpass_id: id, reason: "Not Approved" };
                        }
                        if (row.std_status === "Out") {
                            return { outpass_id: id, reason: "Already Out" };
                        }
                        return { outpass_id: id, reason: "Invalid State" };
                    }
                    if (row.std_status === "In") {
                        return { outpass_id: id, reason: "Already In" };
                    }
                    if (row.std_status !== "Out") {
                        return { outpass_id: id, reason: "Not Out" };
                    }
                    return { outpass_id: id, reason: "Invalid State" };
                });
            }

            await client.query("COMMIT");

            return res.status(200).json(
                new ApiResponse(
                    200,
                    {
                        processed_count: processed.length,
                        processed,
                        skipped_count: skipped.length,
                        skipped
                    },
                    `Bulk ${action} completed successfully`
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
GET OUTPASS CUTOFF
GET /api/students/outpass-cutoff
=================================================
*/
router.get(
    "/outpass-cutoff",
    auth,
    authorizeRoles("warden", "chief-warden"),
    asyncHandler(async (req, res) => {
        const hostelInfo = await resolveHostel(pool, req.user);
        const targetHostel = hostelInfo ? hostelInfo.hostel : req.query.hostel;

        const result = await pool.query(
            `SELECT id, name, local_outpass_cutoff FROM hostel WHERE name = $1 LIMIT 1;`,
            [targetHostel || "Hostel 1"]
        );

        if (result.rowCount === 0) {
            throw new ApiError(404, "Hostel not found");
        }

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    cutoffTime: result.rows[0].local_outpass_cutoff,
                    hostel: result.rows[0].name
                },
                "Outpass cutoff fetched successfully"
            )
        );
    })
);

/*
=================================================
UPDATE OUTPASS CUTOFF
PATCH /api/students/outpass-cutoff & POST /api/students/outpass-cutoff
=================================================
*/
const updateCutoffHandler = asyncHandler(async (req, res) => {
    const { cutoffTime } = req.body;

    if (!cutoffTime) {
        throw new ApiError(400, "Cutoff time is required");
    }

    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;
    if (!timeRegex.test(cutoffTime)) {
        throw new ApiError(400, "Invalid time format. Expected HH:MM or HH:MM:SS.");
    }

    const hostelInfo = await resolveHostel(pool, req.user);
    const targetHostel = hostelInfo ? hostelInfo.hostel : req.body.hostel;

    const result = await pool.query(
        `UPDATE hostel
         SET local_outpass_cutoff = $1
         WHERE name = $2
         RETURNING id, name, local_outpass_cutoff;`,
        [cutoffTime, targetHostel]
    );

    if (result.rowCount === 0) {
        throw new ApiError(404, "Hostel not found");
    }

    return res.status(200).json(
        new ApiResponse(
            200,
            {
                cutoffTime: result.rows[0].local_outpass_cutoff,
                hostel: result.rows[0].name
            },
            "Outpass submission deadline updated successfully"
        )
    );
});

router.patch("/outpass-cutoff", auth, authorizeRoles("warden", "chief-warden"), updateCutoffHandler);
router.post("/outpass-cutoff", auth, authorizeRoles("warden", "chief-warden"), updateCutoffHandler);

/*
=================================================
ASSIGN ATTENDANT
POST /api/students/assign-attendent
=================================================
*/
router.post(
    "/assign-attendent",
    auth,
    authorizeRoles("warden", "chief-warden"),
    asyncHandler(async (req, res) => {
        const { name, email, phone, password, hostel } = req.body;

        if (!name || !email || !phone || !password) {
            throw new ApiError(400, "Name, email, phone, and password are required");
        }

        const hostelInfo = await resolveHostel(pool, req.user);
        const targetHostel = hostelInfo ? hostelInfo.hostel : hostel;

        if (!targetHostel) {
            throw new ApiError(400, "Hostel is required to assign attendant");
        }

        const hostelRecord = await pool.query(
            `SELECT id, name FROM hostel WHERE name = $1 LIMIT 1;`,
            [targetHostel]
        );

        if (hostelRecord.rowCount === 0) {
            throw new ApiError(404, "Hostel not found");
        }

        const { id: hostelId, name: hostelName } = hostelRecord.rows[0];

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const existingAttendant = await pool.query(
            `SELECT id, email FROM authority WHERE hostel_id = $1 AND status = 'attendent' LIMIT 1;`,
            [hostelId]
        );

        if (existingAttendant.rowCount > 0) {
            const attendantId = existingAttendant.rows[0].id;

            const dupCheck = await pool.query(
                `SELECT id FROM authority WHERE email = $1 AND id <> $2;`,
                [email, attendantId]
            );

            if (dupCheck.rowCount > 0) {
                throw new ApiError(409, "Email is already in use by another authority account");
            }

            const updated = await pool.query(
                `UPDATE authority
                 SET name = $1, email = $2, phone = $3, password = $4, approved_by = true
                 WHERE id = $5
                 RETURNING id, name, email, phone, hostel, status;`,
                [name, email, phone, hashedPassword, attendantId]
            );

            return res.status(200).json(
                new ApiResponse(200, updated.rows[0], "Attendant updated successfully")
            );
        }

        const dupCheck = await pool.query(`SELECT id FROM authority WHERE email = $1;`, [email]);
        if (dupCheck.rowCount > 0) {
            throw new ApiError(409, "Email already exists");
        }

        const newId = crypto.randomUUID();
        const created = await pool.query(
            `INSERT INTO authority (id, name, email, password, phone, hostel, hostel_id, status, approved_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'attendent', true)
             RETURNING id, name, email, phone, hostel, status;`,
            [newId, name, email, hashedPassword, phone, hostelName, hostelId]
        );

        return res.status(201).json(
            new ApiResponse(201, created.rows[0], "Attendant created successfully")
        );
    })
);

module.exports = router;
