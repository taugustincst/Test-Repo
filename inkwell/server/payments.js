'use strict';

/**
 * Payment providers.
 *
 * - demo   (default) processes card details in-app with test card numbers. No keys, nothing leaves
 *          the server. Meant for development and demos.
 * - stripe used when STRIPE_SECRET_KEY is set. Uses Stripe Checkout so card details never touch
 *          this server. The client is redirected to Stripe and returned to /payments/return.
 *
 * Both expose the same shape:
 *   name, mode ('inline' | 'redirect')
 *   charge({ amount, description, card })            -> inline only
 *   createCheckout({ amount, description, successUrl, cancelUrl, reference }) -> redirect only
 *   verifyCheckout(sessionId)                          -> redirect only
 *   refund({ providerRef, amount })
 */

const crypto = require('crypto');

const TEST_CARDS = {
  '4000000000000002': 'Your card was declined.',
  '4000000000009995': 'Your card has insufficient funds.',
  '4000000000000069': 'Your card has expired.',
  '4000000000000127': 'The security code is incorrect.',
};

function luhnValid(number) {
  let sum = 0;
  let double = false;
  for (let i = number.length - 1; i >= 0; i -= 1) {
    let d = Number(number[i]);
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Validate a card object from the demo form. Returns an error string or null. */
function validateCard(card) {
  if (!card || typeof card !== 'object') return 'Enter your card details.';
  const number = String(card.number || '').replace(/[\s-]/g, '');
  if (!/^\d{12,19}$/.test(number) || !luhnValid(number)) return 'That card number does not look right.';
  const month = Number(card.exp_month);
  const year = Number(String(card.exp_year || '').length === 2 ? `20${card.exp_year}` : card.exp_year);
  if (!(month >= 1 && month <= 12) || !Number.isInteger(year)) return 'Enter a valid expiry date.';
  const now = new Date();
  if (year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) return 'That card has expired.';
  if (!/^\d{3,4}$/.test(String(card.cvc || ''))) return 'Enter the 3 or 4 digit security code.';
  if (!String(card.name || '').trim()) return 'Enter the name on the card.';
  return null;
}

const demoProvider = {
  name: 'demo',
  mode: 'inline',
  testCards: [
    { number: '4242 4242 4242 4242', outcome: 'Succeeds' },
    { number: '4000 0000 0000 0002', outcome: 'Declined' },
    { number: '4000 0000 0000 9995', outcome: 'Insufficient funds' },
  ],
  async charge({ amount, card }) {
    const error = validateCard(card);
    if (error) return { ok: false, error };
    const number = String(card.number).replace(/[\s-]/g, '');
    if (TEST_CARDS[number]) return { ok: false, error: TEST_CARDS[number] };
    if (!(amount > 0)) return { ok: false, error: 'Nothing to charge.' };
    return { ok: true, providerRef: `demo_ch_${crypto.randomBytes(8).toString('hex')}`, last4: number.slice(-4) };
  },
  async refund({ providerRef }) {
    if (!providerRef) return { ok: false, error: 'Nothing to refund.' };
    return { ok: true, providerRef: `demo_re_${crypto.randomBytes(8).toString('hex')}` };
  },
};

/** Stripe over its REST API so there is no SDK dependency. `fetchImpl` is injectable for tests. */
function createStripeProvider(secretKey, fetchImpl = globalThis.fetch) {
  const API = 'https://api.stripe.com/v1';

  async function call(path, params, method = 'POST') {
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: method === 'POST' ? new URLSearchParams(params).toString() : undefined,
    });
    const data = await res.json();
    if (!res.ok) {
      const message = (data && data.error && data.error.message) || `Stripe error (${res.status})`;
      throw new Error(message);
    }
    return data;
  }

  return {
    name: 'stripe',
    mode: 'redirect',
    testCards: [],
    async createCheckout({ amount, description, successUrl, cancelUrl, reference }) {
      const session = await call('/checkout/sessions', {
        mode: 'payment',
        'line_items[0][price_data][currency]': process.env.STRIPE_CURRENCY || 'usd',
        'line_items[0][price_data][unit_amount]': String(Math.round(amount * 100)),
        'line_items[0][price_data][product_data][name]': description,
        'line_items[0][quantity]': '1',
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: String(reference),
      });
      return { url: session.url, sessionId: session.id };
    },
    async verifyCheckout(sessionId) {
      const session = await call(`/checkout/sessions/${encodeURIComponent(sessionId)}`, null, 'GET');
      const paid = session.payment_status === 'paid';
      return { paid, providerRef: session.payment_intent, reference: session.client_reference_id, last4: null };
    },
    async refund({ providerRef, amount }) {
      const refund = await call('/refunds', { payment_intent: providerRef, amount: String(Math.round(amount * 100)) });
      return { ok: true, providerRef: refund.id };
    },
  };
}

/**
 * Verify a Stripe webhook signature (Stripe-Signature: t=...,v1=...). Returns the parsed event or
 * throws. `now` is injectable for tests.
 */
function verifyStripeWebhook(rawBody, header, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not configured.');
  const parts = Object.create(null);
  for (const item of String(header || '').split(',')) {
    const [k, v] = item.split('=');
    if (k && v) (parts[k.trim()] = parts[k.trim()] || []).push(v.trim());
  }
  const timestamp = Number(parts.t && parts.t[0]);
  const signatures = parts.v1 || [];
  if (!timestamp || !signatures.length) throw new Error('Malformed Stripe signature header.');
  if (Math.abs(now / 1000 - timestamp) > toleranceSec) throw new Error('Stripe signature timestamp outside tolerance.');
  const payload = `${timestamp}.${Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const ok = signatures.some((sig) => sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
  if (!ok) throw new Error('Stripe signature mismatch.');
  return JSON.parse(payload.slice(String(timestamp).length + 1));
}

/** Build a signature header the way Stripe does. Used by tests and local tooling. */
function signStripePayload(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

const provider = process.env.STRIPE_SECRET_KEY ? createStripeProvider(process.env.STRIPE_SECRET_KEY) : demoProvider;

module.exports = { provider, demoProvider, createStripeProvider, validateCard, luhnValid, verifyStripeWebhook, signStripePayload };
