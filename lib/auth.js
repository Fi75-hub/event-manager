// Authentication and role-based access helpers.

const bcrypt = require('bcryptjs');

// Purpose: Normalise a role string and reject anything unexpected.
// Inputs: role (string)
// Outputs: 'organiser' | 'attendee' 
function normaliseRole(role) {
    if (role === 'organiser' || role === 'attendee') {
        return role;
    }
    return null;
}

// Purpose: Hash a plain text password using bcrypt.
// Inputs: plainTextPassword (string)
// Outputs: Promise that resolves to a password hash string
async function hashPassword(plainTextPassword) {
    // A slightly higher cost makes brute-forcing harder without being painful locally.
    const rounds = 12;
    return bcrypt.hash(plainTextPassword, rounds);
}

// Purpose: Compare a plain password against a stored bcrypt hash.
// Inputs: plainTextPassword (string), hash (string)
// Outputs: Promise that resolves to true/false
async function verifyPassword(plainTextPassword, passwordHash) {
    return bcrypt.compare(plainTextPassword, passwordHash);
}

// Purpose: Store the logged-in user information in the session.
// Inputs: req (Express request), user (row)
// Outputs: No return value (mutates req.session)
function setLoggedInUser(req, userRow) {
    req.session.user = {
        user_id: userRow.user_id,
        role: userRow.role,
        display_name: userRow.display_name,
        email: userRow.email
    };
}

// Purpose: Clear any stored login information from the session.
// Inputs: req (Express request)
// Outputs: No return value (mutates req.session)
function clearLoggedInUser(req) {
    if (!req.session) {
        return;
    }
    delete req.session.user;
}

// Purpose: Create middleware that enforces login and allowed role(s) for protected pages.
// Inputs: allowedRoles (string|string[]), redirectRole (string, optional)
// Outputs: Middleware function (req, res, next)
function requireRole(roleOrRoles, loginRole) {
    // This helper protects routes based on the user's role stored in the session.
    // It supports a single role (string) or a list of roles (array of strings).
    const roles = Array.isArray(roleOrRoles) ? roleOrRoles : [roleOrRoles];

    // Normalise and drop anything unexpected so we don't accidentally allow a typo.
    const allowedRoles = roles
        .map(function (r) { return normaliseRole(r); })
        .filter(function (r) { return !!r; });

    const fallbackRole = normaliseRole(loginRole) || allowedRoles[0] || 'attendee';

    // Purpose: Express middleware that blocks unauthenticated/unauthorised access to protected routes.
    // Inputs: req (session + user), res, next
    // Outputs: Either calls next() or redirects/returns 403
    return function (req, res, next) {
        const user = req.session && req.session.user ? req.session.user : null;

        if (!user) {
            // login page.
            res.redirect(`/auth/${fallbackRole}/login`);
            return;
        }

        if (allowedRoles.length > 0 && allowedRoles.indexOf(user.role) === -1) {
            res.status(403).render('error', {
                error: new Error('You do not have permission to view that page.')
            });
            return;
        }

        next();
    };
}


module.exports = {
    normaliseRole: normaliseRole,
    hashPassword: hashPassword,
    verifyPassword: verifyPassword,
    setLoggedInUser: setLoggedInUser,
    clearLoggedInUser: clearLoggedInUser,
    requireRole: requireRole
};
