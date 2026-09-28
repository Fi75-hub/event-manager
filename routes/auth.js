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

// Basic email format check used during login/registration/reset validation.
function isLikelyEmail(value) {
    // This is intentionally simple. We just want to reject obviously wrong inputs.
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// Return the correct home path for a given role.
function roleRedirect(role) {
    return role === 'organiser' ? '/organiser' : '/attendee';
}

// Convert a role key into a show-friendly label for templates.
function viewRoleName(role) {
    return role === 'organiser' ? 'Organiser' : 'Attendee';
}

// Sanitise an OTP input so it contains digits only.
function cleanOtp(value) {
    const raw = cleanSingleLine(value, 20);
    const compact = raw.replace(/\s+/g, '');

    if (!/^\d{6}$/.test(compact)) {
        return null;
    }
    return compact;
}

// Create a stable label used as the OTP account name in the authenticator app.
function userLabelForOtp(role, email) {
    // The label shows up in authenticator apps.
    const roleName = viewRoleName(role);
    return `CM2040 Event Manager (${roleName}) - ${email}`;
}

// Generate a QR code image (data URL) from an OTPAuth URL.
async function makeQrDataUrl(otpAuthUrl) {
    // A data URL means we do not need to save any QR files on disk.
    return QRCode.toDataURL(otpAuthUrl, { margin: 1, width: 220 });
}


// Verify a 6-digit authenticator code against a Base32 secret.
function verifyTotp(secretBase32, token) {
    return speakeasy.totp.verify({
        secret: secretBase32,
        encoding: 'base32',
        token: token,
        window: 1
    });
}

// Create and store a time-limited password reset token for a user.
async function createResetTokenForUser(userId) {
    const token = crypto.randomBytes(24).toString('hex');
    await dbRun(
        'INSERT INTO password_resets (user_id, token, expires_at, created_at) VALUES (?, ?, datetime(\'now\', \'+30 minutes\'), datetime(\'now\'))',
        [userId, token]
    );
    return token;
}


// Load the fields needed for 2FA setup/verification for a specific user.
async function loadTwoFactorUser(userId, role) {
    return dbGet(
        'SELECT user_id, role, display_name, email, two_factor_opt_in, two_factor_secret, is_2fa_enabled FROM users WHERE user_id = ? AND role = ?',
        [userId, role]
    );
}

// Ensure the user has a 2FA secret available (create one if missing).
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

// Build the OTPAuth URL and QR data for displaying on the 2FA setup screen.
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

// Persist the 2FA secret and mark 2FA as enabled for the user.
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

// Render the registration form for the selected role (organiser or attendee).
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

// Validate registration details and create a new user account for the selected role.
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

// Show the QR code page to set up 2FA after a user opts in.
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

// Verify the 6-digit authenticator code and enable 2FA for the logged-in user.
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


        const loggedIn = await dbGet('SELECT user_id, role, display_name, email FROM users WHERE user_id = ?', [user.user_id]);
        req.session.regenerate(function (err) {
            if (err) { next(err); return; }
            setLoggedInUser(req, loggedIn);
            addFlash(req, 'info', 'Two-factor authentication enabled. You are now signed in.');
            res.redirect(roleRedirect(role));
        });
    } catch (err) {
        next(err);
    }
});


// Render the login form for the selected role.
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

// Authenticate a user by email/password and route them through 2FA if enabled.
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
        req.session.regenerate(function (err) {
            if (err) { next(err); return; }
            setLoggedInUser(req, user);
            addFlash(req, 'info', `Welcome back, ${user.display_name}.`);
            res.redirect(roleRedirect(role));
        });
    } catch (err) {
        next(err);
    }
});

// Render the 2FA code entry page for a user who has passed password login.
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

// Verify the 6-digit code and complete login for a 2FA-enabled user.
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

        req.session.regenerate(function (err) {
            if (err) { next(err); return; }
            setLoggedInUser(req, user);
            addFlash(req, 'info', `Welcome back, ${user.display_name}.`);
            res.redirect(roleRedirect(role));
        });
    } catch (err) {
        next(err);
    }
});

// Log the current user out and clear their session.
router.post('/logout', function (req, res) {
    // POST logout keeps it consistent with the rest of our forms.
    if (!req.session) {
        res.redirect('/');
        return;
    }

    clearLoggedInUser(req);
    req.session.pending2fa_login = null;
    req.session.pending2fa_setup = null;


    req.session.destroy(function () {
        res.redirect('/');
    });
});

// Render the 'forgot password' page for the selected role.
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

// Recovery requires the authenticator configured during a previous sign-in.
router.post('/:role/reset-request', async function (req, res, next) {
    try {
        const role = normaliseRole(req.params.role);
        if (!role) {
            res.status(404).render('not-found', { path: req.originalUrl });
            return;
        }
        const email = cleanSingleLine(req.body.email, LIMITS.email).toLowerCase();
        const code = cleanOtp(req.body.code);
        const user = await dbGet(
            'SELECT user_id, two_factor_secret, is_2fa_enabled FROM users WHERE role = ? AND email = ?',
            [role, email]
        );
        if (!user || !user.is_2fa_enabled || !user.two_factor_secret || !code || !verifyTotp(user.two_factor_secret, code)) {
            res.status(400).render('auth/reset-request', {
                role: role,
                roleLabel: viewRoleName(role),
                values: { email: email },
                info: null,
                errors: ['Recovery requires this account’s existing authenticator code. Check your details and try again.']
            });
            return;
        }
        const token = await createResetTokenForUser(user.user_id);
        res.redirect(`/auth/reset/${token}`);
    } catch (err) {
        next(err);
    }
});

// Validate a reset token and render the password reset form.
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

// Validate the token and new password, then consume the token before updating the password.
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
        const claimed = await dbRun(
            "UPDATE password_resets SET used_at = datetime('now') " +
            "WHERE reset_id = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')",
            [row.reset_id]
        );
        if (!claimed.changes) {
            res.status(404).render('not-found', { path: req.originalUrl });
            return;
        }
        await dbRun('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE user_id = ?', [passwordHash, row.user_id]);

        addFlash(req, 'info', 'Password updated. Please log in with your new password.');
        res.redirect(`/auth/${row.role}/login`);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
