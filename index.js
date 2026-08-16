const express = require("express");
require('dotenv').config();
const login = require("./auth/login.js");
const outpass = require("./outpass/outpass.js");
const signup = require("./auth/sigup.js");
const loginAuthority = require("./auth/login-authority.js");
const management = require("./authority/authority.js");
const dashboard = require("./authority/dashboard.js");
const students = require("./authority/students.js");
const guard = require("./guard/guard.js");

const cors = require("cors");
const cookieParser = require("cookie-parser");
const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(cookieParser());

app.use("/api/auth", signup);
app.use("/api/auth", login);
app.use("/api/authority", loginAuthority);
app.use("/api/management", management);
app.use("/api/outpass", outpass);
app.use("/api/outpasses", dashboard);
app.use("/api/students", students);
app.use("/api/guard", guard);

// Mock endpoints to prevent frontend "Invalid server response" crashes
app.get("/complaint/all", (req, res) => res.json({ data: [] }));
app.get("/complaint/escalated", (req, res) => res.json({ data: [] }));
app.get("/api/hostels", (req, res) => res.json([]));

app.get("/", (req, res) => {
    res.json({ success: true, message: "Backend is clean and running!" });
});



app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
