'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const mailer = require('../mailer');
const consent = require('../consent');

const router = express.Router();

const getAppointment = db.prepare(`
  SELECT ap.*, a.name AS artist_name, c.name AS client_name, p.studio_name
  FROM appointments ap JOIN users a ON a.id = ap.artist_id JOIN users c ON c.id = ap.client_id
  LEFT JOIN artist_profiles p ON p.user_id = ap.artist_id WHERE ap.id = ?
`);

function party(req, res) {
  const appt = getAppointment.get(req.params.id);
  if (!appt) { res.status(404).json({ error: 'Appointment not found.' }); return null; }
  if (appt.artist_id !== req.user.id && appt.client_id !== req.user.id && !req.user.is_admin) { res.status(403).json({ error: 'This is not your appointment.' }); return null; }
  return appt;
}

/* Artist settings for their form. */
router.get('/consent/settings', requireRole('artist'), (req, res) => {
  res.json({ settings: consent.settingsFor(req.user.id), defaults: { terms: consent.DEFAULT_TERMS }, preview: consent.definition(req.user.id) });
});

router.put('/consent/settings', requireRole('artist'), (req, res) => {
  const result = consent.updateSettings(req.user.id, req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ settings: result, preview: consent.definition(req.user.id) });
});

/* The form for one appointment: definition plus the signed submission if there is one. */
router.get('/appointments/:id/consent', requireAuth, (req, res) => {
  const appt = party(req, res);
  if (!appt) return;
  const row = consent.getForm.get(appt.id);
  res.json({
    appointment: { id: appt.id, starts_at: appt.starts_at, ends_at: appt.ends_at, status: appt.status, artist_id: appt.artist_id, artist_name: appt.artist_name, client_id: appt.client_id, client_name: appt.client_name, studio_name: appt.studio_name },
    definition: consent.definition(appt.artist_id),
    form: consent.shape(row),
    can_sign: !row && appt.client_id === req.user.id && ['pending', 'confirmed'].includes(appt.status),
    required: consent.settingsFor(appt.artist_id).require_consent,
  });
});

router.post('/appointments/:id/consent', requireRole('client'), async (req, res, next) => {
  try {
    const appt = party(req, res);
    if (!appt) return;
    if (appt.client_id !== req.user.id) return res.status(403).json({ error: 'Only the client can sign this form.' });
    if (!['pending', 'confirmed'].includes(appt.status)) return res.status(400).json({ error: 'This session is no longer open for a consent form.' });
    if (consent.getForm.get(appt.id)) return res.status(409).json({ error: 'This form is already signed.' });
    const v = await consent.validate(req.body, consent.settingsFor(appt.artist_id));
    if (v.error) return res.status(400).json({ error: v.error });
    consent.insertForm.run({ ...v, appointment_id: appt.id, client_id: appt.client_id, artist_id: appt.artist_id, ip: String(req.ip || '').slice(0, 64), user_agent: String(req.get('user-agent') || '').slice(0, 200) });
    const form = consent.shape(consent.getForm.get(appt.id));
    mailer.notify(mailer.templates.consentSigned(appt, form));
    res.status(201).json({ form });
  } catch (err) { next(err); }
});

router.get('/appointments/:id/consent/signature.png', requireAuth, (req, res) => {
  const appt = party(req, res);
  if (!appt) return;
  const row = consent.getForm.get(appt.id);
  if (!row || !row.signature) return res.status(404).json({ error: 'Not signed yet.' });
  res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" }).send(row.signature);
});

module.exports = router;
