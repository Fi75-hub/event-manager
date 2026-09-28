// Organiser pages for managing site settings and events.

const express = require('express');
const router = express.Router();

const { requireRole } = require('../lib/auth');

const {
    cleanSingleLine,
    cleanMultiLine,
    isNonEmpty,
    toNonNegativeInt,
    toMoney,
    isISODate
} = require('../lib/validation');

const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { addFlash } = require('../lib/flash');

// Login
router.use(requireRole('organiser'));

// Purpose: Run a SELECT that returns a single row using sqlite3 and async/await.
// Inputs: sql (string), params (array)
// Outputs: Promise that resolves to one row (or undefined)
function dbGet(sql, params) {
    return new Promise(function (resolve, reject) {
        global.db.get(sql, params || [], function (err, row) {
            if (err) {
                reject(err);
                return;
            }
            resolve(row);
        });
    });
}

// Purpose: Run a SELECT that returns multiple rows using sqlite3 and async/await.
// Inputs: sql (string), params (array)
// Outputs: Promise that resolves to an array of rows
function dbAll(sql, params) {
    return new Promise(function (resolve, reject) {
        global.db.all(sql, params || [], function (err, rows) {
            if (err) {
                reject(err);
                return;
            }
            resolve(rows);
        });
    });
}

// Purpose: Run an INSERT/UPDATE/DELETE using sqlite3 and async/await.
// Inputs: sql (string), params (array)
// Outputs: Promise that resolves when the statement has run
function dbRun(sql, params) {
    return new Promise(function (resolve, reject) {
        global.db.run(sql, params || [], function (err) {
            if (err) {
                reject(err);
                return;
            }
            resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

// Input length limits keep forms tidy and protect the app from giant submissions.
const LIMITS = {
    siteName: 80,
    siteDescription: 500,
    eventTitle: 100,
    eventDescription: 2000,
    ticketLabel: 40
};

const uploadsRoot = path.join(__dirname, "..", "public", "uploads", "events");
fs.mkdirSync(uploadsRoot, { recursive: true });

// Purpose: Pick a safe file extension based on the uploaded image MIME type.
// Inputs: mime (string)
// Outputs: String extension such as .jpg, .png, or .webp
function extForMime(mime) {
    if (mime === "image/png") return ".png";
    if (mime === "image/webp") return ".webp";
    return ".jpg";
}

const uploadStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadsRoot);
    },
    filename: function (req, file, cb) {
        const eventId = String(req.params.id || "event").replace(/[^0-9]/g, "") || "event";
        const ts = Date.now();
        const rand = Math.floor(Math.random() * 1e9);
        const ext = extForMime(file.mimetype);
        cb(null, eventId + "-" + ts + "-" + rand + ext);
    }
});

const uploadEventImage = multer({
    storage: uploadStorage,
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: function (req, file, cb) {
        const ok = file && (file.mimetype === "image/jpeg" || file.mimetype === "image/png" || file.mimetype === "image/webp");
        if (!ok) {
            cb(new Error("Please upload a JPG, PNG, or WebP image."));
            return;
        }
        cb(null, true);
    }
});

// Purpose: Wrap the multer single-file upload and convert upload errors into a flash message + redirect.
// Inputs: req, res, next
// Outputs: Calls next() on success, otherwise redirects back to the edit page
function handleImageUpload(req, res, next) {
    uploadEventImage.single("event_image")(req, res, function (err) {
        if (err) {
            addFlash(req, "danger", err.message || "Upload failed.");
            res.redirect(`/organiser/events/${req.params.id}/edit`);
            return;
        }
        next();
    });
}

// Purpose: Render the organiser home page with site settings and lists of draft/published events.
// Inputs: req (organiser session), res, next
// Outputs: HTML response (renders organiser-home) or error via next(err)
router.get('/', async function (req, res, next) {
    try {
        const settings = await dbGet('SELECT site_name, site_description FROM site_settings WHERE settings_id = 1');
        const draftEvents = await dbAll(
            "SELECT e.*, " +
            "COALESCE(SUM(b.full_qty), 0) AS full_booked, " +
            "COALESCE(SUM(b.concession_qty), 0) AS concession_booked, " +
            "COALESCE(SUM(b.vip_qty), 0) AS vip_booked, " +
            "(e.full_ticket_count - COALESCE(SUM(b.full_qty), 0)) AS full_remaining, " +
            "(e.concession_ticket_count - COALESCE(SUM(b.concession_qty), 0)) AS concession_remaining, " +
            "(e.vip_ticket_count - COALESCE(SUM(b.vip_qty), 0)) AS vip_remaining " +
            "FROM events e " +
            "LEFT JOIN bookings b ON b.event_id = e.event_id " +
            "WHERE e.state = 'draft' " +
            "GROUP BY e.event_id " +
            "ORDER BY e.created_at DESC"
        );
        const publishedEvents = await dbAll(
            "SELECT e.*, " +
            "COALESCE(SUM(b.full_qty), 0) AS full_booked, " +
            "COALESCE(SUM(b.concession_qty), 0) AS concession_booked, " +
            "COALESCE(SUM(b.vip_qty), 0) AS vip_booked, " +
            "(e.full_ticket_count - COALESCE(SUM(b.full_qty), 0)) AS full_remaining, " +
            "(e.concession_ticket_count - COALESCE(SUM(b.concession_qty), 0)) AS concession_remaining, " +
            "(e.vip_ticket_count - COALESCE(SUM(b.vip_qty), 0)) AS vip_remaining " +
            "FROM events e " +
            "LEFT JOIN bookings b ON b.event_id = e.event_id " +
            "WHERE e.state = 'published' " +
            "GROUP BY e.event_id " +
            "ORDER BY e.event_date ASC, e.created_at DESC"
        );

        res.render('organiser-home', {
            settings: settings,
            draftEvents: draftEvents,
            publishedEvents: publishedEvents
        });
    } catch (err) {
        next(err);
    }
});


// Purpose: Show organiser dashboard graphs using aggregated booking and event statistics.
// Inputs: req (organiser session), res, next
// Outputs: HTML response (renders organiser-dashboard) or error via next(err)
router.get('/dashboard', async function (req, res, next) {
    // A simple organiser-only dashboard that visualises event and booking data.
    // All numbers come from the same SQLite database used by the rest of the app.

    try {
        const settings = await dbGet('SELECT site_name, site_description FROM site_settings WHERE settings_id = 1');

        const stateCounts = await dbGet(
            "SELECT " +
            "SUM(CASE WHEN state = 'draft' THEN 1 ELSE 0 END) AS draft_count, " +
            "SUM(CASE WHEN state = 'published' THEN 1 ELSE 0 END) AS published_count " +
            "FROM events"
        );

        const events = await dbAll(
            "SELECT event_id, state, title, event_date, " +
            "full_ticket_count, full_ticket_price, " +
            "concession_ticket_count, concession_ticket_price, " +
            "vip_ticket_count, vip_ticket_price, " +
            "created_at, updated_at, published_at " +
            "FROM events " +
            "ORDER BY event_date ASC, created_at DESC"
        );

        const soldByEventRows = await dbAll(
            "SELECT e.event_id AS event_id, " +
            "COALESCE(SUM(b.full_qty), 0) AS full_sold, " +
            "COALESCE(SUM(b.concession_qty), 0) AS concession_sold, " +
            "COALESCE(SUM(b.vip_qty), 0) AS vip_sold, " +
            "COALESCE(COUNT(b.booking_id), 0) AS booking_count " +
            "FROM events e " +
            "LEFT JOIN bookings b ON b.event_id = e.event_id " +
            "GROUP BY e.event_id"
        );

        const soldByEvent = {};
        soldByEventRows.forEach(function (row) {
            soldByEvent[row.event_id] = {
                full_sold: row.full_sold || 0,
                concession_sold: row.concession_sold || 0,
                vip_sold: row.vip_sold || 0,
                booking_count: row.booking_count || 0
            };
        });

        const eventMetrics = events.map(function (ev) {
            const sold = soldByEvent[ev.event_id] || { full_sold: 0, concession_sold: 0, vip_sold: 0, booking_count: 0 };

            const capacity = (ev.full_ticket_count || 0) + (ev.concession_ticket_count || 0) + (ev.vip_ticket_count || 0);
            const ticketsSold = (sold.full_sold || 0) + (sold.concession_sold || 0) + (sold.vip_sold || 0);

            const revenue =
                (sold.full_sold || 0) * (ev.full_ticket_price || 0) +
                (sold.concession_sold || 0) * (ev.concession_ticket_price || 0) +
                (sold.vip_sold || 0) * (ev.vip_ticket_price || 0);

            const occupancy = capacity > 0 ? (ticketsSold / capacity) : 0;

            return {
                event_id: ev.event_id,
                state: ev.state,
                title: ev.title,
                event_date: ev.event_date,
                capacity: capacity,
                ticketsSold: ticketsSold,
                bookingCount: sold.booking_count || 0,
                revenue: revenue,
                occupancy: occupancy
            };
        });

        const totals = eventMetrics.reduce(
            function (acc, ev) {
                acc.bookings += ev.bookingCount;
                acc.tickets += ev.ticketsSold;
                acc.revenue += ev.revenue;
                acc.capacity += ev.capacity;
                return acc;
            },
            { bookings: 0, tickets: 0, revenue: 0, capacity: 0 }
        );

        // Bookings per day for the last 30 days.
        const dailyRows = await dbAll(
            "SELECT date(created_at) AS day, " +
            "COUNT(*) AS bookings, " +
            "COALESCE(SUM(full_qty + concession_qty + vip_qty), 0) AS tickets " +
            "FROM bookings " +
            "WHERE date(created_at) >= date('now', '-29 day') " +
            "GROUP BY day " +
            "ORDER BY day ASC"
        );

        const dailyMap = {};
        dailyRows.forEach(function (r) {
            dailyMap[r.day] = { bookings: r.bookings || 0, tickets: r.tickets || 0 };
        });

        const last30 = [];
        const today = new Date();
        // Use UTC dates so our labels align with SQLite's date('now') behaviour.
        for (let i = 29; i >= 0; i -= 1) {
            const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
            d.setUTCDate(d.getUTCDate() - i);
            const day = d.toISOString().slice(0, 10);
            const value = dailyMap[day] || { bookings: 0, tickets: 0 };
            last30.push({ day: day, bookings: value.bookings, tickets: value.tickets });
        }

        // Top events for charts.
        const topByRevenue = eventMetrics
            .slice()
            .sort(function (a, b) { return b.revenue - a.revenue; })
            .slice(0, 8);

        const topByOccupancy = eventMetrics
            .filter(function (e) { return e.capacity > 0; })
            .slice()
            .sort(function (a, b) { return b.occupancy - a.occupancy; })
            .slice(0, 8);

        // Purpose: Create a short label for an event (used in dashboard lists/labels).
        // Inputs: ev (event row)
        // Outputs: Short string label for UI display
        function labelFor(ev) {
            const max = 24;
            if (!ev.title) {
                return `Event ${ev.event_id}`;
            }
            return ev.title.length > max ? ev.title.slice(0, max - 1) + '…' : ev.title;
        }

        const dashboardData = {
            stateCounts: {
                draft: stateCounts ? (stateCounts.draft_count || 0) : 0,
                published: stateCounts ? (stateCounts.published_count || 0) : 0
            },
            totals: {
                events: eventMetrics.length,
                bookings: totals.bookings,
                tickets: totals.tickets,
                capacity: totals.capacity,
                revenue: Math.round(totals.revenue * 100) / 100
            },
            topRevenue: topByRevenue.map(function (ev) {
                return { label: labelFor(ev), value: Math.round(ev.revenue * 100) / 100 };
            }),
            topOccupancy: topByOccupancy.map(function (ev) {
                return { label: labelFor(ev), value: Math.round(ev.occupancy * 1000) / 10 }; // percent, 1dp
            }),
            last30: last30
        };

        res.render('organiser-dashboard', {
            settings: settings,
            dashboard: dashboardData
        });
    } catch (err) {
        next(err);
    }
});


// Purpose: Show a list of bookings to the organiser, optionally filtered by event.
// Inputs: req.query (optional event filter), req (organiser session), res, next
// Outputs: HTML response (renders organiser-bookings) or error via next(err)
router.get('/bookings', async function (req, res, next) {
    // gives the organiser a clear view of every booking that has been made.
    // It is useful for checking demand and for confirming that ticket limits are being enforced.
    try {
        const settings = await dbGet('SELECT site_name, site_description FROM site_settings WHERE settings_id = 1');

        const eventIdRaw = req.query.event_id;
        const eventId = Number.parseInt(eventIdRaw, 10);
        const hasFilter = Number.isFinite(eventId);

        const events = await dbAll(
            "SELECT event_id, title, state, event_date " +
            "FROM events " +
            "ORDER BY event_date ASC, created_at DESC"
        );

        const bookings = await dbAll(
            "SELECT " +
            "b.booking_id, b.attendee_name, b.full_qty, b.concession_qty, b.vip_qty, b.student_id, b.created_at, " +
            "e.event_id, e.title AS event_title, e.event_date, " +
            "e.full_ticket_label, e.concession_ticket_label, e.vip_ticket_label, " +
            "(b.full_qty * e.full_ticket_price + b.concession_qty * e.concession_ticket_price + b.vip_qty * e.vip_ticket_price) AS total_cost " +
            "FROM bookings b " +
            "JOIN events e ON e.event_id = b.event_id " +
            (hasFilter ? "WHERE e.event_id = ? " : "") +
            "ORDER BY datetime(b.created_at) DESC",
            hasFilter ? [eventId] : []
        );

        res.render('organiser-bookings', {
            settings: settings,
            events: events,
            bookings: bookings,
            filterEventId: hasFilter ? eventId : null
        });
    } catch (err) {
        next(err);
    }
});

// Purpose: Render the site settings form prefilled from the database.
// Inputs: req (organiser session), res, next
// Outputs: HTML response (renders site-settings)
router.get('/settings', async function (req, res, next) {
    try {
        const settings = await dbGet('SELECT site_name, site_description FROM site_settings WHERE settings_id = 1');
        res.render('site-settings', { settings: settings, errors: [] });
    } catch (err) {
        next(err);
    }
});

// Purpose: Validate and save updated site settings to the database.
// Inputs: req.body (site_name, site_description), req (organiser session), res, next
// Outputs: Updates settings then redirects to /organiser, or re-renders with validation errors
router.post('/settings', async function (req, res, next) {
    try {
        const siteName = cleanSingleLine(req.body.site_name, LIMITS.siteName);
        const siteDescription = cleanMultiLine(req.body.site_description, LIMITS.siteDescription);

        const errors = [];
        if (!isNonEmpty(siteName)) {
            errors.push('Please enter a site name.');
        }
        if (!isNonEmpty(siteDescription)) {
            errors.push('Please enter a site description.');
        }

        if (errors.length > 0) {
            res.render('site-settings', {
                settings: { site_name: siteName, site_description: siteDescription },
                errors: errors
            });
            return;
        }

        await dbRun('UPDATE site_settings SET site_name = ?, site_description = ? WHERE settings_id = 1', [
            siteName,
            siteDescription
        ]);

        res.redirect('/organiser');
    } catch (err) {
        next(err);
    }
});

// Purpose: Create a new draft event and redirect to its edit page.
// Inputs: req (organiser session), res, next
// Outputs: Inserts a draft event row then redirects to /organiser/events/:id/edit
router.post('/events/new', async function (req, res, next) {
    try {
        const result = await dbRun(
            "INSERT INTO events (state, title, description, event_date, " +
            "full_ticket_label, concession_ticket_label, vip_ticket_label, " +
            "full_ticket_count, full_ticket_price, " +
            "concession_ticket_count, concession_ticket_price, " +
            "vip_ticket_count, vip_ticket_price, " +
            "created_at, updated_at) " +
            "VALUES ('draft', 'Untitled event', '', date('now', '+7 day'), " +
            "'Standard', 'Student', 'VIP', " +
            "0, 0, 0, 0, 0, 0, datetime('now'), datetime('now'))"
        );

        res.redirect(`/organiser/events/${result.lastID}/edit`);
    } catch (err) {
        next(err);
    }
});

// Purpose: Render the organiser edit page for one event (prefilled from the database).
// Inputs: req.params.id, req (organiser session), res, next
// Outputs: HTML response (renders organiser-edit-event) or 404 if event is missing
router.get('/events/:id/edit', async function (req, res, next) {
    try {
        const eventId = Number.parseInt(req.params.id, 10);
        if (!Number.isFinite(eventId)) {
            res.status(404).render('not-found', { path: req.originalUrl });
            return;
        }

        const event = await dbGet('SELECT * FROM events WHERE event_id = ?', [eventId]);
        if (!event) {
            res.status(404).render('not-found', { path: req.originalUrl });
            return;
        }

        res.render('organiser-edit-event', { event: event, errors: [] });
    } catch (err) {
        next(err);
    }
});



// Purpose: Delete an uploaded event image from disk, if the path is within the uploads folder.
// Inputs: relPath (string)
// Outputs: No return value (best-effort delete)
function removeUploadedEventImage(relPath) {
    if (!relPath) {
        return;
    }
    const abs = path.resolve(path.join(__dirname, "..", "public", relPath));
    const base = path.resolve(uploadsRoot) + path.sep;
    if (abs.indexOf(base) !== 0) {
        return;
    }
    fs.unlink(abs, function () { });
}

// Purpose: Upload an image for an event and store its relative path in the database.
// Inputs: req.params.id, req.file (uploaded image), req (organiser session), res, next
// Outputs: Saves image + updates event then redirects back to the edit page
router.post("/events/:id/image", handleImageUpload, async function (req, res, next) {
    try {
        const eventId = Number.parseInt(req.params.id, 10);
        if (!Number.isFinite(eventId)) {
            res.redirect("/organiser");
            return;
        }

        const event = await dbGet("SELECT event_id, image_path FROM events WHERE event_id = ?", [eventId]);
        if (!event) {
            res.status(404).render("not-found", { path: req.originalUrl });
            return;
        }

        if (!req.file) {
            addFlash(req, "danger", "Please choose an image to upload.");
            res.redirect(`/organiser/events/${eventId}/edit`);
            return;
        }

        const relPath = "uploads/events/" + req.file.filename;
        if (event.image_path) {
            removeUploadedEventImage(event.image_path);
        }

        await dbRun("UPDATE events SET image_path = ?, updated_at = datetime('now') WHERE event_id = ?", [relPath, eventId]);
        addFlash(req, "success", "Image uploaded.");
        res.redirect(`/organiser/events/${eventId}/edit`);
    } catch (err) {
        next(err);
    }
});

// Purpose: Remove the current event image from disk and clear its saved path.
// Inputs: req.params.id, req (organiser session), res, next
// Outputs: Deletes file (if present), updates DB, then redirects back to the edit page
router.post("/events/:id/image/delete", async function (req, res, next) {
    try {
        const eventId = Number.parseInt(req.params.id, 10);
        if (!Number.isFinite(eventId)) {
            res.redirect("/organiser");
            return;
        }

        const event = await dbGet("SELECT event_id, image_path FROM events WHERE event_id = ?", [eventId]);
        if (!event) {
            res.status(404).render("not-found", { path: req.originalUrl });
            return;
        }

        if (event.image_path) {
            removeUploadedEventImage(event.image_path);
        }

        await dbRun("UPDATE events SET image_path = NULL, updated_at = datetime('now') WHERE event_id = ?", [eventId]);
        addFlash(req, "success", "Image removed.");
        res.redirect(`/organiser/events/${eventId}/edit`);
    } catch (err) {
        next(err);
    }
});

// Purpose: Validate organiser edits and update the event fields and modified timestamp.
// Inputs: req.params.id, req.body (title/description/date/tickets/prices), req (organiser session), res, next
// Outputs: Updates event then redirects to /organiser, or re-renders with errors
router.post('/events/:id/edit', async function (req, res, next) {
    try {
        const eventId = Number.parseInt(req.params.id, 10);
        if (!Number.isFinite(eventId)) {
            res.status(404).render('not-found', { path: req.originalUrl });
            return;
        }

        const title = cleanSingleLine(req.body.title, LIMITS.eventTitle);
        const description = cleanMultiLine(req.body.description, LIMITS.eventDescription);
        const eventDate = cleanSingleLine(req.body.event_date, 20);
        const fullLabelRaw = cleanSingleLine(req.body.full_ticket_label, LIMITS.ticketLabel);
        const concessionLabelRaw = cleanSingleLine(req.body.concession_ticket_label, LIMITS.ticketLabel);
        const vipLabelRaw = cleanSingleLine(req.body.vip_ticket_label, LIMITS.ticketLabel);
        const fullLabel = isNonEmpty(fullLabelRaw) ? fullLabelRaw : 'Standard';
        const concessionLabel = isNonEmpty(concessionLabelRaw) ? concessionLabelRaw : 'Student';
        const vipLabel = isNonEmpty(vipLabelRaw) ? vipLabelRaw : 'VIP';


        const fullCount = toNonNegativeInt(req.body.full_ticket_count, false);
        const fullPrice = toMoney(req.body.full_ticket_price);
        const concessionCount = toNonNegativeInt(req.body.concession_ticket_count, false);
        const concessionPrice = toMoney(req.body.concession_ticket_price);
        const vipCount = toNonNegativeInt(req.body.vip_ticket_count, false);
        const vipPrice = toMoney(req.body.vip_ticket_price);

        const errors = [];
        if (!isNonEmpty(title)) {
            errors.push('Please enter an event title.');
        }
        if (!isNonEmpty(description)) {
            errors.push('Please enter an event description.');
        }
        if (!isISODate(eventDate)) {
            errors.push('Please enter a valid event date.');
        }
        if (fullCount === null) {
            errors.push('Standard ticket count must be a whole number (0 or more).');
        }
        if (fullPrice === null) {
            errors.push('Standard ticket price must be a number (0 or more).');
        }
        if (concessionCount === null) {
            errors.push('Student ticket count must be a whole number (0 or more).');
        }
        if (concessionPrice === null) {
            errors.push('Student ticket price must be a number (0 or more).');
        }
        if (vipCount === null) {
            errors.push('VIP ticket count must be a whole number (0 or more).');
        }
        if (vipPrice === null) {
            errors.push('VIP ticket price must be a number (0 or more).');
        }

        const existing = await dbGet('SELECT * FROM events WHERE event_id = ?', [eventId]);
        if (!existing) {
            res.status(404).render('not-found', { path: req.originalUrl });
            return;
        }

        if (errors.length > 0) {
            const formEvent = {
                event_id: eventId,
                state: existing.state,
                created_at: existing.created_at,
                published_at: existing.published_at,
                updated_at: existing.updated_at,
                title: title,
                description: description,
                event_date: eventDate,
                full_ticket_label: fullLabel,
                concession_ticket_label: concessionLabel,
                vip_ticket_label: vipLabel,
                full_ticket_count: fullCount === null ? cleanSingleLine(req.body.full_ticket_count, 50) : fullCount,
                full_ticket_price: fullPrice === null ? cleanSingleLine(req.body.full_ticket_price, 50) : fullPrice,
                concession_ticket_count: concessionCount === null ? cleanSingleLine(req.body.concession_ticket_count, 50) : concessionCount,
                concession_ticket_price: concessionPrice === null ? cleanSingleLine(req.body.concession_ticket_price, 50) : concessionPrice,
                vip_ticket_count: vipCount === null ? cleanSingleLine(req.body.vip_ticket_count, 50) : vipCount,
                vip_ticket_price: vipPrice === null ? cleanSingleLine(req.body.vip_ticket_price, 50) : vipPrice
            };

            res.render('organiser-edit-event', { event: formEvent, errors: errors });
            return;
        }

        await dbRun(
            'UPDATE events SET title = ?, description = ?, event_date = ?, ' +
            'full_ticket_label = ?, concession_ticket_label = ?, vip_ticket_label = ?, ' +
            'full_ticket_count = ?, full_ticket_price = ?, ' +
            'concession_ticket_count = ?, concession_ticket_price = ?, ' +
            'vip_ticket_count = ?, vip_ticket_price = ?, ' +
            "updated_at = datetime('now') WHERE event_id = ?",
            [
                title,
                description,
                eventDate,
                fullLabel,
                concessionLabel,
                vipLabel,
                fullCount,
                fullPrice,
                concessionCount,
                concessionPrice,
                vipCount,
                vipPrice,
                eventId
            ]
        );

        res.redirect(`/organiser/events/${eventId}/edit`);
    } catch (err) {
        next(err);
    }
});

// Purpose: Publish a draft event (draft → published) and set its published timestamp.
// Inputs: req.params.id, req (organiser session), res, next
// Outputs: Updates event state then redirects to /organiser
router.post('/events/:id/publish', async function (req, res, next) {
    try {
        const eventId = Number.parseInt(req.params.id, 10);
        if (!Number.isFinite(eventId)) {
            res.redirect('/organiser');
            return;
        }

        await dbRun(
            "UPDATE events SET state = 'published', published_at = datetime('now'), updated_at = datetime('now') WHERE event_id = ? AND state = 'draft'",
            [eventId]
        );

        res.redirect('/organiser');
    } catch (err) {
        next(err);
    }
});

// Purpose: Delete an event and its related bookings from the database.
// Inputs: req.params.id, req (organiser session), res, next
// Outputs: Deletes event then redirects to /organiser
router.post('/events/:id/delete', async function (req, res, next) {
    try {
        const eventId = Number.parseInt(req.params.id, 10);
        if (!Number.isFinite(eventId)) {
            res.redirect('/organiser');
            return;
        }

        await dbRun('DELETE FROM events WHERE event_id = ?', [eventId]);
        res.redirect('/organiser');
    } catch (err) {
        next(err);
    }
});

module.exports = router;
