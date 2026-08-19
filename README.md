# ⚙️ NITH Hostel Management System — Backend API Service

[![Node.js](https://img.shields.io/badge/Node.js-v20%2B-green.svg)](https://nodejs.org/)
[![Express.js](https://img.shields.io/badge/Express.js-v4.19-lightgrey.svg)](https://expressjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-v15%2B-336791.svg)](https://www.postgresql.org/)
[![JWT](https://img.shields.io/badge/JWT-Tokens-orange.svg)](https://jwt.io/)
[![Security: Helmet](https://img.shields.io/badge/Security-Helmet%20%2B%20RateLimit-blue.svg)](https://helmetjs.github.io/)

The central REST API and database orchestration engine powering the **NIT Hamirpur Digital Hostel & Gate Pass Management System**. It manages student registrations, email OTP verifications, multi-tiered authority workflows (Chief Warden, Warden, Attendant), offline-first guard device activations, and real-time gate log synchronization.

---

## 📑 Table of Contents

- [Architecture Overview](#-architecture-overview)
- [Tech Stack](#-tech-stack)
- [Database Schema & ERD](#-database-schema--erd)
- [Security & Authentication Strategy](#-security--authentication-strategy)
- [API Reference](#-api-reference)
  - [1. Student Authentication (`/api/auth`)](#1-student-authentication-apiauth)
  - [2. Authority Authentication (`/api/authority`)](#2-authority-authentication-apiauthority)
  - [3. Outpass Management (`/api/outpass` & `/api/outpasses`)](#3-outpass-management-apioutpass--apioutpasses)
  - [4. Authority & Staff Management (`/api/management` & `/api/chief-warden`)](#4-authority--staff-management-apimanagement--apichief-warden)
  - [5. Guard Terminal & Gate Verification (`/api/guard`)](#5-guard-terminal--gate-verification-apiguard)
  - [6. Utility & Hostel Metadata (`/api/hostels`)](#6-utility--hostel-metadata-apihostels)
- [Environment Variables](#-environment-variables)
- [Installation & Local Setup](#-installation--local-setup)
- [Database Migrations & Seeding](#-database-migrations--seeding)
- [Automated Tests & Security Verification](#-automated-tests--security-verification)
- [Docker Deployment](#-docker-deployment)

---

## 🏛️ Architecture Overview

The backend is built following clean modular layering:

```plaintext
hostel-backend/
├── auth/                      # Authentication routes (login, signup, OTP, refresh, logout)
│   ├── sigup.js               # Student registration & @nith.ac.in email OTP dispatch
│   ├── login.js               # Student password/credential login & JWT issuance
│   ├── login-authority.js     # Authority (Chief Warden, Warden, Attendant) login
│   ├── otp.js                 # 6-digit OTP verification & account confirmation
│   ├── refresh.js             # Token refresh rotation with HTTP-only cookies
│   └── logout.js              # Token invalidation & cookie clearance
├── authority/                 # Administrative controllers
│   ├── chiefWarden.js         # Warden allotment, guard device approval & licensing
│   ├── authority.js           # Attendant allotment & hostel-level staff binding
│   ├── dashboard.js           # Authority outpass approval queues & audit logs
│   └── students.js            # Student room allotment, roster search & records
├── guard/                     # Gate security & terminal APIs
│   ├── deviceAuth.js          # Guard terminal hardware fingerprinting & activation
│   ├── guard.js               # Main Gate delta-sync, scan verification & day scholar
│   ├── hostelGuard.js         # Hostel Gate sync, check-in/check-out & night returns
│   └── license.js             # Cryptographic license token verification
├── outpass/                   # Student outpass lifecycle
│   └── outpass.js             # Apply, cancel, active status, history, cutoff checks
├── db/                        # Database pool, base SQL schema & migrations
│   ├── db.js                  # pg.Pool connection singleton with Neon/PostgreSQL
│   ├── db.sql                 # Base table schemas, constraints & enums
│   ├── migrate-hostel-guard.js # Hostel gate & delta-sync schema extensions
│   ├── migrate-guard-devices.js# Hardware fingerprinting & licensing migration
│   └── migrate-sessions.js    # Session store migration
├── middleware/                # Express middleware pipeline
│   ├── authorizeRoles.js      # Role-Based Access Control (RBAC) guard
│   ├── guardDeviceAuth.js     # Guard terminal hardware token & fingerprint check
│   ├── rateLimiter.js         # IP & endpoint-based brute-force limiters
│   └── middleware.js          # JWT token extractor (header & cookie support)
├── scripts/                   # Administrative CLI utilities
│   ├── reset-admin.js         # Reset/Create initial Chief Warden superadmin
│   ├── seed-hostels.js        # Seed all NITH boys and girls hostels & rooms
│   └── seed-staff.js          # Seed initial wardens and attendants
├── utils/                     # Shared utilities & response builders
│   ├── apiError.js            # Normalized error class with HTTP status codes
│   ├── apiResponse.js         # Standardized JSON response envelope
│   └── asyncHandler.js        # Express async wrapper to eliminate try/catch boilerplate
└── index.js                   # Application bootstrap, CORS, Helmet & route mounting
```

---

## 🛠️ Tech Stack

| Technology | Purpose |
| :--- | :--- |
| **Node.js (v20+)** | JavaScript asynchronous runtime environment. |
| **Express.js (v4.19)** | High-performance HTTP REST framework. |
| **PostgreSQL (v15+) / `pg`** | Relational database with UUID generation and relational constraints. |
| **`jsonwebtoken`** | Stateless Access Tokens & Refresh Tokens. |
| **`bcryptjs`** | Salted hashing for authority and student credentials. |
| **`helmet`** | Secures HTTP headers against XSS, clickjacking, and sniffing. |
| **`mailgun.js` & `form-data`** | Transactional delivery of email OTP codes to `@nith.ac.in`. |
| **`express-rate-limit`** | Rate limiting protection on authentication endpoints. |

---

## 🗄️ Database Schema & ERD

```mermaid
erDiagram
    HOSTEL ||--o{ ROOM : contains
    HOSTEL ||--o{ STUDENTS : houses
    HOSTEL ||--o{ AUTHORITY : employs
    HOSTEL ||--o{ GUARD_DEVICES : assigns
    ROOM ||--o{ STUDENTS : allocates
    STUDENTS ||--o{ OUTPASS : requests
    OUTPASS ||--o{ OUTPASS_REMARKS : has
    OUTPASS ||--o{ GUARD_ACTION_LOG : triggers
    OUTPASS ||--o{ HOSTEL_VISIT_LOG : tracks
    GUARD_DEVICES ||--o{ GUARD_ACTION_LOG : executes
    GUARD_DEVICES ||--o{ GUARD_DEVICE_LOGS : generates
    STUDENTS ||--o{ DAY_SCHOLAR : "is mapped to"
    DAY_SCHOLAR ||--o{ DAY_SCHOLAR_LOG : records

    HOSTEL {
        uuid id PK
        varchar name UK
        varchar type
        int total_capacity
        time local_outpass_cutoff
    }
    STUDENTS {
        text id PK
        varchar roll_no UK
        varchar email UK
        varchar name
        varchar hostel FK
        uuid hostel_id FK
        uuid physical_room_id FK
        varchar department
        varchar phone
        varchar parent_number
    }
    AUTHORITY {
        text id PK
        varchar email UK
        varchar name
        varchar status "attendent | warden | chief warden"
        uuid hostel_id FK
        boolean approved_by
    }
    GUARD_DEVICES {
        text id PK
        varchar phone UK
        varchar gate
        varchar guard_type "MAIN_GATE | HOSTEL_GATE"
        varchar activation_code
        text fingerprint_hash
        text device_token
        varchar status "PENDING_ACTIVATION | ACTIVE | REVOKED"
        uuid hostel_id FK
    }
    OUTPASS {
        text id PK
        text student_id FK
        varchar outpass_type "Local | Home | Outstation"
        varchar outp_status "Pending | Approved | Rejected | Cancelled"
        varchar std_status "In | Out"
        varchar hostel_std_status "In | Out"
        timestamp departure_datetime
        timestamp arrival_datetime
        text approved_by FK
    }
```

---

## 🔒 Security & Authentication Strategy

1. **Dual-Token JWT Lifecycle:**
   - **Access Token:** Short-lived (15 minutes), passed in `Authorization: Bearer <token>` header.
   - **Refresh Token:** Long-lived (7 days), stored in an `httpOnly`, `SameSite=None`, `Secure` cookie.
2. **Timing-Safe Activation Code Verification:**
   - Guard activation codes are verified via `crypto.timingSafeEqual(bufA, bufB)` to prevent side-channel timing analysis.
3. **Hardware Fingerprint Binding:**
   - Guard terminals generate a composite hardware hash. The backend validates this against the registered token on every scan request via `guardDeviceAuth` middleware.
4. **CSRF & CORS Origin Verification:**
   - Strict origin validation middleware blocks unauthorized mutating requests while allowing verified onrender.com and local development hosts.

---

## 📡 API Reference

### 1. Student Authentication (`/api/auth`)

#### `POST /api/auth/signup`
Initiates student registration and sends a 6-digit OTP to the student's `@nith.ac.in` email.
```json
// Request Body
{
  "name": "Arjun Sharma",
  "roll_no": "21BCSE101",
  "email": "21bcse101@nith.ac.in",
  "password": "StrongPassword123!",
  "phone": "9876543210",
  "parent_number": "9876543211",
  "department": "Computer Science and Engineering",
  "hostel": "Kailash Boys Hostel",
  "degree_type": "B.Tech"
}
```

#### `POST /api/auth/verify-otp`
Verifies OTP code and activates the student account.
```json
// Request Body
{
  "email": "21bcse101@nith.ac.in",
  "otp": "492810"
}
```

#### `POST /api/auth/login`
Authenticates a student and returns JWT credentials.
```json
// Response
{
  "success": true,
  "message": "Login successful",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI...",
  "user": {
    "id": "21BCSE101",
    "name": "Arjun Sharma",
    "email": "21bcse101@nith.ac.in",
    "roll_no": "21BCSE101",
    "hostel": "Kailash Boys Hostel",
    "role": "student"
  }
}
```

#### `GET /api/auth/refresh`
Rotates access token using the stored refresh cookie.

#### `POST /api/auth/logout`
Clears session cookies and invalidates client session.

---

### 2. Authority Authentication (`/api/authority`)

#### `POST /api/authority/login`
Authenticates Chief Warden, Hostel Warden, or Hostel Attendant.
```json
// Request Body
{
  "email": "warden.kailash@nith.ac.in",
  "password": "AuthorityPassword123"
}
```
```json
// Response Body
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1Ni...",
  "user": {
    "id": "AUTH-1092",
    "name": "Dr. Rajesh Kumar",
    "email": "warden.kailash@nith.ac.in",
    "role": "warden",
    "hostel": "Kailash Boys Hostel",
    "hostel_id": "8f3b61da-3e11-4770-9831-294b6ce10190"
  }
}
```

---

### 3. Outpass Management (`/api/outpass` & `/api/outpasses`)

#### `POST /api/outpass/apply`
Student submits a new outpass request.
```json
// Request Body
{
  "outpass_type": "Local",          // "Local" | "Home" | "Outstation"
  "place_of_visit": "Hamirpur Main Market",
  "purpose": "Purchase study materials and stationery",
  "departure_datetime": "2026-08-20T16:00:00.000Z",
  "arrival_datetime": "2026-08-20T19:30:00.000Z",
  "parent_contact": "9876543211",
  "is_emergency": false
}
```

#### `GET /api/outpass/my-outpasses`
Fetches past and active outpass history for the authenticated student.

#### `GET /api/outpass/active`
Returns currently active outpass with QR payload data.

#### `POST /api/outpass/cancel/:id`
Student cancels their own pending outpass.

#### `GET /api/outpasses/pending`
Authority fetches pending requests for their allotted hostel. Supports filtering by `type` (`Local` vs `Home`).

#### `PATCH /api/outpasses/:id/status`
Authority approves or rejects an outpass.
```json
// Request Body
{
  "status": "Approved",             // "Approved" | "Rejected"
  "remark": "Approved. Return before 8:00 PM strictly."
}
```

---

### 4. Authority & Staff Management (`/api/management` & `/api/chief-warden`)

#### `GET /api/chief-warden/wardens`
Chief Warden retrieves list of all hostels with their assigned wardens.

#### `POST /api/chief-warden/assign-warden`
Assigns a faculty member as Warden of a specific hostel.
```json
{
  "hostel_id": "8f3b61da-3e11-4770-9831-294b6ce10190",
  "warden_id": "AUTH-1092"
}
```

#### `GET /api/chief-warden/devices`
Retrieves all registered Guard Terminal devices, activation status, and last active IP/timestamps.

#### `POST /api/chief-warden/devices/create`
Registers a new Guard Terminal slot and generates an activation code.
```json
{
  "device_name": "Main Gate North Terminal",
  "phone": "9816012345",
  "gate": "Main Gate North",
  "guard_type": "MAIN_GATE"
}
```

#### `PATCH /api/chief-warden/devices/:id/approve`
Approves and activates a pending guard terminal after physical device fingerprint verification.

---

### 5. Guard Terminal & Gate Verification (`/api/guard`)

#### `POST /api/guard/device/activate`
Guard registers browser hardware fingerprint with activation code.
```json
{
  "phone": "9816012345",
  "activation_code": "ACT-849201",
  "fingerprint_hash": "a1b2c3d4e5f6...",
  "device_info": {
    "userAgent": "Mozilla/5.0 ...",
    "screenResolution": "1920x1080"
  }
}
```

#### `GET /api/guard/sync`
Guard terminal delta-pulls approved outpass records for local IndexedDB caching.
- Query Parameter: `?since=1724083200000` (timestamp of last sync).

#### `POST /api/guard/actions`
Guard terminal pushes buffered offline action records.
```json
{
  "actions": [
    {
      "id": "c71e28fa-7104-4b5c-bf77-1c3905cf525b",
      "outpass_id": "OUTP-91028",
      "action": "exit",              // "exit" | "enter"
      "gate": "Main Gate",
      "actioned_at": "2026-08-20T16:15:20.000Z",
      "remark": "Identity verified via ID card"
    }
  ]
}
```

#### `POST /api/guard/dayscholar/log`
Records entry/exit movement for non-hosteller Day Scholars.

---

### 6. Utility & Hostel Metadata (`/api/hostels`)

#### `GET /api/hostels`
Returns all hostels, gender types, capacity, and local outpass cutoff times.

#### `GET /api/hostels/by-name/:name/rooms`
Returns room list, numbers, and occupancy for a designated hostel.

---

## ⚙️ Environment Variables

Create a `.env` file in `hostel-backend/` based on the template below:

```env
# Server Runtime
PORT=4000
NODE_ENV=development

# Database Connection
DATABASE_URL=postgresql://postgres:postgres_password@localhost:5432/nith_hostel_db

# JWT Configuration
JWT_SECRET=super_secret_jwt_access_token_key_change_in_production
JWT_REFRESH_SECRET=super_secret_jwt_refresh_token_key_change_in_production
ACCESS_TOKEN_EXPIRY=15m
REFRESH_TOKEN_EXPIRY=7d

# Mailgun API (For Email OTP Delivery)
MAILGUN_API_KEY=key-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
MAILGUN_DOMAIN=mg.nith.ac.in

# Allowed Frontend Origins (Comma-separated)
FRONTEND_URL=http://localhost:5173
AUTHORITY_URL=http://localhost:5174
GUARD_URL=http://localhost:5175
```

---

## 🚀 Installation & Local Setup

```bash
# 1. Navigate to backend directory
cd hostel-backend

# 2. Install dependencies
npm install

# 3. Apply database schema and migrations
npm run db:migrate

# 4. Seed initial database data
node scripts/seed-hostels.js
node scripts/seed-staff.js

# 5. Start development server with hot-reload
npm run dev
```

---

## 🗄️ Database Migrations & Seeding

The repository contains standalone migration and seeder scripts in `db/` and `scripts/`:

| Command / Script | Functionality |
| :--- | :--- |
| `npm run db:migrate` | Runs `db/migrate-hostel-schema.js` to ensure all columns and enums are up to date. |
| `node db/migrate-guard-devices.js` | Adds guard device tables, fingerprint columns, and indexes. |
| `node db/migrate-hostel-guard.js` | Adds hostel-gate action logging tables and visit tracking models. |
| `node scripts/seed-hostels.js` | Populates all NITH hostels (Kailash, Himadri, Shivalik, Himgiri, Neelkanth, Ambika, Parvati, Manimahesh) and default rooms. |
| `node scripts/seed-staff.js` | Seeds initial Chief Warden, Wardens, and Attendants. |
| `node scripts/reset-admin.js` | Resets or provisions the master Chief Warden administrator credentials. |

---

## 🧪 Automated Tests & Security Verification

Run integrated automated security audits:

```bash
# Run security test suite (CORS, timing-safe checks, input sanitization)
npm run test:security

# Run hostel workflow regression test suite
npm run test:hostel-changes
```

---

## 🐳 Docker Deployment

The backend contains a production-ready multi-stage Alpine Docker image:

```bash
# Build the Docker image
docker build -t nith-hostel-backend .

# Run the container
docker run -d \
  -p 4000:5000 \
  --name nith-backend \
  --env-file .env \
  nith-hostel-backend
```
