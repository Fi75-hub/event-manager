// A small in-memory rate limiter.
// This is not meant to replace a real reverse proxy in production.

// Return the current time in milliseconds (used for rate limit windows).
function nowMs() {
    return Date.now();
}

// Pick a default identifier for rate limiting (uses Express-detected IP).
function defaultKey(req) {
    // req.ip uses Express's built-in IP detection.
    return req.ip || 'unknown';
}

// Create an in-memory rate limiting middleware with a fixed window.
function rateLimit(options) {
    const windowMs = (options && options.windowMs) ? options.windowMs : 5 * 60 * 1000;
    const max = (options && typeof options.max === 'number') ? options.max : 300;
    const keyFn = (options && typeof options.key === 'function') ? options.key : defaultKey;
    const message = (options && options.message) ? options.message : 'Too many requests. Please try again in a moment.';
    const view = (options && options.view) ? options.view : null;
    const maxKeys = (options && typeof options.maxKeys === 'number') ? options.maxKeys : 5000;

    const store = new Map();

    // Remove expired rate limit entries to keep the in-memory store bounded.
    function cleanupIfNeeded() {
        // Keep the in-memory map from growing without bound.
        if (store.size <= maxKeys) {
            return;
        }

        const now = nowMs();
        for (const [k, v] of store.entries()) {
            if (v.resetAt <= now) {
                store.delete(k);
            }
        }

        //  remove the oldest keys.
        if (store.size > maxKeys) {
            const entries = Array.from(store.entries()).sort(function (a, b) {
                return a[1].resetAt - b[1].resetAt;
            });

            const extra = store.size - maxKeys;
            for (let i = 0; i < extra; i += 1) {
                store.delete(entries[i][0]);
            }
        }
    }

    // Rate limiting middleware that tracks requests per key within a time window.
    return function (req, res, next) {
        // Allow callers to skip limiting for certain request.
        if (options && typeof options.skip === 'function' && options.skip(req)) {
            next();
            return;
        }

        const key = String(keyFn(req));
        const now = nowMs();

        let bucket = store.get(key);
        if (!bucket || bucket.resetAt <= now) {
            bucket = { count: 0, resetAt: now + windowMs };
            store.set(key, bucket);
        }

        bucket.count += 1;

        // Helpful headers for debugging.
        res.setHeader('X-RateLimit-Limit', String(max));
        res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
        res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

        if (bucket.count > max) {
            cleanupIfNeeded();

            res.status(429);
            if (view) {
                res.render(view, { message: message });
            } else {
                res.send(message);
            }
            return;
        }

        cleanupIfNeeded();
        next();
    };
}

module.exports = { rateLimit };
