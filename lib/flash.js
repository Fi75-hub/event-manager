// Tiny "flash message" helper so we can show one off messages after redirects.

// Purpose: Queue a one off message in the session so it can be shown after a redirect.
// Inputs: req (Express request), type (string), message (string)
// Outputs: No return value (mutates req.session)
function addFlash(req, type, message) {
    if (!req.session) {
        return;
    }

    if (!req.session.flash) {
        req.session.flash = [];
    }

    req.session.flash.push({ type: type, message: message });
}

// Purpose: Expose queued flash messages to templates and clear them after reading.
// Inputs: req, res, next
// Outputs: Calls next() after setting res.locals.flash
function flashMiddleware(req, res, next) {
    const flashes = (req.session && req.session.flash) ? req.session.flash : [];
    if (req.session) {
        req.session.flash = [];
    }

    res.locals.flash = flashes;
    next();
}

module.exports = {
    addFlash: addFlash,
    flashMiddleware: flashMiddleware
};
