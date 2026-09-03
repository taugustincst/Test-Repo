'use strict';

/**
 * Payment ledger: creates deposit and balance payments for appointments and applies the
 * refund policy when a booking changes state.
 *
 * Policy:
 * - Deposits are due when the booking is requested and hold the slot.
 * - Artist declines or cancels: every paid amount is refunded.
 * - Client cancels 48+ hours before the session: deposit refunded. Later than that: deposit forfeited.
 * - Balance payments are always refunded if the session does not go ahead.
 */

const { db } = require('./db');
const { provider } = require('./payments');
const mailer = require('./mailer');

const CANCEL_REFUND_HOURS = Number(process.env.INKWELL_REFUND_WINDOW_HOURS) || 48;

const insertPayment = db.prepare(`
  INSERT INTO payments (appointment_id, payer_id, payee_id, kind, amount, note)
  VALUES (@appointment_id, @payer_id, @payee_id, @kind, @amount, @note)
`);
const paymentsForAppt = db.prepare('SELECT * FROM payments WHERE appointment_id = ? ORDER BY id ASC');
const getPaymentRaw = db.prepare('SELECT * FROM payments WHERE id = ?');
const setPaid = db.prepare(`
  UPDATE payments SET status = 'paid', provider = ?, provider_ref = ?, card_last4 = ?, paid_at = datetime('now') WHERE id = ?
`);
const setStatus = db.prepare('UPDATE payments SET status = ?, note = ?, refunded_at = CASE WHEN ? = \'refunded\' THEN datetime(\'now\') ELSE refunded_at END WHERE id = ?');
const setProviderRef = db.prepare('UPDATE payments SET provider = ?, provider_ref = ? WHERE id = ?');

/** Create a pending payment. Returns null when there is nothing to collect. */
function createPending({ appointment, kind, amount, note = '' }) {
  if (!(amount > 0)) return null;
  const info = insertPayment.run({
    appointment_id: appointment.id,
    payer_id: appointment.client_id,
    payee_id: appointment.artist_id,
    kind,
    amount: Math.round(amount),
    note,
  });
  return getPaymentRaw.get(info.lastInsertRowid);
}

function markPaid(paymentId, { providerName, providerRef, last4 }) {
  setPaid.run(providerName, providerRef || null, last4 || null, paymentId);
  return getPaymentRaw.get(paymentId);
}

async function refund(payment, note) {
  if (payment.status !== 'paid') return payment;
  try {
    const result = await provider.refund({ providerRef: payment.provider_ref, amount: payment.amount });
    if (result.ok && result.providerRef) setProviderRef.run(payment.provider, `${payment.provider_ref}|refund:${result.providerRef}`, payment.id);
    setStatus.run('refunded', note, 'refunded', payment.id);
  } catch (err) {
    // Keep the ledger honest: leave it paid and note the failure so it can be retried by hand.
    setStatus.run('paid', `Refund failed: ${err.message}`, 'paid', payment.id);
    console.error(`[ledger] refund failed for payment ${payment.id}: ${err.message}`);
  }
  return getPaymentRaw.get(payment.id);
}

function forfeit(payment, note) {
  if (payment.status !== 'paid') return payment;
  setStatus.run('forfeited', note, 'forfeited', payment.id);
  return getPaymentRaw.get(payment.id);
}

function cancelPending(payment, note) {
  if (payment.status !== 'pending') return payment;
  setStatus.run('cancelled', note, 'cancelled', payment.id);
  return getPaymentRaw.get(payment.id);
}

function hoursUntil(startsAt) {
  return (new Date(startsAt).getTime() - Date.now()) / 3600000;
}

/**
 * Apply the refund policy after an appointment transition.
 * @param appt joined appointment row (needs id, starts_at, artist_name, client_name)
 * @param action confirm | decline | cancel | complete
 * @param actorRole 'artist' | 'client'
 */
async function settle(appt, action, actorRole) {
  const payments = paymentsForAppt.all(appt.id);
  const outcomes = [];
  for (const p of payments) {
    let updated = p;
    if (action === 'decline' || (action === 'cancel' && actorRole === 'artist')) {
      updated = p.status === 'paid' ? await refund(p, `Refunded: ${actorRole === 'artist' ? 'artist' : 'client'} ${action === 'decline' ? 'declined' : 'cancelled'} the booking`) : cancelPending(p, 'Booking did not go ahead');
    } else if (action === 'cancel' && actorRole === 'client') {
      if (p.status === 'paid') {
        const early = hoursUntil(appt.starts_at) >= CANCEL_REFUND_HOURS;
        updated = p.kind === 'deposit' && !early
          ? forfeit(p, `Deposit kept: cancelled less than ${CANCEL_REFUND_HOURS} hours before the session`)
          : await refund(p, 'Refunded: cancelled in time');
      } else {
        updated = cancelPending(p, 'Booking cancelled');
      }
    }
    if (updated.status === 'refunded' && p.status === 'paid') mailer.notify(mailer.templates.paymentRefunded(updated, appt));
    outcomes.push(updated);
  }
  return outcomes;
}

/** Attach `payments`, `amount_due`, and `amount_paid` to a list of appointment rows. */
function attachPayments(appointments) {
  for (const a of appointments) {
    a.payments = paymentsForAppt.all(a.id);
    a.amount_paid = a.payments.filter((p) => p.status === 'paid' || p.status === 'forfeited').reduce((n, p) => n + p.amount, 0);
    a.amount_due = a.payments.filter((p) => p.status === 'pending').reduce((n, p) => n + p.amount, 0);
  }
  return appointments;
}

module.exports = {
  createPending, markPaid, refund, forfeit, cancelPending, settle, attachPayments, paymentsForAppt, getPaymentRaw, CANCEL_REFUND_HOURS,
};
