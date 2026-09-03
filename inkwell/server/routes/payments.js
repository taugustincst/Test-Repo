'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');
const { provider } = require('../payments');
const ledger = require('../ledger');
const mailer = require('../mailer');

const router = express.Router();

const PAYMENT_SELECT = `
  SELECT p.*, ap.starts_at, ap.ends_at, ap.status AS appointment_status,
         a.name AS artist_name, c.name AS client_name
  FROM payments p
  JOIN appointments ap ON ap.id = p.appointment_id
  JOIN users a ON a.id = ap.artist_id
  JOIN users c ON c.id = ap.client_id
`;
const getPayment = db.prepare(`${PAYMENT_SELECT} WHERE p.id = ?`);
const listForUser = db.prepare(`${PAYMENT_SELECT} WHERE p.payer_id = ? OR p.payee_id = ? ORDER BY p.created_at DESC, p.id DESC`);
const summaryForArtist = db.prepare(`
  SELECT
    COALESCE(SUM(CASE WHEN status IN ('paid', 'forfeited') THEN amount END), 0) AS collected,
    COALESCE(SUM(CASE WHEN status = 'pending' THEN amount END), 0) AS outstanding,
    COALESCE(SUM(CASE WHEN status = 'refunded' THEN amount END), 0) AS refunded
  FROM payments WHERE payee_id = ?
`);

router.get('/config', (_req, res) => {
  res.json({
    provider: provider.name,
    mode: provider.mode,
    test_cards: provider.testCards || [],
    refund_window_hours: ledger.CANCEL_REFUND_HOURS,
  });
});

router.get('/', requireAuth, (req, res) => {
  const payments = listForUser.all(req.user.id, req.user.id);
  const summary = req.user.role === 'artist' ? summaryForArtist.get(req.user.id) : null;
  res.json({ payments, summary });
});

function ownPayable(req, res) {
  const payment = getPayment.get(req.params.id);
  if (!payment) { res.status(404).json({ error: 'Payment not found.' }); return null; }
  if (payment.payer_id !== req.user.id) { res.status(403).json({ error: 'This is not your payment.' }); return null; }
  if (payment.status !== 'pending') { res.status(400).json({ error: `This payment is already ${payment.status}.` }); return null; }
  if (!['pending', 'confirmed', 'completed'].includes(payment.appointment_status)) {
    res.status(400).json({ error: 'This booking is no longer active.' }); return null;
  }
  return payment;
}

function afterPaid(paymentId) {
  const payment = getPayment.get(paymentId);
  mailer.notify(mailer.templates.paymentReceived(payment, payment));
  return payment;
}

/** Inline (demo) card payment. */
router.post('/:id/pay', requireAuth, async (req, res) => {
  const payment = ownPayable(req, res);
  if (!payment) return;
  if (provider.mode !== 'inline') return res.status(400).json({ error: 'Use the checkout flow for this payment provider.' });
  const result = await provider.charge({ amount: payment.amount, description: `${payment.kind} for booking #${payment.appointment_id}`, card: (req.body || {}).card });
  if (!result.ok) return res.status(402).json({ error: result.error });
  ledger.markPaid(payment.id, { providerName: provider.name, providerRef: result.providerRef, last4: result.last4 });
  res.json({ payment: afterPaid(payment.id) });
});

/** Redirect (Stripe Checkout) flow: create a session and send the client to it. */
router.post('/:id/checkout', requireAuth, async (req, res) => {
  const payment = ownPayable(req, res);
  if (!payment) return;
  if (provider.mode !== 'redirect') return res.status(400).json({ error: 'This provider takes card details directly.' });
  try {
    const base = mailer.APP_URL;
    const { url } = await provider.createCheckout({
      amount: payment.amount,
      description: `${payment.kind === 'deposit' ? 'Deposit' : 'Balance'} for tattoo session with ${payment.artist_name}`,
      successUrl: `${base}/#/payments/return?payment=${payment.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/#/appointments`,
      reference: payment.id,
    });
    res.json({ url });
  } catch (err) {
    res.status(502).json({ error: `Could not start checkout: ${err.message}` });
  }
});

/** Redirect flow return leg: verify the session with the provider and mark the payment paid. */
router.post('/:id/confirm', requireAuth, async (req, res) => {
  const payment = getPayment.get(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found.' });
  if (payment.payer_id !== req.user.id) return res.status(403).json({ error: 'This is not your payment.' });
  if (payment.status === 'paid') return res.json({ payment });
  if (provider.mode !== 'redirect') return res.status(400).json({ error: 'Nothing to confirm for this provider.' });
  const sessionId = String((req.body || {}).session_id || '');
  if (!sessionId) return res.status(400).json({ error: 'Missing checkout session.' });
  try {
    const result = await provider.verifyCheckout(sessionId);
    if (String(result.reference) !== String(payment.id)) return res.status(400).json({ error: 'Checkout session does not match this payment.' });
    if (!result.paid) return res.status(402).json({ error: 'Payment has not completed yet.' });
    ledger.markPaid(payment.id, { providerName: provider.name, providerRef: result.providerRef, last4: result.last4 });
    res.json({ payment: afterPaid(payment.id) });
  } catch (err) {
    res.status(502).json({ error: `Could not verify payment: ${err.message}` });
  }
});

module.exports = router;
