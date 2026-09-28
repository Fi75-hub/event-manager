-- SQLite schema for the CM2040 Event Manager
PRAGMA foreign_keys=ON;

BEGIN TRANSACTION;

DROP TABLE IF EXISTS bookings;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS site_settings;
DROP TABLE IF EXISTS password_resets;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
    user_id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK (role IN ('organiser', 'attendee')),
    display_name TEXT NOT NULL,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    two_factor_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (two_factor_opt_in IN (0, 1)),
    two_factor_secret TEXT,
    is_2fa_enabled INTEGER NOT NULL DEFAULT 0 CHECK (is_2fa_enabled IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (role, email)
);

CREATE TABLE password_resets (
    reset_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE site_settings (
    settings_id INTEGER PRIMARY KEY,
    site_name TEXT NOT NULL,
    site_description TEXT NOT NULL
);

CREATE TABLE events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    state TEXT NOT NULL CHECK (state IN ('draft', 'published')),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    image_path TEXT,
    event_date TEXT NOT NULL,
    full_ticket_label TEXT NOT NULL DEFAULT 'Standard',
    concession_ticket_label TEXT NOT NULL DEFAULT 'Student',
    full_ticket_count INTEGER NOT NULL CHECK (full_ticket_count >= 0),
    full_ticket_price REAL NOT NULL CHECK (full_ticket_price >= 0),
    concession_ticket_count INTEGER NOT NULL CHECK (concession_ticket_count >= 0),
    concession_ticket_price REAL NOT NULL CHECK (concession_ticket_price >= 0),
    vip_ticket_label TEXT NOT NULL DEFAULT 'VIP',
    vip_ticket_count INTEGER NOT NULL DEFAULT 0 CHECK (vip_ticket_count >= 0),
    vip_ticket_price REAL NOT NULL DEFAULT 0 CHECK (vip_ticket_price >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    published_at TEXT
);

CREATE TABLE bookings (
    booking_id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    attendee_name TEXT NOT NULL,
    full_qty INTEGER NOT NULL CHECK (full_qty >= 0),
    concession_qty INTEGER NOT NULL CHECK (concession_qty >= 0),
    vip_qty INTEGER NOT NULL DEFAULT 0 CHECK (vip_qty >= 0),
    student_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
);

INSERT INTO site_settings (settings_id, site_name, site_description)
VALUES (1, 'Campus Events', 'Simple event listings with ticket booking.');

INSERT INTO events (
    state, title, description, event_date,
    full_ticket_label, concession_ticket_label,
    full_ticket_count, full_ticket_price,
    concession_ticket_count, concession_ticket_price,
    vip_ticket_label, vip_ticket_count, vip_ticket_price,
    created_at, updated_at, published_at
) VALUES (
    'published',
    'Welcome Mixer',
    'A casual meet-and-greet to kick things off.',
    date('now', '+10 day'),
    'Standard', 'Student',
    50, 10.00,
    30, 6.00,
    'VIP', 20, 25.00,
    datetime('now'), datetime('now'), datetime('now')
);

INSERT INTO events (
    state, title, description, event_date,
    full_ticket_label, concession_ticket_label,
    full_ticket_count, full_ticket_price,
    concession_ticket_count, concession_ticket_price,
    vip_ticket_label, vip_ticket_count, vip_ticket_price,
    created_at, updated_at
) VALUES (
    'draft',
    'Guest Talk',
    'Draft event: edit details, then publish when ready.',
    date('now', '+20 day'),
    'Standard', 'Student',
    100, 0.00,
    50, 0.00,
    'VIP', 0, 0.00,
    datetime('now'), datetime('now')
);

COMMIT;
