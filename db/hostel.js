const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function findOrCreateHostel(client, { name, id } = {}) {
    const hostelName = typeof name === "string" ? name.trim() : "";

    if (UUID_RE.test(String(id || ""))) {
        const byId = await client.query("SELECT id, name FROM hostel WHERE id = $1", [id]);
        if (byId.rowCount > 0) return byId.rows[0];
    }

    if (!hostelName) return null;

    const result = await client.query(
        `INSERT INTO hostel (name)
         VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, name`,
        [hostelName]
    );
    return result.rows[0];
}

async function findOrCreateRoom(client, { hostelId, roomNumber }) {
    const normalizedRoomNumber = String(roomNumber || "").trim();
    if (!hostelId || !normalizedRoomNumber) return null;

    const existing = await client.query(
        `SELECT id, room_number
         FROM room
         WHERE hostel_id = $1 AND room_number = $2
         ORDER BY block NULLS FIRST
         LIMIT 1`,
        [hostelId, normalizedRoomNumber]
    );
    if (existing.rowCount > 0) return existing.rows[0];

    const created = await client.query(
        `INSERT INTO room (hostel_id, room_number, max_capacity)
         VALUES ($1, $2, 6)
         RETURNING id, room_number`,
        [hostelId, normalizedRoomNumber]
    );
    return created.rows[0];
}

module.exports = { findOrCreateHostel, findOrCreateRoom, UUID_RE };
