'use strict';

/* Payments, deposits and refunds; password reset; email notifications. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-pay-'));
process.env.INKWELL_DB_PATH = path.join(tmp, 'test.db');
process.env.INKWELL_UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.NODE_ENV = 'test';
delete process.env.STRIPE_SECRET_KEY;

const { createApp } = require('../server/index');
const { seed, DEMO_PASSWORD } = require('../server/seed');
const { db } = require('../server/db');
const { createStripeProvider, validateCard } = require('../server/payments');

let server;
let base;

function client() {
  let cookie = '';
  async function call(method, url, body) {
    const init = { method, headers: {} };
    if (cookie) init.headers.cookie = cookie;
    if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    const res = await fetch(base + url, init);
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data };
  }
  return {
    get: (u) => call('GET', u), post: (u, b) => call('POST', u, b), put: (u, b) => call('PUT', u, b), del: (u) => call('DELETE', u),
    cookie: () => cookie,
  };
}

async function login(email) {
  const c = client();
  const r = await c.post('/api/auth/login', { email, password: DEMO_PASSWORD });
  assert.equal(r.status, 200, `login ${email}`);
  return { c, user: r.data.user };
}

const GOOD_CARD = { number: '4242 4242 4242 4242', exp_month: 12, exp_year: new Date().getFullYear() + 2, cvc: '123', name: 'Test Client' };
const DECLINED_CARD = { ...GOOD_CARD, number: '4000000000000002' };

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Open the artist every day, all day, so slot timing in tests is predictable. */
async function openAllWeek(artistClient) {
  const availability = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_time: '00:00', end_time: '23:59' }));
  const r = await artistClient.put('/api/artists/me/availability', { availability });
  assert.equal(r.status, 200);
}

async function firstSlotOn(c, artistId, daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const r = await c.get(`/api/artists/${artistId}/slots?date=${isoDate(d)}`);
  const slot = r.data.slots.find((s) => s.available);
  assert.ok(slot, `an available slot ${daysAhead} days ahead`);
  return slot.starts_at;
}

const emailsFor = db.prepare('SELECT subject, status FROM email_log WHERE to_user_id = ? ORDER BY id ASC');

before(async () => {
  seed();
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('payment config and card validation', async () => {
  const r = await client().get('/api/payments/config');
  assert.equal(r.data.provider, 'demo');
  assert.equal(r.data.mode, 'inline');
  assert.ok(r.data.test_cards.length >= 1);
  assert.equal(validateCard(GOOD_CARD), null);
  assert.match(validateCard({ ...GOOD_CARD, number: '1234' }), /card number/);
  assert.match(validateCard({ ...GOOD_CARD, exp_year: 2001 }), /expired/);
  assert.match(validateCard({ ...GOOD_CARD, cvc: '1' }), /security code/);
});

test('deposit is created with the booking, paid with a card, and refunded when the artist declines', async () => {
  const { c: artist, user: sofia } = await login('sofia@inkwell.demo');
  const { c: cli, user: lucia } = await login('lucia@inkwell.demo');
  const { c: stranger } = await login('ben@inkwell.demo');
  await openAllWeek(artist);

  const slot = await firstSlotOn(cli, sofia.id, 5);
  let r = await cli.post('/api/appointments', { artist_id: sofia.id, starts_at: slot, note: 'Watercolor fox' });
  assert.equal(r.status, 201);
  const appt = r.data.appointment;
  assert.equal(appt.deposit_amount, 60, 'deposit snapshot from artist profile');
  assert.equal(appt.payments.length, 1);
  assert.equal(appt.payments[0].kind, 'deposit');
  assert.equal(appt.payments[0].status, 'pending');
  assert.equal(appt.amount_due, 60);
  const paymentId = appt.payments[0].id;

  const artistMail = emailsFor.all(sofia.id).map((e) => e.subject);
  assert.ok(artistMail.some((s) => s.includes('New booking request')), 'artist emailed about the request');
  assert.ok(emailsFor.all(lucia.id).some((e) => e.subject.includes('Deposit due')), 'client emailed about the deposit');

  r = await stranger.post(`/api/payments/${paymentId}/pay`, { card: GOOD_CARD });
  assert.equal(r.status, 403, 'only the payer can pay');
  r = await cli.post(`/api/payments/${paymentId}/pay`, { card: DECLINED_CARD });
  assert.equal(r.status, 402);
  assert.match(r.data.error, /declined/);
  r = await cli.post(`/api/payments/${paymentId}/pay`, { card: { number: 'nope' } });
  assert.equal(r.status, 402);

  r = await cli.post(`/api/payments/${paymentId}/pay`, { card: GOOD_CARD });
  assert.equal(r.status, 200);
  assert.equal(r.data.payment.status, 'paid');
  assert.equal(r.data.payment.card_last4, '4242');
  assert.match(r.data.payment.provider_ref, /^demo_ch_/);
  r = await cli.post(`/api/payments/${paymentId}/pay`, { card: GOOD_CARD });
  assert.equal(r.status, 400, 'cannot pay twice');
  assert.ok(emailsFor.all(sofia.id).some((e) => e.subject.includes('paid a $60 deposit')), 'artist emailed about payment');

  r = await artist.get('/api/payments');
  assert.equal(r.data.summary.collected, 60);
  assert.equal(r.data.summary.outstanding, 0);

  r = await artist.post(`/api/appointments/${appt.id}/decline`);
  assert.equal(r.status, 200);
  assert.equal(r.data.appointment.status, 'declined');
  assert.equal(r.data.appointment.payments[0].status, 'refunded');
  assert.ok(r.data.appointment.payments[0].refunded_at);
  assert.ok(emailsFor.all(lucia.id).some((e) => e.subject.includes('refunded')), 'client emailed about the refund');
  r = await artist.get('/api/payments');
  assert.equal(r.data.summary.collected, 0);
  assert.equal(r.data.summary.refunded, 60);
});

test('client cancellation: refund when early, forfeit when late', async () => {
  const { c: artist, user: sofia } = await login('sofia@inkwell.demo');
  const { c: cli } = await login('lucia@inkwell.demo');
  await openAllWeek(artist);

  // Early cancellation, five days out.
  let slot = await firstSlotOn(cli, sofia.id, 5);
  let r = await cli.post('/api/appointments', { artist_id: sofia.id, starts_at: slot });
  let appt = r.data.appointment;
  await cli.post(`/api/payments/${appt.payments[0].id}/pay`, { card: GOOD_CARD });
  r = await cli.post(`/api/appointments/${appt.id}/cancel`);
  assert.equal(r.data.appointment.payments[0].status, 'refunded');

  // Late cancellation: the earliest slot tomorrow is always inside the 48 hour window.
  slot = await firstSlotOn(cli, sofia.id, 1);
  r = await cli.post('/api/appointments', { artist_id: sofia.id, starts_at: slot });
  appt = r.data.appointment;
  await cli.post(`/api/payments/${appt.payments[0].id}/pay`, { card: GOOD_CARD });
  r = await cli.post(`/api/appointments/${appt.id}/cancel`);
  assert.equal(r.data.appointment.payments[0].status, 'forfeited');
  assert.match(r.data.appointment.payments[0].note, /less than 48 hours/);

  // Unpaid deposit on a cancelled booking is simply cancelled.
  slot = await firstSlotOn(cli, sofia.id, 6);
  r = await cli.post('/api/appointments', { artist_id: sofia.id, starts_at: slot });
  appt = r.data.appointment;
  r = await artist.post(`/api/appointments/${appt.id}/cancel`);
  assert.equal(r.data.appointment.payments[0].status, 'cancelled');
});

test('completing a session with a total creates a balance payment', async () => {
  const { c: artist, user: sofia } = await login('sofia@inkwell.demo');
  const { c: cli } = await login('jordan@inkwell.demo');
  await openAllWeek(artist);

  const slot = await firstSlotOn(cli, sofia.id, 7);
  let r = await cli.post('/api/appointments', { artist_id: sofia.id, starts_at: slot });
  const appt = r.data.appointment;
  await cli.post(`/api/payments/${appt.payments[0].id}/pay`, { card: GOOD_CARD });
  await artist.post(`/api/appointments/${appt.id}/confirm`);

  r = await artist.post(`/api/appointments/${appt.id}/complete`, { price: -5 });
  assert.equal(r.status, 400);
  r = await artist.post(`/api/appointments/${appt.id}/complete`, { price: 360 });
  assert.equal(r.status, 200);
  assert.equal(r.data.appointment.status, 'completed');
  assert.equal(r.data.appointment.price, 360);
  const balance = r.data.appointment.payments.find((p) => p.kind === 'balance');
  assert.ok(balance);
  assert.equal(balance.amount, 300, 'total minus the paid deposit');
  assert.equal(balance.status, 'pending');
  assert.equal(r.data.appointment.amount_due, 300);

  r = await cli.post(`/api/payments/${balance.id}/pay`, { card: GOOD_CARD });
  assert.equal(r.status, 200);
  r = await cli.get('/api/appointments');
  const done = r.data.appointments.find((a) => a.id === appt.id);
  assert.equal(done.amount_paid, 360);
  assert.equal(done.amount_due, 0);

  r = await artist.get('/api/payments');
  assert.ok(r.data.payments.some((p) => p.id === balance.id && p.status === 'paid'));
});

test('artist deposit setting flows through profile and availability endpoints', async () => {
  const { c: artist, user: tomasz } = await login('tomasz@inkwell.demo');
  let r = await artist.put('/api/auth/me', { deposit_amount: 250 });
  assert.equal(r.data.user.profile.deposit_amount, 250);
  r = await client().get(`/api/artists/${tomasz.id}/availability`);
  assert.equal(r.data.deposit_amount, 250);
  assert.equal(r.data.refund_window_hours, 48);
  r = await client().get(`/api/artists/${tomasz.id}`);
  assert.equal(r.data.artist.deposit_amount, 250);
  r = await artist.put('/api/auth/me', { deposit_amount: 0 });
  assert.equal(r.data.user.profile.deposit_amount, 0);
});

test('password reset: request, reset, single use, sessions revoked', async () => {
  const anon = client();
  let r = await anon.post('/api/auth/forgot', { email: 'nobody@example.com' });
  assert.equal(r.status, 200);
  assert.equal(r.data.dev_reset_url, undefined, 'unknown emails do not leak');

  const { c: existing } = await login('amara@inkwell.demo');
  r = await anon.post('/api/auth/forgot', { email: 'amara@inkwell.demo' });
  assert.equal(r.status, 200);
  assert.ok(r.data.dev_reset_url, 'without SMTP the reset link is exposed in dev');
  const token = new URL(r.data.dev_reset_url.replace('/#/', '/')).searchParams.get('token');
  assert.ok(token);
  const amara = db.prepare('SELECT id FROM users WHERE email = ?').get('amara@inkwell.demo');
  assert.ok(emailsFor.all(amara.id).some((e) => e.subject.includes('Reset your')), 'reset email logged');

  r = await anon.post('/api/auth/reset', { token: 'bogus', password: 'newpassword1' });
  assert.equal(r.status, 400);
  r = await anon.post('/api/auth/reset', { token, password: 'short' });
  assert.equal(r.status, 400);

  const resetter = client();
  r = await resetter.post('/api/auth/reset', { token, password: 'newpassword1' });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.email, 'amara@inkwell.demo');
  r = await resetter.get('/api/auth/me');
  assert.equal(r.data.user.email, 'amara@inkwell.demo', 'reset signs the user in');
  r = await existing.get('/api/auth/me');
  assert.equal(r.data.user, null, 'old sessions are revoked');

  r = await anon.post('/api/auth/reset', { token, password: 'anotherpass1' });
  assert.equal(r.status, 400, 'token is single use');
  r = await client().post('/api/auth/login', { email: 'amara@inkwell.demo', password: DEMO_PASSWORD });
  assert.equal(r.status, 401);
  r = await client().post('/api/auth/login', { email: 'amara@inkwell.demo', password: 'newpassword1' });
  assert.equal(r.status, 200);
});

test('change password from settings', async () => {
  const { c } = await login('ben@inkwell.demo');
  const { c: other } = await login('ben@inkwell.demo');
  let r = await c.put('/api/auth/me/password', { current_password: 'wrong', new_password: 'benspassword2' });
  assert.equal(r.status, 400);
  r = await c.put('/api/auth/me/password', { current_password: DEMO_PASSWORD, new_password: 'benspassword2' });
  assert.equal(r.status, 200);
  r = await c.get('/api/auth/me');
  assert.equal(r.data.user.email, 'ben@inkwell.demo', 'current session stays signed in');
  r = await other.get('/api/auth/me');
  assert.equal(r.data.user, null, 'other sessions are signed out');
  r = await client().post('/api/auth/login', { email: 'ben@inkwell.demo', password: 'benspassword2' });
  assert.equal(r.status, 200);
});

test('email notifications: logged when on, skipped when off, account mail always sent', async () => {
  const { c: sender, user: mara } = await login('mara@inkwell.demo');
  const { c: receiver, user: yuki } = await login('yuki@inkwell.demo');

  let r = await sender.post(`/api/messages/${yuki.id}`, { body: 'Guest spot next month?' });
  assert.equal(r.status, 201);
  let mail = emailsFor.all(yuki.id);
  assert.equal(mail.filter((e) => e.subject.includes('New message from Mara')).length, 1);
  r = await sender.post(`/api/messages/${yuki.id}`, { body: 'Second message before you read the first' });
  mail = emailsFor.all(yuki.id);
  assert.equal(mail.filter((e) => e.subject.includes('New message from Mara')).length, 1, 'no repeat email while unread');

  r = await receiver.put('/api/auth/me', { email_notifications: false });
  assert.equal(r.data.user.email_notifications, false);
  await receiver.get(`/api/messages/${mara.id}`); // marks read
  await sender.post(`/api/messages/${yuki.id}`, { body: 'Third message after opt-out' });
  mail = emailsFor.all(yuki.id);
  const last = mail[mail.length - 1];
  assert.equal(last.status, 'skipped');

  r = await receiver.get('/api/auth/me/emails');
  assert.equal(r.status, 200);
  assert.ok(r.data.emails.length >= 2);
  assert.equal(r.data.live, false);

  const fresh = client();
  r = await fresh.post('/api/auth/register', { email: 'optin@example.com', password: 'password123', name: 'Opt In', role: 'client', accept_terms: true });
  const id = r.data.user.id;
  await fresh.put('/api/auth/me', { email_notifications: false });
  await fresh.post('/api/auth/forgot', { email: 'optin@example.com' });
  const optinMail = emailsFor.all(id);
  assert.ok(optinMail.some((e) => e.subject.startsWith('Welcome') && e.status === 'logged'));
  assert.ok(optinMail.some((e) => e.subject.includes('Reset') && e.status === 'logged'), 'account emails ignore the preference');
});

test('stripe provider talks to the REST API with the expected shape', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    const respond = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (url.endsWith('/checkout/sessions') && init.method === 'POST') return respond({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/cs_test_1' });
    if (url.includes('/checkout/sessions/cs_test_1')) return respond({ id: 'cs_test_1', payment_status: 'paid', payment_intent: 'pi_1', client_reference_id: '42' });
    if (url.endsWith('/refunds')) return respond({ id: 're_1' });
    return respond({ error: { message: 'unexpected' } }, 400);
  };
  const stripe = createStripeProvider('sk_test_x', fakeFetch);
  assert.equal(stripe.mode, 'redirect');

  const checkout = await stripe.createCheckout({ amount: 60, description: 'Deposit', successUrl: 'http://x/ok', cancelUrl: 'http://x/no', reference: 42 });
  assert.equal(checkout.url, 'https://checkout.stripe.com/c/cs_test_1');
  const params = new URLSearchParams(calls[0].init.body);
  assert.equal(params.get('line_items[0][price_data][unit_amount]'), '6000', 'dollars converted to cents');
  assert.equal(params.get('client_reference_id'), '42');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk_test_x');

  const verified = await stripe.verifyCheckout('cs_test_1');
  assert.equal(verified.paid, true);
  assert.equal(verified.providerRef, 'pi_1');
  assert.equal(verified.reference, '42');

  const refund = await stripe.refund({ providerRef: 'pi_1', amount: 60 });
  assert.equal(refund.providerRef, 're_1');
  assert.equal(new URLSearchParams(calls[2].init.body).get('amount'), '6000');

  await assert.rejects(stripe.verifyCheckout('cs_missing'), /unexpected/);
});
