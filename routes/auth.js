// Sign-up, login, logout, password reset and two-factor authentication.

const express = require('express');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const router = express.Router();

const { addFlash } = require('../lib/flash');
const {
    normaliseRole,
    hashPassword,
    verifyPassword,
    setLoggedInUser,
    clearLoggedInUser
} = require('../lib/auth');
const { cleanSingleLine, isNonEmpty } = require('../lib/validation');

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

// Purpose: Basic email format check used during login/registration/reset validation.
// Inputs: value (string)
// Outputs: Boolean indicating whether the email looks valid
function isLikelyEmail(value) {
    // This is intentionally simple. We just want to reject obviously wrong inputs.
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// Purpose: Return the correct home path for a given role.
// Inputs: role ('organiser'|'attendee')
// Outputs: String URL path (e.g., /organiser or /attendee)
function roleRedirect(role) {
    return role === 'organiser' ? '/organiser' : '/attendee';
}

// Purpose: Convert a role key into a show-friendly label for templates.
// Inputs: role ('organiser'|'attendee')
// Outputs: String label used in views
function viewRoleName(role) {
    return role === 'organiser' ? 'Organiser' : 'Attendee';
}

// Purpose: Sanitise an OTP input so it contains digits only.
// Inputs: value (any)
// Outputs: String of digits (typically 6 characters)
function cleanOtp(value) {
    const raw = cleanSingleLine(value, 20);
    const compact = raw.replace(/\s+/g, '');

    if (!/^\d{6}$/.test(compact)) {
        return null;
    }
    return compact;
}

// Purpose: Create a stable label used as the OTP account name in the authenticator app.
// Inputs: role, email
// Outputs: String label like 'Role: email'
function userLabelForOtp(role, email) {
    // The label shows up in authenticator apps.
    const roleName = viewRoleName(role);
    return `CM2040 Event Manager (${roleName}) - ${email}`;
}

// Purpose: Generate a QR code image (data URL) from an OTPAuth URL.
// Inputs: otpAuthUrl (string)
// Outputs: Promise that resolves to a PNG data URL string
async function makeQrDataUrl(otpAuthUrl) {
    // A data URL means we do not need to save any QR files on disk.
    return QRCode.toDataURL(otpAuthUrl, { margin: 1, width: 220 });
}


// Purpose: Verify a 6-digit authenticator code against a Base32 secret.
// Inputs: secretBase32 (string), token (string)
// Outputs: Boolean indicating whether the code is valid
function verifyTotp(secretBase32, token) {
    return speakeasy.totp.verify({
        secret: secretBase32,
        encoding: 'base32',
        token: token,
        window: 1
    });
}

// Purpose: Create and store a time-limited password reset token for a user.
// Inputs: userId (number)
// Outputs: Promise that resolves to the created token string
async function createResetTokenForUser(userId) {
    const token = crypto.randomBytes(24).toString('hex');
    await dbRun(
        'INSERT INTO password_resets (user_id, token, expires_at, created_at) VALUES (?, ?, datetime(\'now\', \'+30 minutes\'), datetime(\'now\'))',
        [userId, token]
    );
    return token;
}


// Purpose: Load the fields needed for 2FA setup/verification for a specific user.
// Inputs: userId (number), role (string)
// Outputs: Promise that resolves to a user row or null
async function loadTwoFactorUser(userId, role) {
    return dbGet(
        'SELECT user_id, role, display_name, email, two_factor_opt_in, two_factor_secret, is_2fa_enabled FROM users WHERE user_id = ? AND role = ?',
        [userId, role]
    );
}

// Purpose: Ensure the user has a 2FA secret available (create one if missing).
// Inputs: user (row), role (string)
// Outputs: Promise that resolves to the Base32 secret
async function ensureTwoFactorSecret(user, role) {
    if (user.two_factor_secret) {
        return user.two_factor_secret;
    }

    const fresh = speakeasy.generateSecret({
        length: 20,
        name: userLabelForOtp(role, user.email),
        issuer: 'CM2040 Event Manager'
    });

    await dbRun(
        'UPDATE users SET two_factor_secret = ?, is_2fa_enabled = 0, updated_at = datetime(\'now\') WHERE user_id = ?',
        [fresh.base32, user.user_id]
    );

    user.two_factor_secret = fresh.base32;
    return user.two_factor_secret;
}

// Purpose: Build the OTPAuth URL and QR data for displaying on the 2FA setup screen.
// Inputs: user (row), role (string)
// Outputs: Promise that resolves to { otpAuthUrl, qrDataUrl, secretHint }
async function buildQrForUser(user, role) {
    const secret = await ensureTwoFactorSecret(user, role);

    const otpAuthUrl = speakeasy.otpauthURL({
        secret: secret,
        label: userLabelForOtp(role, user.email),
        issuer: 'CM2040 Event Manager',
        encoding: 'base32'
    });

    const qrImage = await makeQrDataUrl(otpAuthUrl);
    return { qrDataUrl: qrImage, secret: secret };
}

// Purpose: Persist the 2FA secret and mark 2FA as enabled for the user.
// Inputs: userId (number), role (string), secretBase32 (string)
// Outputs: Promise that resolves when the user record has been updated
async function enableTwoFactorForUser(userId, role, secretBase32) {
    await dbRun(
        'UPDATE users SET two_factor_opt_in = 1, two_factor_secret = ?, is_2fa_enabled = 1, updated_at = datetime(\'now\') WHERE user_id = ? AND role = ?',
        [secretBase32, userId, role]
    );
}

const LIMITS = {
    name: 80,
    email: 120,
    password: 200
};

// Purpose: Render the registration form for the selected role (organiser or attendee).
// Inputs: req.params.role, res
// Outputs: HTML response (renders register form) or 404 for invalid roles
router.get('/:role/register', function (req, res) {
    const role = normaliseRole(req.params.role);
    if (!role) {
        res.status(404).render('not-found', { path: req.originalUrl });
        return;
    }

    res.render('auth/register', {
        role: role,
        roleLabel: viewRoleName(role),
        values: { display_name: '', email: '', enable_2fa: 'no' },
        errors: []
    });
});

// Purpose: Validate registration details and create a new user account for the selected role.
// Inputs: req.params.role, req.body (name, email, password, optional 2FA toggle), res, next
// Outputs: Creates user then redirects to login, or re-renders with validation errors
router.post('/:role/register', async function (req, res, next) {
    try {
        const role = normaliseRole(req.params.role);
        if (!role) {
            res.status(404).render('not-found', { path: req.originalUrl });
            return;
        }

        const displayName = cleanSingleLine(req.body.display_name, LIMITS.name);
        const email = cleanSingleLine(req.body.email, LIMITS.email).toLowerCase();
        const password = cleanSingleLine(req.body.password, LIMITS.password);
        const confirmPassword = cleanSingleLine(req.body.confirm_password, LIMITS.password);

        const errors = [];
        if (!isNonEmpty(displayName)) {
            errors.push('Please enter your name.');
        }
        if (!isNonEmpty(email) || !isLikelyEmail(email)) {
            errors.push('Please enter a valid email address.');
        }
        if (!isNonEmpty(password) || password.length < 8) {
            errors.push('Please choose a password of at least 8 characters.');
        }
        if (password !== confirmPassword) {
            errors.push('Passwords do not match.');
        }

        const existing = await dbGet('SELECT user_id FROM users WHERE role = ? AND email = ?', [role, email]);
        if (existing) {
            errors.push('An account with that email already exists for this role.');
        }

        if (errors.length > 0) {
            res.render('auth/register', {
                role: role,
                roleLabel: viewRoleName(role),
                values: { display_name: displayName, email: email, enable_2fa: (req.body.enable_2fa || 'no') },
                errors: errors
            });
            return;
        }

        const passwordHash = await hashPassword(password);

        // The user can choose whether they want to enable 2FA for this account.
        const enable2faChoice = cleanSingleLine(req.body.enable_2fa || 'no', 10).toLowerCase();
        const wants2fa = enable2faChoice === 'yes';

        const created = await dbRun(
            'INSERT INTO users (role, display_name, email, password_hash, two_factor_opt_in, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))',
            [role, displayName, email, passwordHash, wants2fa ? 1 : 0]
        );

        if (wants2fa) {
            addFlash(req, 'info', 'Account created. Sign in to finish setting up two-factor authentication.');
            res.redirect(`/auth/${role}/login`);
            return;
        }

        addFlash(req, 'info', 'Account created. You can sign in now.');
        res.redirect(`/auth/${role}/login`);
    } catch (err) {
        next(err);
    }
});

// Purpose: Show the QR code page to set up 2FA after a user opts in.
// Inputs: req.params.role, session user, res, next
// Outputs: HTML response (renders 2FA setup) or redirects if not eligible
router.get('/:role/2fa-setup', async function (req, res, next) {
    try {
        const role = normaliseRole(req.params.role);
        const pending = req.session ? req.session.pending2fa_setup : null;

        if (!role || !pending || pending.role !== role) {
            res.redirect(`/auth/${role || 'organiser'}/login`);
            return;
        }

        const user = await loadTwoFactorUser(pending.user_id, role);

        if (!user) {
            req.session.pending2fa_setup = null;
    req.session.pending2fa_reset = null;
            res.redirect(`/auth/${role}/register`);
            return;
        }

        const qrInfo = await buildQrForUser(user, role);

        res.render('auth/twofa-setup', {
            role: role,
            roleLabel: viewRoleName(role),
            qrDataUrl: qrInfo.qrDataUrl,
            secret: user.two_factor_secret,
            errors: []
        });
    } catch (err) {
        next(err);
    }
});

// Purpose: Verify the 6-digit authenticator code and enable 2FA for the logged-in user.
// Inputs: req.params.role, req.body (otp), session user, res, next
// Outputs: Enables 2FA then redirects to role home, or re-renders with errors
router.post('/:role/2fa-setup', async function (req, res, next) {
    try {
        const role = normaliseRole(req.params.role);
        const pending = req.session ? req.session.pending2fa_setup : null;

        if (!role || !pending || pending.role !== role) {
            res.redirect(`/auth/${role || 'organiser'}/login`);
            return;
        }

        const code = cleanOtp(req.body.code);
        const errors = [];

        if (!code) {
            errors.push('Please enter the 6-digit code from your authenticator app.');
        }

        const user = await loadTwoFactorUser(pending.user_id, role);
        if (!user) {
            req.session.pending2fa_setup = null;
    req.session.pending2fa_reset = null;
            res.redirect(`/auth/${role}/register`);
            return;
        }

        const qrInfo = await buildQrForUser(user, role);
        const ok = code ? verifyTotp(qrInfo.secret, code) : false;

        if (!ok) {
            errors.push('That code did not match. Please try again.');
        }

        if (errors.length > 0) {
            res.render('auth/twofa-setup', {
                role: role,
                roleLabel: viewRoleName(role),
                qrDataUrl: qrInfo.qrDataUrl,
                secret: user.two_factor_secret,
                errors: errors
            });
            return;
        }

        await enableTwoFactorForUser(user.user_id, role, qrInfo.secret);
        req.session.pending2fa_setup = null;
    req.session.pending2fa_reset = null;

        const loggedIn = await dbGet('SELECT user_id, role, display_name, email FROM users WHERE user_id = ?', [user.user_id]);
        req.session.regenerate(function () {
            setLoggedInUser(req, loggedIn);
            addFlash(req, 'info', 'Two-factor authentication enabled. You are now signed in.');
            res.redirect(roleRedirect(role));
        });
    } catch (err) {
        next(err);
    }
});


// Purpose: Show the QR code page to re-configure 2FA during a password reset flow.
// Inputs: req.params.role, session pending reset, res, next
// Outputs: HTML response (renders 2FA reset setup) or redirects if session is missing
router.get('/:role/2fa-reset-setup', async function (req, res, next) {
    try {
        const role = normaliseRole(req.params.role);
        const pending = req.session ? req.session.pending2fa_reset : null;

        if (!role || !pending || pending.role !== role) {
            res.redirect(`/auth/${role || 'organiser'}/reset-request`);
            return;
        }

        const user = await loadTwoFactorUser(pending.user_id, role);
        if (!user) {
            req.session.pending2fa_reset = null;
            res.redirect(`/auth/${role}/reset-request`);
            return;
        }

        const qrInfo = await buildQrForUser(user, role);

        res.render('auth/twofa-reset-setup', {
            role: role,
            roleLabel: viewRoleName(role),
            qrDataUrl: qrInfo.qrDataUrl,
            secret: user.two_factor_secret,
            errors: []
        });
    } catch (err) {
        next(err);
    }
});

// Purpose: Verify the 6-digit authenticator code and save the new 2FA secret for the user.
// Inputs: req.params.role, req.body (otp), session pending reset, res, next
// Outputs: Updates 2FA secret then continues the reset flow, or re-renders with errors
router.post('/:role/2fa-reset-setup', async function (req, res, next) {
    try {
        const role = normaliseRole(req.params.role);
        const pending = req.session ? req.session.pending2fa_reset : null;

        if (!role || !pending || pending.role !== role) {
            res.redirect(`/auth/${role || 'organiser'}/reset-request`);
            return;
        }

        const code = cleanOtp(req.body.code);
        const errors = [];

        if (!code) {
            errors.push('Please enter the 6-digit code from your authenticator app.');
        }

        const user = await loadTwoFactorUser(pending.user_id, role);
        if (!user) {
            req.session.pending2fa_reset = null;
            res.redirect(`/auth/${role}/reset-request`);
            return;
        }

        const qrInfo = await buildQrForUser(user, role);
        const ok = code ? verifyTotp(qrInfo.secret, code) : false;

        if (!ok) {
            errors.push('That code did not match. Please try again.');
        }

        if (errors.length > 0) {
            res.render('auth/twofa-reset-setup', {
                role: role,
                roleLabel: viewRoleName(role),
                qrDataUrl: qrInfo.qrDataUrl,
                secret: user.two_factor_secret,
                errors: errors
            });
            return;
        }

        await enableTwoFactorForUser(user.user_id, role, qrInfo.secret);
        req.session.pending2fa_reset = null;

        const token = await createResetTokenForUser(user.user_id);
        res.redirect(`/auth/reset/${token}`);
    } catch (err) {
        next(err);
    }
});


// Purpose: Render the login form for the selected role.
// Inputs: req.params.role, res
// Outputs: HTML response (renders login form) or 404 for invalid roles
router.get('/:role/login', function (req, res) {
    const role = normaliseRole(req.params.role);
    if (!role) {
        res.status(404).render('not-found', { path: req.originalUrl });
        return;
    }

    res.render('auth/login', {
        role: role,
        roleLabel: viewRoleName(role),
        values: { email: '' },
        errors: []
    });
});

// Purpose: Authenticate a user by email/password and route them through 2FA if enabled.
// Inputs: req.params.role, req.body (email, password), session, res, next
// Outputs: Starts a session then redirects to home or 2FA pages, or re-renders with errors
router.post('/:role/login', async function (req, res, next) {
    try {
        const role = normaliseRole(req.params.role);
        if (!role) {
            res.status(404).render('not-found', { path: req.originalUrl });
            return;
        }

        const email = cleanSingleLine(req.body.email, LIMITS.email).toLowerCase();
        const password = cleanSingleLine(req.body.password, LIMITS.password);

        const errors = [];
        if (!isNonEmpty(email) || !isLikelyEmail(email)) {
            errors.push('Please enter a valid email address.');
        }
        if (!isNonEmpty(password)) {
            errors.push('Please enter your password.');
        }

        if (errors.length > 0) {
            res.render('auth/login', {
                role: role,
                roleLabel: viewRoleName(role),
                values: { email: email },
                errors: errors
            });
            return;
        }

        const user = await dbGet('SELECT * FROM users WHERE role = ? AND email = ?', [role, email]);
        if (!user) {
            res.render('auth/login', {
                role: role,
                roleLabel: viewRoleName(role),
                values: { email: email },
                errors: ['Email or password is incorrect.']
            });
            return;
        }

        const ok = await verifyPassword(password, user.password_hash);
        if (!ok) {
            res.render('auth/login', {
                role: role,
                roleLabel: viewRoleName(role),
                values: { email: email },
                errors: ['Email or password is incorrect.']
            });
            return;
        }

        // If the account has 2FA enabled, ask for a code before we sign them in.
        if (user.is_2fa_enabled) {
            req.session.pending2fa_login = { user_id: user.user_id, role: role };
            res.redirect(`/auth/${role}/2fa`);
            return;
        }

        // If the user opted in to 2FA, complete setup on first login.
        if (user.two_factor_opt_in) {
            req.session.pending2fa_setup = { user_id: user.user_id, role: role };
            addFlash(req, 'info', 'Please set up two-factor authentication to continue.');
            res.redirect(`/auth/${role}/2fa-setup`);
            return;
        }

        // No 2FA for this account: create the session and continue.
        req.session.regenerate(function () {
            setLoggedInUser(req, user);
            addFlash(req, 'info', `Welcome back, ${user.display_name}.`);
            res.redirect(roleRedirect(role));
        });
    } catch (err) {
        next(err);
    }
});

// Purpose: Render the 2FA code entry page for a user who has passed password login.
// Inputs: req.params.role, session pending2fa, res
// Outputs: HTML response (renders 2FA prompt) or redirects if not pending
router.get('/:role/2fa', function (req, res) {
    const role = normaliseRole(req.params.role);
    const pending = req.session ? req.session.pending2fa_login : null;

    if (!role || !pending || pending.role !== role) {
        res.redirect(`/auth/${role || 'organiser'}/login`);
        return;
    }

    res.render('auth/twofa', {
        role: role,
        roleLabel: viewRoleName(role),
        errors: []
    });
});

// Purpose: Verify the 6-digit code and complete login for a 2FA-enabled user.
// Inputs: req.params.role, req.body (otp), session pending2fa, res, next
// Outputs: Completes login then redirects to home, or re-renders with errors
router.post('/:role/2fa', async function (req, res, next) {
    try {
        const role = normaliseRole(req.params.role);
        const pending = req.session ? req.session.pending2fa_login : null;

        if (!role || !pending || pending.role !== role) {
            res.redirect(`/auth/${role || 'organiser'}/login`);
            return;
        }

        const code = cleanOtp(req.body.code);
        const errors = [];

        if (!code) {
            errors.push('Please enter the 6-digit code from your authenticator app.');
        }

        const user = await dbGet(
            'SELECT user_id, role, display_name, email, two_factor_secret, is_2fa_enabled FROM users WHERE user_id = ? AND role = ?',
            [pending.user_id, role]
        );

        if (!user) {
            req.session.pending2fa_login = null;
            res.redirect(`/auth/${role}/login`);
            return;
        }

        if (!user.is_2fa_enabled || !user.two_factor_secret) {
            req.session.pending2fa_login = null;
            addFlash(req, 'info', 'Two-factor authentication is not enabled for this account.');
            res.redirect(`/auth/${role}/login`);
            return;
        }

        let ok = false;
        if (code) {
            ok = speakeasy.totp.verify({
                secret: user.two_factor_secret,
                encoding: 'base32',
                token: code,
                window: 1
            });
        }

        if (!ok) {
            errors.push('That code did not match. Please try again.');
        }

        if (errors.length > 0) {
            res.render('auth/twofa', {
                role: role,
                roleLabel: viewRoleName(role),
                errors: errors
            });
            return;
        }

        req.session.pending2fa_login = null;

        req.session.regenerate(function () {
            setLoggedInUser(req, user);
            addFlash(req, 'info', `Welcome back, ${user.display_name}.`);
            res.redirect(roleRedirect(role));
        });
    } catch (err) {
        next(err);
    }
});

// Purpose: Log the current user out and clear their session.
// Inputs: req (session), res
// Outputs: Clears session and redirects to the main home page
router.post('/logout', function (req, res) {
    // POST logout keeps it consistent with the rest of our forms.
    if (!req.session) {
        res.redirect('/');
        return;
    }

    clearLoggedInUser(req);
    req.session.pending2fa_login = null;
    req.session.pending2fa_setup = null;
    req.session.pending2fa_reset = null;

    req.session.destroy(function () {
        res.redirect('/');
    });
});

// Purpose: Render the 'forgot password' page for the selected role.
// Inputs: req.params.role, res
// Outputs: HTML response (renders reset-request) or 404 for invalid roles
router.get('/:role/reset-request', function (req, res) {
    const role = normaliseRole(req.params.role);
    if (!role) {
        res.status(404).render('not-found', { path: req.originalUrl });
        return;
    }

    res.render('auth/reset-request', {
        role: role,
        roleLabel: viewRoleName(role),
        values: { email: '' },
        info: null,
        errors: []
    });
});

// Purpose: Validate email and create a password reset token (response is generic for unknown emails).
// Inputs: req.params.role, req.body (email), session, res, next
// Outputs: Creates reset token and redirects to reset form, or re-renders with errors
router.post('/:role/reset-request', async function (req, res, next) {
    try {
        const role = normaliseRole(req.params.role);
        if (!role) {
            res.status(404).render('not-found', { path: req.originalUrl });
            return;
        }

        const email = cleanSingleLine(req.body.email, LIMITS.email).toLowerCase();

        const errors = [];
        if (!isNonEmpty(email) || !isLikelyEmail(email)) {
            errors.push('Please enter a valid email address.');
        }

        if (errors.length > 0) {
            res.render('auth/reset-request', {
                role: role,
                roleLabel: viewRoleName(role),
                values: { email: email },
                info: null,
                errors: errors
            });
            return;
        }

        const user = await dbGet(
            'SELECT user_id, role, email FROM users WHERE role = ? AND email = ?',
            [role, email]
        );

        // response generic for unknown emails.
        if (!user) {
            res.render('auth/reset-request', {
                role: role,
                roleLabel: viewRoleName(role),
                values: { email: email },
                info: true,
                errors: []
            });
            return;
        }

        req.session.pending2fa_reset = { user_id: user.user_id, role: role };
        res.redirect(`/auth/${role}/2fa-reset-setup`);
    } catch (err) {
        next(err);
    }
});


// Purpose: Validate a reset token and render the password reset form.
// Inputs: req.params.token, res, next
// Outputs: HTML response (renders reset form) or 404 if token is invalid/expired
router.get('/reset/:token', async function (req, res, next) {
    try {
        const token = cleanSingleLine(req.params.token, 200);
        const row = await dbGet(
            'SELECT pr.reset_id, pr.user_id, pr.expires_at, pr.used_at, u.role FROM password_resets pr JOIN users u ON u.user_id = pr.user_id WHERE pr.token = ?',
            [token]
        );

        if (!row || row.used_at) {
            res.status(404).render('not-found', { path: req.originalUrl });
            return;
        }

        // Simple expiry check using SQLite's datetime comparison.
        const expiryCheck = await dbGet('SELECT 1 AS ok WHERE datetime(?) > datetime(\'now\')', [row.expires_at]);
        if (!expiryCheck) {
            res.status(404).render('not-found', { path: req.originalUrl });
            return;
        }

        res.render('auth/reset', {
            token: token,
            roleLabel: viewRoleName(row.role),
            errors: []
        });
    } catch (err) {
        next(err);
    }
});

// Purpose: Validate the token and new password, then update the user's password (and handle 2FA reset if needed).
// Inputs: req.params.token, req.body (new password fields), session, res, next
// Outputs: Updates password then redirects to login, or re-renders with errors
router.post('/reset/:token', async function (req, res, next) {
    try {
        const token = cleanSingleLine(req.params.token, 200);
        const password = cleanSingleLine(req.body.password, LIMITS.password);
        const confirmPassword = cleanSingleLine(req.body.confirm_password, LIMITS.password);

        const row = await dbGet(
            'SELECT pr.reset_id, pr.user_id, pr.expires_at, pr.used_at, u.role FROM password_resets pr JOIN users u ON u.user_id = pr.user_id WHERE pr.token = ?',
            [token]
        );

        if (!row || row.used_at) {
            res.status(404).render('not-found', { path: req.originalUrl });
            return;
        }

        const expiryCheck = await dbGet('SELECT 1 AS ok WHERE datetime(?) > datetime(\'now\')', [row.expires_at]);
        if (!expiryCheck) {
            res.status(404).render('not-found', { path: req.originalUrl });
            return;
        }

        const errors = [];
        if (!isNonEmpty(password) || password.length < 8) {
            errors.push('Please choose a password of at least 8 characters.');
        }
        if (password !== confirmPassword) {
            errors.push('Passwords do not match.');
        }

        if (errors.length > 0) {
            res.render('auth/reset', {
                token: token,
                roleLabel: viewRoleName(row.role),
                errors: errors
            });
            return;
        }

        const passwordHash = await hashPassword(password);
        await dbRun('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE user_id = ?', [passwordHash, row.user_id]);
        await dbRun('UPDATE password_resets SET used_at = datetime(\'now\') WHERE reset_id = ?', [row.reset_id]);

        addFlash(req, 'info', 'Password updated. Please log in with your new password.');
        res.redirect(`/auth/${row.role}/login`);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
