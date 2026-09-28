# Event Manager

A server-rendered event booking application with organiser and attendee workflows, built with **Node.js, Express, EJS and SQLite**. Developed by **Faizan Ilyas** for Databases, Networks and the Web (CM2040), University of London.

## Features

- Organisers create draft events, edit details and ticket prices, publish events and review bookings.
- Attendees browse published events and book Standard, Student/Concession and VIP tickets, subject to available capacity.
- Event image uploads and editable site name and description.
- An organiser dashboard with charts derived from booking data.
- Separate organiser and attendee registration/login, session-based access and optional authenticator-app codes.
- Server-side form validation and request rate limiting.
- SQLite schema and rebuild scripts with two sample events.

## Run locally

Use Node.js 22 or later with npm. Run commands from the repository root.

```sh
npm ci
npm run build-db
```

**`build-db` deletes and recreates the local database.** It clears any accounts, events and bookings you have entered, then adds the demonstration events from `db_schema.sql`.

Set a randomly generated session secret before starting. The app reads `SESSION_SECRET` directly from the environment; it does not load `.env` files automatically.

**Windows PowerShell:**

```powershell
$env:SESSION_SECRET = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
npm start
```

**Linux/macOS:**

```sh
export SESSION_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
npm start
```

Open **http://localhost:3000**. Set `PORT` to use a different port. Changing the secret invalidates existing session cookies. `.env.example` documents the variable name if you use your own environment loader.

The `sqlite3` dependency uses a native module. If npm cannot obtain a compatible prebuilt binary, its installation may require the platform's native build tools.

## Try the workflows

1. Open `/auth/organiser/register` and create a fictional organiser account.
2. Log in at `/auth/organiser/login`, then visit `/organiser` to edit a draft or create an event.
3. Publish the event. View booking totals and charts at `/organiser/bookings` and `/organiser/dashboard`.
4. Log out and create an attendee account at `/auth/attendee/register`.
5. Open `/attendee`, select an event and submit a booking.

The Student/Concession option checks for a 13-digit identifier; it does not verify student status with an institution. Use fictional data while trying it. Optional two-factor setup displays a QR code for an authenticator app after registration and login.

## Structure and local data

```text
index.js          Express application and session setup
routes/           Main, authentication, organiser and attendee routes
lib/              Shared authentication, validation, flash and rate-limit helpers
views/            EJS pages and shared partials
public/           Styles; event uploads are generated locally
scripts/          Database build and cleanup scripts
db_schema.sql     Tables, constraints and demonstration events
```

`database.db`, uploaded images, dependencies and environment files are excluded from version control. The upload directory is created automatically. The repository contains no saved accounts, bookings or uploaded images.

## Coursework scope

This application is intended for local demonstration. It uses the default in-memory session store, shares events between organiser accounts and supports password recovery only with a previously enabled authenticator. It has no recovery option for accounts without an authenticator or for a lost device. Ticket bookings are recorded locally; there is no payment processing or email service.

## Attribution

This project was developed using the provided CM2040 course starter template (Express, EJS and SQLite). The original package metadata credited **Simon Katan**; that credit is retained in `contributors`. Third-party libraries and the course starter retain their original authorship and licensing.

## Tests

Run `npm test` after installing dependencies. The tests use a temporary database and uploads directory. They cover organiser and attendee access, event management, ticket validation, concurrent bookings, image uploads, two-factor login and password recovery.
