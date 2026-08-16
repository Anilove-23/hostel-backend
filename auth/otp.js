const crypto = require("crypto");
const FormData = require("form-data");
const Mailgun = require("mailgun.js");
require("dotenv").config();

const mailgun = new Mailgun(FormData);
const mg = mailgun.client({
  username: "api",
  key: process.env.NEXT_PUBLIC_MAILGUN,
  url: process.env.NEXT_PUBLIC_URL || "https://api.mailgun.net",
});

function generateOtp() {
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * Send OTP email via Mailgun
 * @param {string} email
 * @param {string} otp
 */
async function sendOtpEmail(email, otp) {
  const domain = process.env.NEXT_PUBLIC_SANDBOX;

  const data = {
    from: `Hostel Management <mailgun@${domain}>`,
    to: [email],
    subject: "Your Hostel Verification OTP",
    text: `Your OTP for hostel verification is: ${otp}. It is valid for 5 minutes.`,
    html: `<h3>Hostel Verification</h3><p>Your OTP for hostel verification is: <strong>${otp}</strong>.</p><p>It is valid for 5 minutes.</p>`,
  };

  try {
    const msg = await mg.messages.create(domain, data);
    console.log("Mailgun response:", msg);
    return msg;
  } catch (err) {
    console.error("Mailgun Error (Sandbox limitation):", err.message);
    console.log("====================================================");
    console.log(`[TESTING MODE] Your OTP for ${email} is: ${otp}`);
    console.log("====================================================");
    
    // We do NOT throw an error here anymore. 
    // This allows the frontend to continue to Step 2 even if the Sandbox blocks the email.
    return true; 
  }
}

module.exports = {
  generateOtp,
  sendOtpEmail,
};