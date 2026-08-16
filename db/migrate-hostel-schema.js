const pool = require("./db");

const hasConstraint = async (client, tableName, constraintName) => {
    const result = await client.query(
        `SELECT 1
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         WHERE t.relname = $1 AND c.conname = $2`,
        [tableName, constraintName]
    );
    return result.rowCount > 0;
};

const addConstraint = async (client, tableName, constraintName, sql) => {
    if (!(await hasConstraint(client, tableName, constraintName))) {
        await client.query(`ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} ${sql}`);
    }
};

const getColumnType = async (client, tableName, columnName) => {
    const result = await client.query(
        `SELECT data_type
         FROM information_schema.columns
         WHERE table_name = $1 AND column_name = $2`,
        [tableName, columnName]
    );
    return result.rows[0]?.data_type;
};

async function migrate() {
    const client = await pool.connect();
    const warnings = [];

    try {
        await client.query("BEGIN");
        await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
        await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'room_type_enum') THEN
                    CREATE TYPE room_type_enum AS ENUM ('Student');
                ELSIF NOT EXISTS (
                    SELECT 1 FROM pg_enum e
                    JOIN pg_type t ON t.oid = e.enumtypid
                    WHERE t.typname = 'room_type_enum' AND e.enumlabel = 'Student'
                ) THEN
                    ALTER TYPE room_type_enum ADD VALUE 'Student';
                END IF;
            END $$;
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS hostel (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                name VARCHAR(255) UNIQUE NOT NULL,
                type VARCHAR(100),
                total_capacity INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                local_outpass_cutoff TIME NOT NULL DEFAULT '17:00:00'
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS room (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                hostel_id UUID NOT NULL REFERENCES hostel(id) ON DELETE RESTRICT,
                room_number VARCHAR(50) NOT NULL,
                block VARCHAR(50) DEFAULT NULL,
                room_type room_type_enum DEFAULT 'Student',
                max_capacity INT NOT NULL CHECK (max_capacity IN (1, 2, 3, 4, 5, 6)),
                current_occupancy INT DEFAULT 0 CHECK (current_occupancy >= 0 AND current_occupancy <= max_capacity),
                UNIQUE(hostel_id, block, room_number)
            )
        `);

        const studentHostelIdType = await getColumnType(client, "students", "hostel_id");
        const authorityHostelIdType = await getColumnType(client, "authority", "hostel_id");
        const physicalRoomIdType = await getColumnType(client, "students", "physical_room_id");
        const allocatedRoomIdType = await getColumnType(client, "students", "allocated_room_id");
        const degreeType = await getColumnType(client, "students", "degree_type");

        // Build the new hostel rows from the names already used by the application.
        await client.query(`
            INSERT INTO hostel (name)
            SELECT DISTINCT BTRIM(hostel)
            FROM students
            WHERE hostel IS NOT NULL AND BTRIM(hostel) <> ''
            ON CONFLICT (name) DO NOTHING
        `);
        await client.query(`
            INSERT INTO hostel (name)
            SELECT DISTINCT BTRIM(hostel)
            FROM authority
            WHERE hostel IS NOT NULL AND BTRIM(hostel) <> ''
            ON CONFLICT (name) DO NOTHING
        `);

        // Convert the legacy hostel-name/legacy-id values to actual UUID values.
        await client.query(`
            UPDATE students s
            SET hostel = h.name,
                hostel_id = h.id${studentHostelIdType === "uuid" ? "" : "::text"}
            FROM hostel h
            WHERE BTRIM(s.hostel) = h.name
        `);
        await client.query(`
            UPDATE authority a
            SET hostel = h.name,
                hostel_id = h.id${authorityHostelIdType === "uuid" ? "" : "::text"}
            FROM hostel h
            WHERE BTRIM(a.hostel) = h.name
        `);

        const unmappedStudents = await client.query(`
            SELECT COUNT(*)::int AS count
            FROM students
            WHERE hostel IS NULL OR BTRIM(hostel) = ''
        `);
        const unmappedAuthorities = await client.query(`
            SELECT COUNT(*)::int AS count
            FROM authority
            WHERE hostel IS NULL OR BTRIM(hostel) = ''
        `);
        if (unmappedStudents.rows[0].count || unmappedAuthorities.rows[0].count) {
            throw new Error("Cannot map blank hostel names to hostel.id");
        }

        if (studentHostelIdType !== "uuid") {
            await client.query(`
                ALTER TABLE students
                ALTER COLUMN hostel_id TYPE UUID USING NULLIF(BTRIM(hostel_id), '')::uuid
            `);
        }
        if (authorityHostelIdType !== "uuid") {
            await client.query(`
                ALTER TABLE authority
                ALTER COLUMN hostel_id TYPE UUID USING NULLIF(BTRIM(hostel_id), '')::uuid
            `);
        }

        // Preserve old room numbers by creating room rows before changing the FK columns.
        if (physicalRoomIdType !== "uuid" || allocatedRoomIdType !== "uuid") {
            if (physicalRoomIdType !== "uuid") {
                await client.query(`
                    INSERT INTO room (hostel_id, room_number, max_capacity)
                    SELECT DISTINCT hostel_id, BTRIM(physical_room_id), 6
                    FROM students
                    WHERE physical_room_id IS NOT NULL AND BTRIM(physical_room_id) <> ''
                    ON CONFLICT (hostel_id, block, room_number) DO NOTHING
                `);
                await client.query(`
                    UPDATE students s
                    SET physical_room_id = r.id::text
                    FROM room r
                    WHERE r.hostel_id = s.hostel_id
                      AND r.room_number = BTRIM(s.physical_room_id)
                `);
            }
            if (allocatedRoomIdType !== "uuid") {
                await client.query(`
                    INSERT INTO room (hostel_id, room_number, max_capacity)
                    SELECT DISTINCT hostel_id, BTRIM(allocated_room_id), 6
                    FROM students
                    WHERE allocated_room_id IS NOT NULL AND BTRIM(allocated_room_id) <> ''
                    ON CONFLICT (hostel_id, block, room_number) DO NOTHING
                `);
                await client.query(`
                    UPDATE students s
                    SET allocated_room_id = r.id::text
                    FROM room r
                    WHERE r.hostel_id = s.hostel_id
                      AND r.room_number = BTRIM(s.allocated_room_id)
                `);
            }
        }
        if (physicalRoomIdType !== "uuid") {
            await client.query("ALTER TABLE students ALTER COLUMN physical_room_id TYPE UUID USING NULLIF(BTRIM(physical_room_id), '')::uuid");
        }
        if (allocatedRoomIdType !== "uuid") {
            await client.query("ALTER TABLE students ALTER COLUMN allocated_room_id TYPE UUID USING NULLIF(BTRIM(allocated_room_id), '')::uuid");
        }
        if (degreeType !== "character varying") {
            await client.query("ALTER TABLE students ALTER COLUMN degree_type TYPE VARCHAR(100) USING degree_type::varchar(100)");
        }

        await addConstraint(client, "students", "students_hostel_id_fkey", "FOREIGN KEY (hostel_id) REFERENCES hostel(id) ON DELETE CASCADE");
        await addConstraint(client, "students", "students_physical_room_id_fkey", "FOREIGN KEY (physical_room_id) REFERENCES room(id) ON DELETE SET NULL");
        await addConstraint(client, "students", "students_allocated_room_id_fkey", "FOREIGN KEY (allocated_room_id) REFERENCES room(id) ON DELETE SET NULL");
        await addConstraint(client, "students", "students_hostel_name_fkey", "FOREIGN KEY (hostel) REFERENCES hostel(name) ON DELETE CASCADE");
        await addConstraint(client, "authority", "authority_hostel_id_fkey", "FOREIGN KEY (hostel_id) REFERENCES hostel(id) ON DELETE CASCADE");
        await addConstraint(client, "authority", "authority_hostel_name_fkey", "FOREIGN KEY (hostel) REFERENCES hostel(name) ON DELETE CASCADE");
        await addConstraint(client, "students", "students_name_roll_no_degree_type_key", "UNIQUE (name, roll_no, degree_type)");

        await client.query(`
            ALTER TABLE day_scholar
            ALTER COLUMN roll_no TYPE VARCHAR(100) USING roll_no::varchar(100),
            ALTER COLUMN degree_type TYPE VARCHAR(100) USING degree_type::varchar(100)
        `);
        // Existing day-scholar rows keep their identity but use the canonical student details.
        await client.query(`
            UPDATE day_scholar ds
            SET name = s.name, degree_type = s.degree_type
            FROM students s
            WHERE s.roll_no = ds.roll_no
        `);

        if (!(await hasConstraint(client, "day_scholar", "day_scholar_student_fk"))) {
            await client.query(`
                ALTER TABLE day_scholar
                ADD CONSTRAINT day_scholar_student_fk
                FOREIGN KEY (name, roll_no, degree_type)
                REFERENCES students(name, roll_no, degree_type)
                NOT VALID
            `);
        }

        const orphanDayScholars = await client.query(`
            SELECT COUNT(*)::int AS count
            FROM day_scholar ds
            LEFT JOIN students s
              ON s.name = ds.name
             AND s.roll_no = ds.roll_no
             AND s.degree_type IS NOT DISTINCT FROM ds.degree_type
            WHERE s.id IS NULL
        `);
        if (orphanDayScholars.rows[0].count === 0) {
            await client.query("ALTER TABLE day_scholar VALIDATE CONSTRAINT day_scholar_student_fk");
        } else {
            warnings.push(`${orphanDayScholars.rows[0].count} existing day_scholar row(s) do not match students; the new FK remains NOT VALID for legacy data.`);
        }

        await client.query("COMMIT");
        console.log("Hostel/room schema migration completed successfully.");
        for (const warning of warnings) console.warn(`Warning: ${warning}`);
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

migrate().catch((error) => {
    console.error("Hostel/room schema migration failed:", error.message);
    process.exitCode = 1;
});
