const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const sqlite3 = require('sqlite3');
const speakeasy = require('speakeasy');
const validation = require('../lib/validation');

// Each run uses a fresh copy, so the development database and uploads stay untouched.
test('event and account workflows', { timeout: 120000 }, async (t) => {
    const root = path.resolve(__dirname, '..');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'event-manager-test-'));
    const appRoot = path.join(temp, 'app');
    fs.cpSync(root, appRoot, {
        recursive: true,
        filter: (source) => !path.relative(root, source).split(path.sep).some((part) =>
            ['.git', 'node_modules', 'uploads', 'test'].includes(part)) &&
            !/\.db(?:-|$)/.test(source)
    });
    const env = { ...process.env, PORT: '0', SESSION_SECRET: 'temporary-test-secret',
        NODE_PATH: path.join(root, 'node_modules') + path.delimiter + (process.env.NODE_PATH || '') };
    const built = spawnSync(process.execPath, ['scripts/build-db.js'], { cwd: appRoot, env, encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr);
    const child = spawn(process.execPath, ['index.js'], { cwd: appRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const db = new sqlite3.Database(path.join(appRoot, 'database.db'));
    t.after(async () => {
        await new Promise((resolve) => db.close(resolve));
        const stopped = once(child, 'exit');
        child.kill();
        await stopped;
        assert.ok(temp.startsWith(path.join(os.tmpdir(), 'event-manager-test-')));
        fs.rmSync(temp, { recursive: true, force: true });
    });
    for (let i = 0; i < 600 && !/listening on port (\d+)/.test(output); i++) {
        if (child.exitCode !== null) throw new Error(output);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const match = output.match(/listening on port (\d+)/);
    assert.ok(match, output);
    const base = `http://127.0.0.1:${match[1]}`;
    const getRow = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params,
        (err, row) => err ? reject(err) : resolve(row)));
    function client() {
        let cookie = '';
        return async (url, body) => {
            const multipart = body instanceof FormData;
            const response = await fetch(base + url, {
                method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
                headers: { ...(cookie ? { cookie } : {}), ...(body && !multipart ?
                    { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
                body: body === undefined ? undefined : multipart ? body : new URLSearchParams(body)
            });
            const setCookie = response.headers.get('set-cookie');
            if (setCookie) cookie = setCookie.split(';')[0];
            return { status: response.status, location: response.headers.get('location'), text: await response.text() };
        };
    }
    const anon = client(), organiser = client(), attendee = client(), twofa = client();
    async function register(request, role, email, enable = 'no') {
        const result = await request(`/auth/${role}/register`, {
            display_name: 'Test User', email, password: 'temporary-password',
            confirm_password: 'temporary-password', enable_2fa: enable
        });
        assert.equal(result.status, 302);
    }
    await t.test('input validation rejects invalid dates, trailing money text and unsafe counts', () => {
        assert.equal(validation.isISODate('2026-02-30'), false);
        assert.equal(validation.isISODate('2028-02-29'), true);
        for (const value of ['10oops', 'Infinity', '1.123', '-1']) assert.equal(validation.toMoney(value), null);
        assert.equal(validation.toMoney('10.50'), 10.5);
        assert.equal(validation.toNonNegativeInt('9007199254740992'), null);
    });
    await t.test('login and role boundaries', async () => {
        assert.equal((await anon('/organiser')).location, '/auth/organiser/login');
        await register(organiser, 'organiser', 'organiser@example.invalid');
        const bad = await organiser('/auth/organiser/login', { email: 'organiser@example.invalid', password: 'wrong' });
        assert.match(bad.text, /Email or password is incorrect/);
        assert.equal((await organiser('/auth/organiser/login', { email: 'organiser@example.invalid', password: 'temporary-password' })).location, '/organiser');
        await register(attendee, 'attendee', 'attendee@example.invalid');
        assert.equal((await attendee('/auth/attendee/login', { email: 'attendee@example.invalid', password: 'temporary-password' })).location, '/attendee');
        assert.equal((await attendee('/organiser')).status, 403);
    });
    let eventId;
    const details = { title: 'Test Event', description: 'Temporary event for workflow checks.', event_date: '2030-01-01',
        full_ticket_count: '3', full_ticket_price: '10', concession_ticket_count: '2', concession_ticket_price: '5',
        vip_ticket_count: '1', vip_ticket_price: '20' };
    await t.test('draft creation, editing and publishing', async () => {
        const created = await organiser('/organiser/events/new', {});
        eventId = Number(created.location.match(/events\/(\d+)/)[1]);
        assert.equal((await attendee(`/attendee/events/${eventId}`)).status, 404);
        const invalid = await organiser(`/organiser/events/${eventId}/edit`, { ...details, event_date: '2026-02-30' });
        assert.match(invalid.text, /valid event date/);
        assert.equal((await organiser(`/organiser/events/${eventId}/edit`, details)).status, 302);
        assert.equal((await organiser(`/organiser/events/${eventId}/publish`, {})).status, 302);
        assert.match((await attendee(`/attendee/events/${eventId}`)).text, /Test Event/);
    });
    await t.test('image uploads and invalid file types', async () => {
        const invalid = new FormData();
        invalid.append('event_image', new Blob(['not an image'], { type: 'text/plain' }), 'file.txt');
        assert.equal((await organiser(`/organiser/events/${eventId}/image`, invalid)).status, 302);
        assert.equal((await getRow('SELECT image_path FROM events WHERE event_id = ?', [eventId])).image_path, null);
        const form = new FormData();
        form.append('event_image', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlN8AAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'pixel.png');
        assert.equal((await organiser(`/organiser/events/${eventId}/image`, form)).status, 302);
        const row = await getRow('SELECT image_path FROM events WHERE event_id = ?', [eventId]);
        assert.ok(fs.existsSync(path.join(appRoot, 'public', row.image_path)));
        assert.equal((await organiser(`/organiser/events/${eventId}/image/delete`, {})).status, 302);
        assert.equal((await getRow('SELECT image_path FROM events WHERE event_id = ?', [eventId])).image_path, null);
    });
    const booking = { attendee_name: 'Test Attendee', full_qty: '1', concession_qty: '0', vip_qty: '0' };
    await t.test('booking validation and all ticket categories', async () => {
        assert.match((await attendee(`/attendee/events/${eventId}/book`, { ...booking, full_qty: '-1' })).text, /whole number/);
        assert.match((await attendee(`/attendee/events/${eventId}/book`, { ...booking, full_qty: '0' })).text, /at least one ticket/);
        assert.match((await attendee(`/attendee/events/${eventId}/book`, { ...booking, concession_qty: '1' })).text, /13-digit student ID/);
        const saved = await attendee(`/attendee/events/${eventId}/book`, { ...booking, concession_qty: '1', vip_qty: '1', student_id: '0000000000000' });
        assert.match(decodeURIComponent(saved.location), /Booking confirmed/);
    });
    await t.test('simultaneous bookings cannot oversell the last tickets', async () => {
        const responses = await Promise.all(Array.from({ length: 8 }, () => attendee(`/attendee/events/${eventId}/book`, booking)));
        assert.equal(responses.filter((r) => r.status === 302 && decodeURIComponent(r.location).includes('Booking confirmed')).length, 2);
        assert.ok(responses.every((r) => r.status === 302));
        assert.equal((await getRow('SELECT SUM(full_qty) AS n FROM bookings WHERE event_id = ?', [eventId])).n, 3);
    });
    await t.test('organiser cannot reduce capacity below existing bookings', async () => {
        await organiser(`/organiser/events/${eventId}/edit`, { ...details, full_ticket_count: '1' });
        assert.equal((await getRow('SELECT full_ticket_count AS n FROM events WHERE event_id = ?', [eventId])).n, 3);
        for (const page of ['/organiser', '/organiser/bookings', '/organiser/dashboard', '/organiser/settings']) {
            assert.equal((await organiser(page)).status, 200, page);
        }
    });
    let secret;
    await t.test('two-factor setup and sign-in require both password and code', async () => {
        await register(twofa, 'attendee', 'twofa@example.invalid', 'yes');
        assert.equal((await twofa('/auth/attendee/login', { email: 'twofa@example.invalid', password: 'temporary-password' })).location, '/auth/attendee/2fa-setup');
        assert.equal((await twofa('/auth/attendee/2fa-setup')).status, 200);
        secret = (await getRow('SELECT two_factor_secret FROM users WHERE email = ?', ['twofa@example.invalid'])).two_factor_secret;
        const token = () => speakeasy.totp({ secret, encoding: 'base32' });
        assert.equal((await twofa('/auth/attendee/2fa-setup', { code: token() })).location, '/attendee');
        await twofa('/auth/logout', {});
        assert.equal((await twofa('/auth/attendee/login', { email: 'twofa@example.invalid', password: 'temporary-password' })).location, '/auth/attendee/2fa');
        assert.equal((await twofa('/attendee')).location, '/auth/attendee/login');
        assert.equal((await twofa('/auth/attendee/2fa', { code: token() })).location, '/attendee');
    });
    await t.test('recovery never exposes a secret and requires the existing authenticator', async () => {
        for (const email of ['attendee@example.invalid', 'twofa@example.invalid', 'missing@example.invalid']) {
            const denied = await anon('/auth/attendee/reset-request', { email });
            assert.equal(denied.status, 400);
            assert.ok(!denied.text.includes(secret));
        }
        assert.equal((await anon('/auth/attendee/2fa-reset-setup')).status, 404);
        const reset = await anon('/auth/attendee/reset-request', { email: 'twofa@example.invalid', code: speakeasy.totp({ secret, encoding: 'base32' }) });
        assert.match(reset.location, /^\/auth\/reset\/[a-f0-9]+$/);
        assert.equal((await anon(reset.location)).status, 200);
        const resetResponses = await Promise.all(Array.from({ length: 2 }, () =>
            anon(reset.location, { password: 'replacement-password', confirm_password: 'replacement-password' })));
        assert.deepEqual(resetResponses.map((response) => response.status).sort(), [302, 404]);
        assert.equal((await anon(reset.location)).status, 404);
        assert.equal((await getRow('SELECT two_factor_secret FROM users WHERE email = ?', ['twofa@example.invalid'])).two_factor_secret, secret);
    });
    await t.test('deleting an event removes its bookings', async () => {
        await organiser(`/organiser/events/${eventId}/delete`, {});
        assert.equal((await getRow('SELECT COUNT(*) AS n FROM bookings WHERE event_id = ?', [eventId])).n, 0);
    });
    await t.test('forwarded IP headers cannot bypass the local authentication rate limit', async () => {
        let limited = false;
        for (let i = 0; i < 41; i++) {
            const response = await fetch(base + '/auth/attendee/login', {
                headers: { 'X-Forwarded-For': `192.0.2.${i + 1}` }
            });
            await response.text();
            if (response.status === 429) limited = true;
        }
        assert.ok(limited);
    });
});

