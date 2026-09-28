// index.js
// Main entry point for the Event Manager.

const express = require('express');
const app = express();
const port = 3000;
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
    throw new Error('Set SESSION_SECRET before starting the app. See README.md.');
}

//  keep requests predictable and avoid easy abuse.
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Limit request body sizes and number of parameters to reduce DoS risk.
app.use(express.urlencoded({ extended: false, limit: '20kb', parameterLimit: 50 }));
app.use(express.json({ limit: '20kb' }));

// Put a sensible timeout on slow requests so the server does not hang forever.
// Purpose: Apply short per-request timeouts to reduce slow-connection pileups.
// Inputs: req, res, next
// Outputs: Calls next() after setting timeouts
app.use(function (req, res, next) {
    req.setTimeout(10000);
    res.setTimeout(10000);
    next();
});

const session = require('express-session');
const { flashMiddleware } = require('./lib/flash');
const { rateLimit } = require('./lib/rateLimit');

app.use(
    session({
        secret: sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: 'lax'
        }
    })
);

// Flash messages are kept in the session and shown once.
app.use(flashMiddleware);

// Make the signed-in user available to every view.
// Purpose: Expose the signed-in user (if any) to all EJS views via res.locals.
// Inputs: req.session.user, res.locals, next
// Outputs: Calls next() with res.locals.currentUser set
app.use(function (req, res, next) {
    res.locals.currentUser = (req.session && req.session.user) ? req.session.user : null;
    next();
});

app.set('view engine', 'ejs');
app.use(express.static(__dirname + '/public'));

// Global rate limit for all dynamic routes.
app.use(rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 300,
    view: 'too-many-requests',
    message: 'Too many requests from your network. Please slow down and try again.'
}));

// Stricter rate limit for authentication routes to reduce brute forcing.
app.use('/auth', rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 40,
    view: 'too-many-requests',
    // Purpose: Create a separate rate-limit key for authentication routes.
    // Inputs: req (uses req.ip)
    // Outputs: String key used by the rate limiter
    key: function (req) {
        return (req.ip || 'unknown') + ':auth';
    },
    message: 'Too many sign-in attempts. Please wait a few minutes and try again.'
}));

const sqlite3 = require('sqlite3').verbose();

// Purpose: Open the SQLite database connection and enable foreign key enforcement.
// Inputs: Database file path, callback err
// Outputs: Initialised global.db connection (or process exit on error)
global.db = new sqlite3.Database('./database.db', function (err) {
    if (err) {
        console.error(err);
        process.exit(1);
    }

    console.log('Database connected');
    global.db.run('PRAGMA foreign_keys=ON');

    // Purpose: Check the events table schema and add the image_path column if missing (lightweight migration).
    // Inputs: SQLite callback (e, rows)
    // Outputs: Ensures events.image_path exists
    global.db.all("PRAGMA table_info(events)", function (e, rows) {
        if (e) {
            console.error(e);
            return;
        }
        const hasTable = Array.isArray(rows) && rows.length > 0;
        if (!hasTable) {
            return;
        }
        // Purpose: Scan PRAGMA results to see whether the image_path column already exists.
        // Inputs: r (table_info row)
        // Outputs: Boolean result used to decide if ALTER TABLE is needed
        const has = rows.some(function (r) { return r.name === 'image_path'; });
        if (!has) {
            // Purpose: Run the one-time schema change to add events.image_path when upgrading older databases.
            // Inputs: err2 (Error or null)
            // Outputs: Logs errors (no return value)
            global.db.run("ALTER TABLE events ADD COLUMN image_path TEXT", function (err2) {
                if (err2) {
                    console.error(err2);
                }
            });
        }
    });
});

const mainRoutes = require('./routes/main');
const authRoutes = require('./routes/auth');
const organiserRoutes = require('./routes/organiser');
const attendeeRoutes = require('./routes/attendee');

app.use('/', mainRoutes);
app.use('/auth', authRoutes);
app.use('/organiser', organiserRoutes);
app.use('/attendee', attendeeRoutes);

// Purpose: Catch-all handler for unknown routes (renders a friendly 404 page).
// Inputs: req.originalUrl, res
// Outputs: HTML 404 response 
app.use(function (req, res) {
    res.status(404).render('not-found', { path: req.originalUrl });
});

// Purpose: Central error handler to log exceptions and show a 500 error page.
// Inputs: err, req, res, next
// Outputs: HTML 500 response (renders error)
app.use(function (err, req, res, next) {
    console.error(err);
    res.status(500).render('error', { error: err });
});

// Purpose: Start the HTTP server and log the listening port.
// Inputs: port (number), listen callback
// Outputs: Running server instance assigned to `server`
const server = app.listen(port, function () {
    console.log(`Event Manager listening on port ${port}`);
});

// Extra timeouts to avoid slow-connection request pileups.
server.keepAliveTimeout = 5000;
server.headersTimeout = 12000;
server.requestTimeout = 10000;
