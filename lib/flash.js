// Tiny "flash message" helper so we can show one off messages after redirects.

// Queue a one off message in the session so it can be shown after a redirect.
function addFlash(req, type, message) {
    if (!req.session) {
        return;
    }

    if (!req.session.flash) {
        req.session.flash = [];
    }

    req.session.flash.push({ type: type, message: message });
}

// Expose queued flash messages to templates and clear them after reading.
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
