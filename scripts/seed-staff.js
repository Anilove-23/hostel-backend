require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../db/db');

const DEFAULT_PASSWORD = '1234';

async function seedStaff() {
    console.log('Seeding staff (chief-warden, wardens, attendants, guards)...');
    const hashedPassword = await bcrypt.hash(DEFAULT_PASSWORD, 10);
    let client;
    
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        // Get hostels
        const res = await client.query('SELECT id, name FROM hostel');
        const hostels = res.rows;
        
        if (hostels.length === 0) {
            throw new Error('No hostels found in database. Please run seed-hostels.js first.');
        }

        // Use the first hostel as the base for global staff (Chief Warden, Guards)
        const globalHostel = hostels[0];

        // Helper to insert or skip authority
        async function upsertAuthority(email, name, phone, status, hostelName, hostelId, approved = true) {
            const check = await client.query('SELECT id FROM authority WHERE email = $1', [email]);
            if (check.rows.length === 0) {
                const newId = crypto.randomUUID();
                await client.query(`
                    INSERT INTO authority (id, email, password, name, phone, hostel, hostel_id, status, approved_by)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                `, [newId, email, hashedPassword, name, phone, hostelName, hostelId, status, approved]);
                return true;
            }
            return false;
        }

        // 1. Seed Chief Warden
        const cwEmail = 'chiefwarden@nith.ac.in';
        const cwAdded = await upsertAuthority(cwEmail, 'Chief Warden User', '9999999999', 'chief-warden', globalHostel.name, globalHostel.id);
        if (cwAdded) console.log('Seeded Chief Warden (chiefwarden@nith.ac.in).');

        // 2. Seed Wardens and Attendants for each hostel
        let wardensAdded = 0;
        let attendantsAdded = 0;

        for (let i = 0; i < hostels.length; i++) {
            const hostel = hostels[i];
            
            // Warden
            const wardenEmail = `warden.${hostel.name.toLowerCase().split(' ')[0]}@nith.ac.in`;
            const wAdded = await upsertAuthority(wardenEmail, `Warden ${hostel.name}`, `88888881${i}`, 'warden', hostel.name, hostel.id);
            if (wAdded) wardensAdded++;

            // Attendant
            const attendantEmail = `attendant.${hostel.name.toLowerCase().split(' ')[0]}@nith.ac.in`;
            const aAdded = await upsertAuthority(attendantEmail, `Attendant ${hostel.name}`, `88888882${i}`, 'attendent', hostel.name, hostel.id);
            if (aAdded) attendantsAdded++;
        }
        console.log(`Seeded ${wardensAdded} Wardens and ${attendantsAdded} Attendants.`);

        // 3. Seed Guards
        const guardEmails = ['guard1@nith.ac.in', 'guard2@nith.ac.in'];
        let guardsAdded = 0;
        for (let i = 0; i < guardEmails.length; i++) {
            const gAdded = await upsertAuthority(guardEmails[i], `Guard ${i+1}`, `777777777${i}`, 'guard', globalHostel.name, globalHostel.id);
            if (gAdded) guardsAdded++;
        }
        console.log(`Seeded ${guardsAdded} Guards.`);

        await client.query('COMMIT');
        console.log('✅ Successfully seeded all staff.');
    } catch (error) {
        if (client) await client.query('ROLLBACK');
        console.error('❌ Error seeding staff:', error);
    } finally {
        if (client) client.release();
        await pool.end();
        process.exit(0);
    }
}

seedStaff();
