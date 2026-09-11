'use strict';

/**
 * Consent forms. Before a session the client confirms their identity and age, answers a short
 * health questionnaire, accepts the studio's terms and signs. The signed form is stored with the
 * appointment as the artist's record; the signature image lives in the database and is served
 * only to the two parties.
 */

const sharp = require('sharp');
const { db } = require('./db');

const FORM_VERSION = 2;
const MIN_AGE_DEFAULT = 18;
const SIGNATURE_MAX_BYTES = 400 * 1024;

/** Health questions. `detail` asks for a free-text follow-up when answered yes. */
const HEALTH_QUESTIONS = [
  { key: 'allergies', label: 'Do you have any allergies (latex, nickel, pigments, antibiotics, soaps)?', detail: 'Which ones?' },
  { key: 'skin_conditions', label: 'Any skin conditions at or near the placement (eczema, psoriasis, keloids, moles)?', detail: 'Tell the artist more' },
  { key: 'medical_conditions', label: 'Any medical conditions the artist should know about (diabetes, epilepsy, heart conditions, haemophilia, hepatitis, HIV, immune disorders)?', detail: 'Which ones?' },
  { key: 'medications', label: 'Are you taking any medication, including blood thinners, Accutane or steroids?', detail: 'Which ones?' },
  { key: 'pregnant', label: 'Are you pregnant or breastfeeding?' },
  { key: 'fainting', label: 'Have you ever fainted or had a bad reaction during a tattoo, piercing or blood draw?', detail: 'What happened?' },
  { key: 'alcohol', label: 'Have you had alcohol or recreational drugs in the last 24 hours?' },
];

const ACKNOWLEDGEMENTS = [
  { key: 'age', label: (minAge) => `I confirm I am at least ${minAge} years old and the details above are true.` },
  { key: 'voluntary', label: () => 'I am getting this tattoo voluntarily. I have discussed the design, size and placement with the artist and approve them.' },
  { key: 'risks', label: () => 'I understand tattooing breaks the skin and carries risks including infection, allergic reaction, scarring and variation in how the ink heals, and that a tattoo is permanent.' },
  { key: 'aftercare', label: () => 'I will follow the aftercare instructions given to me and understand that healing depends on my care of the tattoo.' },
  { key: 'release', label: () => 'I release the artist and studio from liability for outcomes caused by inaccurate information given here or by not following aftercare.' },
];

const DEFAULT_TERMS = 'Deposits are non-refundable within 48 hours of the session. Please arrive rested, fed and sober. Bring photo ID. If you are unwell on the day, message me and we will reschedule.';

const getForm = db.prepare('SELECT * FROM consent_forms WHERE appointment_id = ?');
const getFormMeta = db.prepare('SELECT id, appointment_id, signed_at, full_name, date_of_birth, photo_consent, form_version FROM consent_forms WHERE appointment_id = ?');
const insertForm = db.prepare(`
  INSERT INTO consent_forms (appointment_id, client_id, artist_id, full_name, date_of_birth, answers, acknowledgements, photo_consent, signature, terms_text, form_version, ip, user_agent)
  VALUES (@appointment_id, @client_id, @artist_id, @full_name, @date_of_birth, @answers, @acknowledgements, @photo_consent, @signature, @terms_text, @form_version, @ip, @user_agent)
`);
const artistSettings = db.prepare('SELECT consent_terms, require_consent, consent_photo_ask, consent_min_age FROM artist_profiles WHERE user_id = ?');
const saveSettings = db.prepare('UPDATE artist_profiles SET consent_terms = ?, require_consent = ?, consent_photo_ask = ?, consent_min_age = ? WHERE user_id = ?');

function settingsFor(artistId) {
  const row = artistSettings.get(artistId) || {};
  return {
    terms: row.consent_terms || DEFAULT_TERMS,
    require_consent: !!row.require_consent,
    photo_ask: row.consent_photo_ask === null || row.consent_photo_ask === undefined ? true : !!row.consent_photo_ask,
    min_age: row.consent_min_age || MIN_AGE_DEFAULT,
  };
}

function updateSettings(artistId, body) {
  const current = settingsFor(artistId);
  const terms = body.terms === undefined ? current.terms : String(body.terms || '').trim().slice(0, 4000);
  const minAge = body.min_age === undefined ? current.min_age : Number(body.min_age);
  if (!Number.isInteger(minAge) || minAge < 16 || minAge > 21) return { error: 'Minimum age must be between 16 and 21.' };
  saveSettings.run(terms || DEFAULT_TERMS, body.require_consent === undefined ? (current.require_consent ? 1 : 0) : (body.require_consent ? 1 : 0), body.photo_ask === undefined ? (current.photo_ask ? 1 : 0) : (body.photo_ask ? 1 : 0), minAge, artistId);
  return settingsFor(artistId);
}

/** Definition the client sees: questions, acknowledgements, the artist's terms. */
function definition(artistId) {
  const s = settingsFor(artistId);
  return {
    version: FORM_VERSION,
    min_age: s.min_age,
    health: HEALTH_QUESTIONS,
    acknowledgements: ACKNOWLEDGEMENTS.map((a) => ({ key: a.key, label: a.label(s.min_age) })),
    photo_ask: s.photo_ask,
    terms: s.terms,
  };
}

function ageOn(dob, on = new Date()) {
  const m = String(dob || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const birth = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(birth.getTime()) || birth.getFullYear() < 1900 || birth > on) return null;
  let age = on.getFullYear() - birth.getFullYear();
  const beforeBirthday = on.getMonth() < birth.getMonth() || (on.getMonth() === birth.getMonth() && on.getDate() < birth.getDate());
  if (beforeBirthday) age -= 1;
  return age;
}

/** Decode and normalise a signature: a PNG data URL drawn on a canvas, re-encoded to a small PNG. */
async function decodeSignature(dataUrl) {
  const m = String(dataUrl || '').match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new Error('Sign in the box before submitting.');
  const raw = Buffer.from(m[1], 'base64');
  if (raw.length > SIGNATURE_MAX_BYTES) throw new Error('The signature image is too large.');
  const image = sharp(raw, { failOn: 'error' });
  const meta = await image.metadata();
  if (meta.format !== 'png' || !meta.width || !meta.height || meta.width > 2000 || meta.height > 1000) throw new Error('The signature could not be read.');
  // A signature must contain some ink: reject blank canvases.
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let inked = 0;
  for (let i = 3; i < data.length; i += 4 * 7) if (data[i] > 40) inked += 1;
  if (inked < 20) throw new Error('Sign in the box before submitting.');
  void info;
  return sharp(raw).resize({ width: 600, withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
}

/** Validate a submission. Returns { error } or the row to insert (minus ids). */
async function validate(body, settings, { signedOn = new Date() } = {}) {
  const b = body || {};
  const fullName = String(b.full_name || '').trim().slice(0, 120);
  if (fullName.length < 2) return { error: 'Enter your full legal name as it appears on your ID.' };
  const age = ageOn(b.date_of_birth, signedOn);
  if (age === null) return { error: 'Enter your date of birth.' };
  if (age < settings.min_age) return { error: `You must be at least ${settings.min_age} to be tattooed here.` };
  const answersIn = b.answers && typeof b.answers === 'object' ? b.answers : {};
  const answers = {};
  for (const q of HEALTH_QUESTIONS) {
    const a = answersIn[q.key];
    const yes = a === true || a === 'yes' || (a && typeof a === 'object' && (a.yes === true || a.yes === 'yes'));
    if (a === undefined || a === null || a === '') return { error: 'Answer every health question.' };
    const detail = a && typeof a === 'object' ? String(a.detail || '').trim().slice(0, 500) : '';
    if (yes && q.detail && !detail) return { error: `Add a few words about: ${q.label.replace(/\?$/, '')}.` };
    answers[q.key] = { yes, detail: yes ? detail : '' };
  }
  const acksIn = b.acknowledgements && typeof b.acknowledgements === 'object' ? b.acknowledgements : {};
  const acknowledgements = {};
  for (const a of ACKNOWLEDGEMENTS) {
    if (!(acksIn[a.key] === true || acksIn[a.key] === 'yes' || acksIn[a.key] === 'on')) return { error: 'Tick every acknowledgement to continue.' };
    acknowledgements[a.key] = true;
  }
  let signature;
  try { signature = await decodeSignature(b.signature); } catch (err) { return { error: err.message }; }
  return {
    full_name: fullName,
    date_of_birth: b.date_of_birth,
    answers: JSON.stringify(answers),
    acknowledgements: JSON.stringify(acknowledgements),
    photo_consent: settings.photo_ask ? (b.photo_consent === true || b.photo_consent === 'yes' || b.photo_consent === 'on' ? 1 : 0) : null,
    signature,
    terms_text: settings.terms,
    form_version: FORM_VERSION,
  };
}

function shape(row, { includeAnswers = true } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    appointment_id: row.appointment_id,
    full_name: row.full_name,
    date_of_birth: row.date_of_birth,
    photo_consent: row.photo_consent === null ? null : !!row.photo_consent,
    signed_at: row.signed_at,
    form_version: row.form_version,
    signature_url: `/api/appointments/${row.appointment_id}/consent/signature.png`,
  };
  if (includeAnswers) {
    out.answers = JSON.parse(row.answers || '{}');
    out.acknowledgements = JSON.parse(row.acknowledgements || '{}');
    out.terms_text = row.terms_text;
    out.flags = HEALTH_QUESTIONS.filter((q) => out.answers[q.key] && out.answers[q.key].yes).map((q) => ({ key: q.key, label: q.label, detail: out.answers[q.key].detail }));
  }
  return out;
}

/** Signed-or-not summary for booking cards. */
function statusFor(appointmentId, artistId) {
  const meta = getFormMeta.get(appointmentId);
  return { signed_at: meta ? meta.signed_at : null, required: settingsFor(artistId).require_consent };
}

module.exports = { FORM_VERSION, HEALTH_QUESTIONS, ACKNOWLEDGEMENTS, DEFAULT_TERMS, settingsFor, updateSettings, definition, validate, ageOn, decodeSignature, shape, statusFor, getForm, insertForm };
