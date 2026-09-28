// Attendee pages for browsing published events and booking tickets.

const express = require('express');
const router = express.Router();

const { requireRole } = require('../lib/auth');

const {
    cleanSingleLine,
    isNonEmpty,
    toNonNegativeInt,
    cleanDigits,
    isStudentId
} = require('../lib/validation');

// Attendee pages are protected for the auth extension.
router.use(requireRole(['attendee', 'organiser'], 'attendee'));

// Run a SELECT that returns a single row using sqlite3 and async/await.
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

// Run a SELECT that returns multiple rows using sqlite3 and async/await.
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

// Run an INSERT/UPDATE/DELETE using sqlite3 and async/await.
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

// Input limits keep the booking form sensible and avoid huge submissions.
const LIMITS = {
    attendeeName: 80
};

// Calculate remaining ticket counts for an event by subtracting booked quantities from capacity.
async function getRemainingTickets(eventId) {
    const totals = await dbGet(
        'SELECT ' +
        'COALESCE(SUM(full_qty), 0) AS full_booked, ' +
        'COALESCE(SUM(concession_qty), 0) AS concession_booked, ' +
        'COALESCE(SUM(vip_qty), 0) AS vip_booked ' +
        'FROM bookings WHERE event_id = ?',
        [eventId]
    );

    const event = await dbGet(
        'SELECT full_ticket_count, concession_ticket_count, vip_ticket_count FROM events WHERE event_id = ?',
        [eventId]
    );

    return {
        fullRemaining: Math.max(0, (event.full_ticket_count || 0) - (totals.full_booked || 0)),
        concessionRemaining: Math.max(0, (event.concession_ticket_count || 0) - (totals.concession_booked || 0)),
        vipRemaining: Math.max(0, (event.vip_ticket_count || 0) - (totals.vip_booked || 0))
    };
}

// Load a published event by id, or render a 404 page if it does not exist.
async function loadPublishedEventOr404(req, res, next) {
    const eventId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(eventId)) {
        res.status(404).render('not-found', { path: req.originalUrl });
        return null;
    }

    try {
        const event = await dbGet("SELECT * FROM events WHERE event_id = ? AND state = 'published'", [eventId]);
        if (!event) {
            res.status(404).render('not-found', { path: req.originalUrl });
            return null;
        }

        return event;
    } catch (err) {
        next(err);
        return null;
    }
}

// Render the attendee home page showing all published events ordered by date.
router.get('/', async function (req, res, next) {
    try {
        const settings = await dbGet('SELECT site_name, site_description FROM site_settings WHERE settings_id = 1');
        const events = await dbAll(
            "SELECT e.event_id, e.title, e.event_date, " +
            "e.full_ticket_label, e.concession_ticket_label, e.vip_ticket_label, " +
            "(e.full_ticket_count - COALESCE(SUM(b.full_qty), 0)) AS full_remaining, " +
            "(e.concession_ticket_count - COALESCE(SUM(b.concession_qty), 0)) AS concession_remaining, " +
            "(e.vip_ticket_count - COALESCE(SUM(b.vip_qty), 0)) AS vip_remaining " +
            "FROM events e " +
            "LEFT JOIN bookings b ON b.event_id = e.event_id " +
            "WHERE e.state = 'published' " +
            "GROUP BY e.event_id " +
            "ORDER BY e.event_date ASC, e.created_at DESC"
        );

        res.render('attendee-home', { settings: settings, events: events });
    } catch (err) {
        next(err);
    }
});

// Render a single published event page and show ticket pricing and remaining capacity.
router.get('/events/:id', async function (req, res, next) {
    const event = await loadPublishedEventOr404(req, res, next);
    if (!event) {
        return;
    }

    try {
        const remaining = await getRemainingTickets(event.event_id);
        const message = cleanSingleLine(req.query.message, 200);
        const error = cleanSingleLine(req.query.error, 200);

        res.render('attendee-event', {
            event: event,
            remaining: remaining,
            message: message,
            error: error,
            form: { attendee_name: '', full_qty: '0', concession_qty: '0', vip_qty: '0', student_id: '' },
            studentUnlocked: false
        });
    } catch (err) {
        next(err);
    }
});

// Create a booking for an event and enforce ticket capacity before saving.
router.post('/events/:id/book', async function (req, res, next) {
    const event = await loadPublishedEventOr404(req, res, next);
    if (!event) {
        return;
    }

    const attendeeName = cleanSingleLine(req.body.attendee_name, LIMITS.attendeeName);
    const fullQty = toNonNegativeInt(req.body.full_qty, true);
    const concessionQty = toNonNegativeInt(req.body.concession_qty, true);
    const vipQty = toNonNegativeInt(req.body.vip_qty, true);
    const studentId = cleanDigits(req.body.student_id, 40);

    const validationErrors = [];
    if (!isNonEmpty(attendeeName)) {
        validationErrors.push('Please enter your name.');
    }
    if (fullQty === null) {
        validationErrors.push('Standard quantity must be a whole number (0 or more).');
    }
    if (concessionQty === null) {
        validationErrors.push('Student quantity must be a whole number (0 or more).');
    }
    if (vipQty === null) {
        validationErrors.push('VIP quantity must be a whole number (0 or more).');
    }

    if (concessionQty !== null && concessionQty > 0 && !isStudentId(studentId)) {
        validationErrors.push('Please enter a valid 13-digit student ID to book student tickets.');
    }
    if (fullQty !== null && concessionQty !== null && vipQty !== null && fullQty === 0 && concessionQty === 0 && vipQty === 0) {
        validationErrors.push('Please select at least one ticket.');
    }

    if (validationErrors.length > 0) {
        try {
            const remaining = await getRemainingTickets(event.event_id);
            res.render('attendee-event', {
                event: event,
                remaining: remaining,
                message: '',
                error: validationErrors.join(' '),
                form: {
                    attendee_name: attendeeName,
                    full_qty: cleanSingleLine(req.body.full_qty || '0', 20),
                    concession_qty: cleanSingleLine(req.body.concession_qty || '0', 20),
                    vip_qty: cleanSingleLine(req.body.vip_qty || '0', 20),
                    student_id: studentId
                },
                studentUnlocked: isStudentId(studentId)
            });
        } catch (err) {
            next(err);
        }
        return;
    }

    try {
        // One statement keeps the capacity check and insert atomic, including concurrent requests.
        const saved = await dbRun(
            "INSERT INTO bookings (event_id, attendee_name, full_qty, concession_qty, vip_qty, student_id, created_at) " +
            "SELECT event_id, ?, ?, ?, ?, ?, datetime('now') FROM events e " +
            "WHERE e.event_id = ? AND e.state = 'published' " +
            'AND ? <= e.full_ticket_count - (SELECT COALESCE(SUM(full_qty), 0) FROM bookings WHERE event_id = e.event_id) ' +
            'AND ? <= e.concession_ticket_count - (SELECT COALESCE(SUM(concession_qty), 0) FROM bookings WHERE event_id = e.event_id) ' +
            'AND ? <= e.vip_ticket_count - (SELECT COALESCE(SUM(vip_qty), 0) FROM bookings WHERE event_id = e.event_id)',
            [attendeeName, fullQty, concessionQty, vipQty, concessionQty > 0 ? studentId : null,
                event.event_id, fullQty, concessionQty, vipQty]
        );
        if (saved.changes === 0) {
            res.redirect(`/attendee/events/${event.event_id}?error=${encodeURIComponent('Not enough tickets available, or this event is no longer available.')}`);
            return;
        }
        res.redirect(`/attendee/events/${event.event_id}?message=${encodeURIComponent('Booking confirmed.')}`);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
