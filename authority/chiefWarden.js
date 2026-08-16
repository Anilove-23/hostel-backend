const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const pool = require("../db/db");
const auth = require("../middleware/middleware");
const authorizeRoles = require("../middleware/authorizeRoles");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/apiError");
const ApiResponse = require("../utils/apiResponse");

/**
 * @desc    Get complete outpass details (Chief Warden unrestricted access)
 * @route   GET /api/chief-warden/outpasses/:id
 * @access  Private (Chief Warden only)
 */
router.get(
    "/outpasses/:id",
    auth,
    authorizeRoles("chief-warden"),
    asyncHandler(async (req, res) => {
        const { id } = req.params;

        if (!id) {
            throw new ApiError(400, "Invalid outpass ID");
        }

        const outpassQuery = `
            SELECT
                o.*,
                s.id AS student_id,
                s.name,
                s.roll_no,
                s.email,
                s.phone,
                s.father_name,
                s.parent_number,
                s.department,
                s.hostel,
                s.hostel_id,
                s.degree_type,
                r.room_number,
                a.name AS approved_by_name
            FROM outpass o
            JOIN students s ON o.student_id = s.id
            LEFT JOIN room r ON r.id = s.physical_room_id
            LEFT JOIN authority a ON a.id = o.approved_by
            WHERE o.id = $1;
        `;

        const outpassResult = await pool.query(outpassQuery, [id]);

        if (outpassResult.rows.length === 0) {
            throw new ApiError(404, "Outpass not found");
        }

        const remarksQuery = `
            SELECT
                r.id,
                r.outpass_id,
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
                "Outpass details fetched successfully"
            )
        );
    })
);

/**
 * @desc    Add Chief Warden remark to an outpass
 * @route   POST /api/chief-warden/outpasses/:id/remarks
 * @access  Private (Chief Warden only)
 */
router.post(
    "/outpasses/:id/remarks",
    auth,
    authorizeRoles("chief-warden"),
    asyncHandler(async (req, res) => {
        const { id } = req.params;
        const { remark } = req.body;

        if (!id) {
            throw new ApiError(400, "Invalid outpass ID");
        }

        if (!remark || typeof remark !== "string" || !remark.trim()) {
            throw new ApiError(400, "Remark cannot be empty");
        }

        const trimmedRemark = remark.trim();
        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            const outpassCheck = await client.query(
                `SELECT id FROM outpass WHERE id = $1`,
                [id]
            );

            if (outpassCheck.rows.length === 0) {
                throw new ApiError(404, "Outpass not found");
            }

            const remarkId = crypto.randomUUID();
            const insertRemarkQuery = `
                INSERT INTO outpass_remarks (id, outpass_id, admin_id, admin_role, remark, created_at)
                VALUES ($1, $2, $3, $4, $5, NOW())
                RETURNING id, outpass_id, admin_id, admin_role, remark, created_at;
            `;

            const insertResult = await client.query(insertRemarkQuery, [
                remarkId,
                id,
                req.user.id,
                "CHIEF_WARDEN",
                trimmedRemark
            ]);

            await client.query("COMMIT");

            return res.status(201).json(
                new ApiResponse(
                    201,
                    { remark: insertResult.rows[0] },
                    "Remark added successfully"
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

module.exports = router;
