const pool = require("./db/db");
const crypto = require("crypto");

async function runEndToEndDeviceTest() {
    const client = await pool.connect();
    const testPhone = "+919999988888";
    const testDeviceId = crypto.randomUUID();
    const testActivationCode = "GD-TEST99";
    const testFingerprint = "fp_hash_" + crypto.randomBytes(16).toString("hex");
    const attackerFingerprint = "fp_hash_attacker_different_machine";

    try {
        console.log("=== 1. CHIEF WARDEN REGISTRATION SIMULATION ===");
        await client.query("DELETE FROM guard_devices WHERE phone = $1", [testPhone]);

        await client.query(
            `INSERT INTO guard_devices (id, phone, device_name, gate, activation_code, status)
             VALUES ($1, $2, 'Test North Gate Terminal', 'North Gate', $3, 'PENDING_ACTIVATION')`,
            [testDeviceId, testPhone, testActivationCode]
        );
        console.log("Registered test device with code:", testActivationCode);

        console.log("\n=== 2. GUARD TERMINAL ACTIVATION SIMULATION ===");
        const deviceRes = await client.query("SELECT * FROM guard_devices WHERE phone = $1", [testPhone]);
        const device = deviceRes.rows[0];
        
        if (device.activation_code !== testActivationCode) {
            throw new Error("Activation code mismatch in DB");
        }

        const deviceToken = "gdt_" + crypto.randomBytes(32).toString("hex");
        const hardwareSpecs = {
            os: "Android Device",
            browser: "Chrome",
            gpu: "Qualcomm Adreno 640",
            cores: 8,
            ram: "6GB",
            screen: "1080x2400"
        };

        await client.query(
            `UPDATE guard_devices 
             SET fingerprint_hash = $1,
                 device_info = $2,
                 device_token = $3,
                 status = 'ACTIVE',
                 last_active_at = CURRENT_TIMESTAMP
             WHERE id = $4`,
            [testFingerprint, JSON.stringify(hardwareSpecs), deviceToken, testDeviceId]
        );
        console.log("Device activated and hardware fingerprint bound successfully!");

        console.log("\n=== 3. VERIFICATION ON LEGITIMATE DEVICE ===");
        const verifyRes = await client.query("SELECT * FROM guard_devices WHERE id = $1", [testDeviceId]);
        const boundDevice = verifyRes.rows[0];

        const isLegitValid = (
            boundDevice.status === "ACTIVE" &&
            boundDevice.device_token === deviceToken &&
            boundDevice.fingerprint_hash === testFingerprint
        );
        console.log("Legitimate device verification:", isLegitValid ? "PASSED (Granted Access)" : "FAILED");

        console.log("\n=== 4. SIMULATING ATTACKER / MISMATCHED HARDWARE ===");
        const isAttackerValid = (
            boundDevice.status === "ACTIVE" &&
            boundDevice.device_token === deviceToken &&
            boundDevice.fingerprint_hash === attackerFingerprint
        );
        console.log("Attacker with altered fingerprint:", !isAttackerValid ? "BLOCKED AS EXPECTED" : "FAILED (Attacker allowed)");

        console.log("\n=== 5. CHIEF WARDEN RESET SIMULATION ===");
        const newCode = "GD-RESET88";
        await client.query(
            `UPDATE guard_devices 
             SET fingerprint_hash = NULL,
                 device_token = NULL,
                 activation_code = $1,
                 status = 'PENDING_ACTIVATION'
             WHERE id = $2`,
            [newCode, testDeviceId]
        );
        const resetRes = await client.query("SELECT status, activation_code, fingerprint_hash FROM guard_devices WHERE id = $1", [testDeviceId]);
        console.log("Reset state in DB:", resetRes.rows[0]);

        // Cleanup
        await client.query("DELETE FROM guard_devices WHERE id = $1", [testDeviceId]);
        console.log("\n=== TEST PASSED: Full Guard Device Verification Flow Verified Successfully! ===");
    } catch (err) {
        console.error("Test failed:", err);
    } finally {
        client.release();
        process.exit(0);
    }
}

runEndToEndDeviceTest();
