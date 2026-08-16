
CREATE TABLE IF NOT EXISTS students(
    id TEXT PRIMARY KEY,
    name             VARCHAR(255) NOT NULL,
    father_name      VARCHAR(255),
    email            VARCHAR(255) UNIQUE,
    password         VARCHAR(255),
    hostel           VARCHAR(255) NOT NULL,
    hostel_id        TEXT NOT NULL,
    roll_no          VARCHAR(100) UNIQUE,
    phone            VARCHAR(255),
    parent_number    VARCHAR(20),
    category         VARCHAR(50),
    blood_group      VARCHAR(10),
    state            VARCHAR(100),
    address          TEXT,
    pincode          VARCHAR(20),
    department       VARCHAR(255) NOT NULL,
    cgpa             NUMERIC(4,2),
    joining_year     INTEGER,
    current_year     INTEGER,                              
    individual_rank  INTEGER,
    is_allotted      BOOLEAN DEFAULT FALSE,
    physical_room_id  TEXT,
    allocated_room_id TEXT,
    face_enrolled    BOOLEAN DEFAULT FALSE,
    academic_year    TEXT,
    degree_type      TEXT,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS authority(
    id TEXT PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(255) NOT NULL,
    hostel VARCHAR(255) NOT NULL,
    hostel_id TEXT NOT NULL,
    approved_by BOOLEAN DEFAULT false,
    status VARCHAR(255) DEFAULT 'attendent',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS guard_devices(
    id TEXT PRIMARY KEY,
    phone VARCHAR(255) UNIQUE NOT NULL,
    status VARCHAR(255) DEFAULT 'offline',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS outpass (
    id TEXT PRIMARY KEY,
    student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    outpass_type VARCHAR(50) NOT NULL CHECK (outpass_type IN ('Home', 'Local', 'Outstation')),
    place_of_visit VARCHAR(255),
    purpose TEXT,
    departure_datetime TIMESTAMP,
    arrival_datetime TIMESTAMP,
    parent_contact VARCHAR(20) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    outp_status VARCHAR(50) DEFAULT 'Pending' CHECK (outp_status IN ('Pending', 'Approved', 'Rejected')),
    std_status VARCHAR(50) DEFAULT 'In' CHECK (std_status IN ('In', 'Out')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    approved_at TIMESTAMP,
    approved_by TEXT REFERENCES authority(id) ON DELETE SET NULL,
    is_emergency BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS outpass_remarks (
    id TEXT PRIMARY KEY,
    outpass_id TEXT NOT NULL REFERENCES outpass(id) ON DELETE CASCADE,
    admin_id TEXT NOT NULL,
    admin_role VARCHAR(20) NOT NULL CHECK (admin_role IN ('ATTENDANT','CHIEF_WARDEN','GUARD','SYSTEM')),
    remark TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


CREATE TABLE IF NOT EXISTS otp_verification(
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL,
    otp VARCHAR(6) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    is_verified BOOLEAN DEFAULT FALSE
);

CREATE TABLE guard_action_log (
    id UUID PRIMARY KEY,
    outpass_id TEXT NOT NULL REFERENCES outpass(id) ON DELETE CASCADE,
    action VARCHAR(10) NOT NULL CHECK (action IN ('exit', 'enter')),
    gate VARCHAR(100) DEFAULT 'Main Gate',
    remark TEXT,
    actioned_at TIMESTAMP WITH TIME ZONE NOT NULL,
    received_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS day_scholar (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    roll_no VARCHAR(255) UNIQUE NOT NULL,
    degree_type VARCHAR(100),
    phone VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS day_scholar_log (
    id TEXT PRIMARY KEY,
    day_scholar_id TEXT REFERENCES day_scholar(id) ON DELETE CASCADE,
    gate VARCHAR(255),
    direction VARCHAR(10) CHECK (direction IN ('ENTRY', 'EXIT')),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
