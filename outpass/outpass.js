const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const pool = require("../db/db");
const auth = require("../middleware/middleware");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/apiError");
const ApiResponse = require("../utils/apiResponse");

/*
=================================================
CREATE OUTPASS
POST /api/outpass/create or POST /api/outpasses/create
=================================================
*/
router.post(
    "/create",
    auth,
    asyncHandler(async (req, res) => {
        const {
            outpass_type,
            place_of_visit,
            purpose,
            departure_datetime,
            arrival_datetime,
            parent_contact,
            is_emergency = false
        } = req.body;

        const studentId = req.user?.id;

        if (!studentId) {
            throw new ApiError(401, "Unauthorized: Student identity missing");
        }

        if (!outpass_type || !parent_contact) {
            throw new ApiError(400, "Required fields are missing: outpass_type and parent_contact are required");
        }

        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            // =================================================
            // FETCH STUDENT + HOSTEL
            // =================================================
            const studentQuery = `
                SELECT
                    s.id,
                    s.hostel_id,
                    s.hostel,
                    s.name,
                    h.local_outpass_cutoff
                FROM students s
                JOIN hostel h
                    ON s.hostel_id = h.id
                WHERE s.id = $1;
            `;

            const studentResult = await client.query(studentQuery, [studentId]);

            if (studentResult.rows.length === 0) {
                throw new ApiError(404, "Student or assigned hostel not found");
            }

            const student = studentResult.rows[0];

            if (!student.hostel_id) {
                throw new ApiError(400, "Student is not assigned to any hostel");
            }

            // =================================================
            // NORMALIZE OUTPASS TYPE
            // =================================================
            const rawType = outpass_type.trim().toLowerCase();
            const typeMap = {
                local: "Local",
                outstation: "Outstation",
                home: "Home"
            };

            const normalizedType = typeMap[rawType];
            if (!normalizedType) {
                throw new ApiError(400, "Invalid outpass type. Must be 'Local', 'Outstation', or 'Home'");
            }

            const isLocalOutpass = normalizedType === "Local";

            // =================================================
            // VALIDATE EMERGENCY FLAG
            // =================================================
            if (typeof is_emergency !== "boolean") {
                throw new ApiError(400, "Invalid emergency flag: must be a boolean");
            }

            // =================================================
            // AUTO HANDLE LOCAL OUTPASS / VALIDATE PURPOSE
            // =================================================
            const trimmedPlace = place_of_visit?.trim();
            const trimmedPurpose = purpose?.trim();

            const finalPlace = isLocalOutpass ? (trimmedPlace || "Local") : trimmedPlace;
            const finalPurpose = isLocalOutpass ? (trimmedPurpose || "Local Visit") : trimmedPurpose;

            if (!isLocalOutpass && (!finalPlace || !finalPurpose)) {
                throw new ApiError(
                    400,
                    "Place of visit and purpose are required for Home and Outstation outpasses."
                );
            }

            if (is_emergency && (!purpose || purpose.trim() === "")) {
                throw new ApiError(400, "Purpose is required for emergency outpass.");
            }

            // =================================================
            // CHECK EXISTING ACTIVE OUTPASS (Strict Segregation)
            // =================================================
            const existingQuery = `
                SELECT outpass_type
                FROM outpass
                WHERE
                    student_id = $1
                    AND is_active = true
                    AND outp_status IN ('Pending', 'Approved');
            `;

            const existingResult = await client.query(existingQuery, [studentId]);

            const hasLocal = existingResult.rows.some((row) => row.outpass_type === "Local");
            const hasLongTrip = existingResult.rows.some(
                (row) => row.outpass_type === "Home" || row.outpass_type === "Outstation"
            );

            if (isLocalOutpass && hasLocal) {
                throw new ApiError(400, "You already have an active Local outpass.");
            }

            if (!isLocalOutpass && hasLongTrip) {
                throw new ApiError(400, "You already have an active Home/Outstation outpass.");
            }

            // =================================================
            // VALIDATE DATE / TIME
            // =================================================
            let departure = null;
            let arrival = null;
            const today = new Date();

            if (departure_datetime) {
                departure = new Date(departure_datetime);
                if (isNaN(departure.getTime())) {
                    throw new ApiError(400, "Invalid departure date.");
                }

                if (isLocalOutpass) {
                    if (
                        today.getDate() !== departure.getDate() ||
                        today.getMonth() !== departure.getMonth() ||
                        today.getFullYear() !== departure.getFullYear()
                    ) {
                        throw new ApiError(400, "Local outpass departure must be on today's date");
                    }
                }

                // Allow 30 minute tolerance for past timestamps
                if (departure.getTime() < Date.now() - 1000 * 60 * 30) {
                    throw new ApiError(400, "Departure time cannot be in the past");
                }
            }

            if (arrival_datetime) {
                arrival = new Date(arrival_datetime);
                if (isNaN(arrival.getTime())) {
                    throw new ApiError(400, "Invalid arrival date.");
                }

                if (isLocalOutpass) {
                    if (
                        today.getDate() !== arrival.getDate() ||
                        today.getMonth() !== arrival.getMonth() ||
                        today.getFullYear() !== arrival.getFullYear()
                    ) {
                        throw new ApiError(400, "Local outpass arrival must be on today's date");
                    }
                }

                if (departure && arrival <= departure) {
                    throw new ApiError(400, "Arrival time must be after departure time");
                }
            }

            // =================================================
            // LOCAL OUTPASS CUTOFF VALIDATION
            // =================================================
            if (isLocalOutpass && departure && student.local_outpass_cutoff) {
                const departureMinutes = departure.getHours() * 60 + departure.getMinutes();
                const [cutoffHour, cutoffMinute] = String(student.local_outpass_cutoff)
                    .split(":")
                    .map(Number);
                const cutoffMinutes = cutoffHour * 60 + (cutoffMinute || 0);

                if (departureMinutes > cutoffMinutes && !is_emergency) {
                    throw new ApiError(
                        400,
                        `Local outpass departure cannot be after the hostel cutoff time (${student.local_outpass_cutoff}).`
                    );
                }
            }

            // =================================================
            // INSERT OUTPASS
            // =================================================
            const outpassId = crypto.randomUUID();
            const insertQuery = `
                INSERT INTO outpass (
                    id,
                    student_id,
                    outpass_type,
                    place_of_visit,
                    purpose,
                    departure_datetime,
                    arrival_datetime,
                    parent_contact,
                    outp_status,
                    std_status,
                    is_active,
                    is_emergency
                )
                VALUES (
                    $1, $2, $3, $4,
                    $5, $6, $7, $8,
                    'Pending', 'In', true, $9
                )
                RETURNING *, outp_status as status;
            `;

            const insertValues = [
                outpassId,
                studentId,
                normalizedType,
                finalPlace,
                finalPurpose,
                departure_datetime || null,
                arrival_datetime || null,
                parent_contact,
                is_emergency
            ];

            const insertResult = await client.query(insertQuery, insertValues);

            await client.query("COMMIT");

            const createdOutpass = insertResult.rows[0];

            return res.status(201).json(
                new ApiResponse(
                    201,
                    {
                        ...createdOutpass,
                        assigned_hostel: {
                            hostel_id: student.hostel_id,
                            hostel_name: student.hostel
                        }
                    },
                    `Outpass request sent to ${student.hostel} successfully`
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
GET MY OUTPASSES
GET /api/outpass/my or GET /api/outpass/me
=================================================
*/
const getMyOutpassesHandler = asyncHandler(async (req, res) => {
    const studentId = req.user?.id;

    if (!studentId) {
        throw new ApiError(401, "Unauthorized: Student login required");
    }

    const query = `
        SELECT 
            o.*,
            o.outp_status AS status,
            s.hostel,
            s.hostel_id,
            lr.latest_remark
        FROM outpass o
        JOIN students s
            ON o.student_id = s.id
        LEFT JOIN LATERAL (
            SELECT
                json_build_object(
                    'admin_id', r.admin_id,
                    'admin_role', r.admin_role,
                    'remark', r.remark,
                    'created_at', r.created_at
                ) AS latest_remark
            FROM outpass_remarks r
            WHERE r.outpass_id = o.id
            ORDER BY r.created_at DESC
            LIMIT 1
        ) lr ON true
        WHERE o.student_id = $1
        ORDER BY o.created_at DESC;
    `;

    const result = await pool.query(query, [studentId]);

    return res.status(200).json(
        new ApiResponse(200, result.rows, "Outpasses fetched successfully")
    );
});

router.get("/my", auth, getMyOutpassesHandler);
router.get("/me", auth, getMyOutpassesHandler);

/*
=================================================
GET ACTIVE OUTPASS
GET /api/outpass/active or GET /api/outpasses/active
=================================================
*/
router.get(
    "/active",
    auth,
    asyncHandler(async (req, res) => {
        const studentId = req.user?.id;

        if (!studentId) {
            throw new ApiError(401, "Unauthorized: Student login required");
        }

        const query = `
            SELECT
                o.*,
                o.outp_status AS status,
                s.hostel,
                s.hostel_id,
                COALESCE(
                    json_agg(
                        json_build_object(
                            'admin_id', r.admin_id,
                            'admin_role', r.admin_role,
                            'remark', r.remark,
                            'created_at', r.created_at
                        )
                        ORDER BY r.created_at ASC
                    ) FILTER (WHERE r.id IS NOT NULL),
                    '[]'::json
                ) AS remarks
            FROM outpass o
            JOIN students s
                ON o.student_id = s.id
            LEFT JOIN outpass_remarks r
                ON r.outpass_id = o.id
            WHERE
                o.student_id = $1
                AND o.is_active = true
            GROUP BY
                o.id,
                s.hostel,
                s.hostel_id
            ORDER BY
                CASE
                    WHEN o.outpass_type = 'Local' THEN 1
                    ELSE 2
                END,
                o.created_at DESC;
        `;

        const result = await pool.query(query, [studentId]);

        return res.status(200).json(
            new ApiResponse(200, result.rows, "Active outpasses fetched successfully")
        );
    })
);

/*
=================================================
CANCEL OUTPASS
PATCH /api/outpass/cancel/:id or PUT /api/outpass/:id/cancel
=================================================
*/
const cancelOutpassHandler = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const studentId = req.user?.id;

    if (!studentId) {
        throw new ApiError(401, "Unauthorized: Student login required");
    }

    if (!id) {
        throw new ApiError(400, "Invalid outpass ID");
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const checkQuery = `
            SELECT *
            FROM outpass
            WHERE id = $1 AND student_id = $2
            FOR UPDATE;
        `;

        const checkResult = await client.query(checkQuery, [id, studentId]);

        if (checkResult.rows.length === 0) {
            throw new ApiError(404, "Outpass not found");
        }

        const outpass = checkResult.rows[0];

        if (!outpass.is_active) {
            throw new ApiError(400, "Outpass is already inactive");
        }

        if (outpass.outp_status !== "Pending" && outpass.outp_status !== "Approved") {
            throw new ApiError(400, "Only Pending or Approved outpasses can be cancelled");
        }

        if (outpass.std_status === "Out") {
            throw new ApiError(400, "Cannot cancel outpass after exiting campus");
        }

        const updateQuery = `
            UPDATE outpass
            SET
                outp_status = 'Cancelled',
                is_active = false,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING *, outp_status as status;
        `;

        const updateResult = await client.query(updateQuery, [id]);

        await client.query("COMMIT");

        return res.status(200).json(
            new ApiResponse(
                200,
                updateResult.rows[0],
                "Outpass cancelled successfully"
            )
        );
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
});

router.patch("/cancel/:id", auth, cancelOutpassHandler);
router.put("/:id/cancel", auth, cancelOutpassHandler);

/*
=================================================
GET SINGLE OUTPASS
GET /api/outpass/:id
=================================================
*/
router.get(
    "/:id",
    auth,
    asyncHandler(async (req, res) => {
        const { id } = req.params;
        const studentId = req.user?.id;

        if (!studentId) {
            throw new ApiError(401, "Unauthorized: Student login required");
        }

        const outpassQuery = `
            SELECT
                o.*,
                o.outp_status AS status,
                s.name,
                s.roll_no,
                s.department,
                s.hostel,
                s.hostel_id,
                r.room_number AS room
            FROM outpass o
            JOIN students s ON o.student_id = s.id
            LEFT JOIN room r ON s.physical_room_id = r.id
            WHERE o.id = $1 AND o.student_id = $2;
        `;

        const outpassResult = await pool.query(outpassQuery, [id, studentId]);

        if (outpassResult.rows.length === 0) {
            throw new ApiError(404, "Outpass not found");
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
                    outpass: outpassResult.rows[0],
                    remarks: remarksResult.rows
                },
                "Outpass fetched successfully"
            )
        );
    })
);

module.exports = router;
