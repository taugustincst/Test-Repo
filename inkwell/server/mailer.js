'use strict';

/**
 * Email notifications.
 *
 * With SMTP configured (SMTP_URL, or SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS) mail is delivered
 * through nodemailer. Without it, every email is still rendered and stored in the email_log table
 * (and printed to the console) so the flow can be inspected in development.
 */

const nodemailer = require('nodemailer');
const { db } = require('./db');

const APP_NAME = 'Inkwell';
const APP_URL = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const FROM = process.env.MAIL_FROM || 'Inkwell <no-reply@inkwell.local>';

function buildTransport() {
  if (process.env.SMTP_URL) return { transport: nodemailer.createTransport(process.env.SMTP_URL), live: true };
  if (process.env.SMTP_HOST) {
    return {
      live: true,
      transport: nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === '1' || Number(process.env.SMTP_PORT) === 465,
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      }),
    };
  }
  return { transport: nodemailer.createTransport({ jsonTransport: true }), live: false };
}

const { transport, live } = buildTransport();
const quiet = process.env.NODE_ENV === 'test' || process.env.INKWELL_QUIET_MAIL === '1';

const insertLog = db.prepare(`
  INSERT INTO email_log (to_user_id, to_email, subject, body_text, body_html, status, error)
  VALUES (@to_user_id, @to_email, @subject, @body_text, @body_html, @status, @error)
`);
const getUser = db.prepare('SELECT id, email, name, role, email_notifications FROM users WHERE id = ?');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Wrap plain paragraphs in a small HTML layout. */
function layout(title, paragraphs, cta) {
  const body = paragraphs.map((p) => `<p style="margin:0 0 14px;line-height:1.55">${esc(p)}</p>`).join('');
  const button = cta
    ? `<p style="margin:22px 0"><a href="${esc(cta.url)}" style="background:#d4553f;color:#fff;text-decoration:none;padding:12px 20px;border-radius:999px;display:inline-block;font-weight:600">${esc(cta.label)}</a></p><p style="font-size:12px;color:#888">Or open this link: ${esc(cta.url)}</p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f4f1ea;font-family:Helvetica,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:560px;margin:0 auto;padding:32px 20px">
  <div style="font-size:22px;font-weight:700;margin-bottom:18px">${APP_NAME}</div>
  <div style="background:#fff;border-radius:14px;padding:26px;border:1px solid #e6e1d6">
    <h1 style="font-size:20px;margin:0 0 16px">${esc(title)}</h1>
    ${body}${button}
  </div>
  <p style="font-size:12px;color:#888;margin-top:18px">You are receiving this because you have an ${APP_NAME} account. Notification preferences live in your profile settings.</p>
</div></body></html>`;
}

/**
 * Send an email to a user. Returns the log row id. Never throws: failures are logged.
 * @param {object} opts
 * @param {number|object} opts.to user id or user row
 * @param {string} opts.subject
 * @param {string} opts.title heading inside the email
 * @param {string[]} opts.paragraphs
 * @param {{label:string,url:string}} [opts.cta]
 * @param {boolean} [opts.force] ignore the user's notification preference (account emails)
 */
async function send({ to, subject, title, paragraphs, cta, force = false }) {
  const user = typeof to === 'object' ? to : getUser.get(to);
  if (!user) return null;
  // Every non-account email is also an in-app notification and, where the user opted in, a push.
  if (!force) {
    const push = require('./push');
    push.deliver(user.id, { title, body: paragraphs[0] || '', url: cta ? cta.url : null }).catch((err) => console.error('[push]', err.message));
  }
  const text = `${title}\n\n${paragraphs.join('\n\n')}${cta ? `\n\n${cta.label}: ${cta.url}` : ''}\n`;
  const html = layout(title, paragraphs, cta);
  const record = { to_user_id: user.id, to_email: user.email, subject, body_text: text, body_html: html, status: 'logged', error: null };

  if (!force && user.email_notifications === 0) {
    record.status = 'skipped';
    return insertLog.run(record).lastInsertRowid;
  }
  if (!live) {
    const id = insertLog.run(record).lastInsertRowid;
    if (!quiet) console.log(`[mail] to ${user.email}: ${subject}${cta ? ` (${cta.url})` : ''}`);
    return id;
  }
  try {
    await transport.sendMail({ from: FROM, to: user.email, subject, text, html });
    record.status = 'sent';
  } catch (err) {
    record.status = 'failed';
    record.error = String(err.message || err).slice(0, 500);
    console.error(`[mail] failed to send to ${user.email}: ${record.error}`);
  }
  return insertLog.run(record).lastInsertRowid;
}

/** Fire-and-forget wrapper so request handlers never wait on mail delivery. */
function notify(opts) {
  send(opts).catch((err) => console.error('[mail] unexpected error', err));
}

const fmtWhen = (iso) => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const money = (n) => `$${Number(n || 0).toLocaleString()}`;

/** Templates for each event in the app. Each takes already-joined rows from the routes. */
const templates = {
  welcome(user) {
    return {
      to: user, force: true, subject: `Welcome to ${APP_NAME}`,
      title: `Welcome, ${user.name.split(' ')[0]}`,
      paragraphs: user.role === 'artist'
        ? ['Your studio is live. Create a gallery, publish your weekly hours, and browse client requests to fill your books.']
        : ['Your account is ready. Browse artists, post what you want, and book a session when you find the right fit.'],
      cta: { label: user.role === 'artist' ? 'Open your dashboard' : 'Find an artist', url: `${APP_URL}/${user.role === 'artist' ? 'dashboard' : 'artists'}` },
    };
  },
  passwordReset(user, url) {
    return {
      to: user, force: true, subject: `Reset your ${APP_NAME} password`,
      title: 'Reset your password',
      paragraphs: ['Someone asked to reset the password for this account. The link below works for one hour. If that was not you, you can ignore this email.'],
      cta: { label: 'Choose a new password', url },
    };
  },
  passwordChanged(user) {
    return {
      to: user, force: true, subject: `Your ${APP_NAME} password was changed`,
      title: 'Password changed',
      paragraphs: ['Your password was just changed and all other sessions were signed out. If you did not do this, reset your password right away.'],
      cta: { label: 'Reset password', url: `${APP_URL}/forgot` },
    };
  },
  bookingRequested(appt) {
    return {
      to: appt.artist_id, subject: `New booking request from ${appt.client_name}`,
      title: 'New booking request',
      paragraphs: [
        `${appt.client_name} requested ${fmtWhen(appt.starts_at)} to ${new Date(appt.ends_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}${appt.flash_title ? ` for your flash design "${appt.flash_title}" (${money(appt.flash_price)})` : ''}.`,
        appt.note ? `Their note: "${appt.note}"` : 'They did not leave a note.',
        appt.deposit_amount ? `A ${money(appt.deposit_amount)} deposit is due from the client.` : 'No deposit is required for this booking.',
      ],
      cta: { label: 'Review the request', url: `${APP_URL}/appointments` },
    };
  },
  bookingStatus(appt, action, actorName, links) {
    const map = {
      confirm: ['Booking confirmed', `${actorName} confirmed your session on ${fmtWhen(appt.starts_at)}.`],
      decline: ['Booking declined', `${actorName} could not take your session on ${fmtWhen(appt.starts_at)}. Any deposit you paid has been refunded.`],
      cancel: ['Booking cancelled', `${actorName} cancelled the session on ${fmtWhen(appt.starts_at)}.`],
      complete: ['Session completed', `${actorName} marked your session on ${fmtWhen(appt.starts_at)} as completed.${appt.price ? ` The session total is ${money(appt.price)}.` : ''}`],
    };
    const [title, line] = map[action];
    const paragraphs = [line];
    if (links && links.google) paragraphs.push(`Add it to your calendar: ${links.google}`, 'You will get a reminder the day before and two hours before the session.');
    return { subject: title, title, paragraphs, cta: { label: 'View bookings', url: `${APP_URL}/appointments` } };
  },
  paymentDue(payment, appt) {
    return {
      to: payment.payer_id, subject: `${payment.kind === 'deposit' ? 'Deposit' : 'Balance'} due for your session with ${appt.artist_name}`,
      title: `${money(payment.amount)} ${payment.kind} due`,
      paragraphs: [`Your session with ${appt.artist_name} on ${fmtWhen(appt.starts_at)} has a ${money(payment.amount)} ${payment.kind} to pay.`],
      cta: { label: 'Pay now', url: `${APP_URL}/appointments` },
    };
  },
  paymentReceived(payment, appt) {
    return {
      to: payment.payee_id, subject: `${appt.client_name} paid a ${money(payment.amount)} ${payment.kind}`,
      title: 'Payment received',
      paragraphs: [`${appt.client_name} paid the ${money(payment.amount)} ${payment.kind} for ${fmtWhen(appt.starts_at)}.`],
      cta: { label: 'View bookings', url: `${APP_URL}/appointments` },
    };
  },
  paymentRefunded(payment, appt) {
    return {
      to: payment.payer_id, subject: `Your ${money(payment.amount)} ${payment.kind} was refunded`,
      title: 'Refund issued',
      paragraphs: [`The ${money(payment.amount)} ${payment.kind} for your session with ${appt.artist_name} on ${fmtWhen(appt.starts_at)} has been refunded to your original payment method.`],
    };
  },
  proposalReceived(request, proposal) {
    return {
      to: request.client_id, subject: `${proposal.artist_name} sent a proposal for "${request.title}"`,
      title: 'New proposal',
      paragraphs: [
        `${proposal.artist_name} wants to work on "${request.title}".`,
        proposal.quoted_price ? `Quote: ${money(proposal.quoted_price)}${proposal.estimated_hours ? ` for about ${proposal.estimated_hours} hours` : ''}.` : 'They did not include a quote.',
      ],
      cta: { label: 'Read the proposal', url: `${APP_URL}/requests/${request.id}` },
    };
  },
  proposalDecided(request, proposal, accepted) {
    return {
      to: proposal.artist_id, subject: `${request.client_name} ${accepted ? 'accepted' : 'declined'} your proposal`,
      title: accepted ? 'Proposal accepted' : 'Proposal declined',
      paragraphs: [accepted
        ? `${request.client_name} accepted your proposal for "${request.title}". They can now book from your availability, and you can message them to plan the piece.`
        : `${request.client_name} went another direction on "${request.title}". Thanks for taking the time to propose.`],
      cta: { label: 'Open the request', url: `${APP_URL}/requests/${request.id}` },
    };
  },
  reportFiled(adminId, report) {
    return {
      to: adminId, force: true, subject: `New report: ${report.target_type} #${report.target_id}`,
      title: 'Content reported',
      paragraphs: [`A ${report.target_type} was reported for "${report.reason}".`, report.details ? `Details: ${report.details}` : 'No further details were given.'],
      cta: { label: 'Open the moderation queue', url: `${APP_URL}/admin` },
    };
  },
  accountSuspended(user, reason) {
    return {
      to: user, force: true, subject: `Your ${APP_NAME} account has been suspended`,
      title: 'Account suspended',
      paragraphs: [`Your account was suspended${reason ? ` for the following reason: ${reason}` : ''}.`, 'While suspended you cannot sign in, book, post or message. Reply to this email if you believe this was a mistake.'],
    };
  },
  accountReinstated(user) {
    return {
      to: user, force: true, subject: `Your ${APP_NAME} account is active again`,
      title: 'Welcome back',
      paragraphs: ['Your account has been reinstated and you can sign in as usual.'],
      cta: { label: 'Sign in', url: `${APP_URL}/login` },
    };
  },
  accountDeleted(user) {
    return {
      to: user, force: true, subject: `Your ${APP_NAME} account has been deleted`,
      title: 'Account deleted',
      paragraphs: ['Your profile, galleries, requests and messages have been removed. Records of completed payments are kept for accounting, with your personal details replaced.'],
    };
  },
  reviewReceived(review, artistId) {
    return {
      to: artistId, subject: `${review.client_name} left you a ${review.rating}-star review`,
      title: 'New review',
      paragraphs: [review.body ? `"${review.body}"` : `${review.client_name} rated the session ${review.rating} out of 5.`],
      cta: { label: 'See your reviews', url: `${APP_URL}/artists/${artistId}` },
    };
  },
  sessionReminder(appt, recipientId, kind, links) {
    const isArtist = recipientId === appt.artist_id;
    const other = isArtist ? appt.client_name : appt.artist_name;
    const when = fmtWhen(appt.starts_at);
    const where = [appt.studio_name, appt.artist_location].filter(Boolean).join(', ');
    const lines = [kind === 'soon' ? `Your session with ${other} starts at ${fmtWhen(appt.starts_at).replace(/^.*?, /, '')} today, in about two hours.` : `Your session with ${other} is tomorrow, ${when}.`];
    if (where && !isArtist) lines.push(`Where: ${where}.`);
    if (!isArtist) lines.push('Eat a proper meal, bring water, and wear something that gives easy access to the placement.');
    if (appt.note) lines.push(`Notes: ${appt.note}`);
    if (!isArtist && appt.consent_pending) lines.push(`Please complete your consent form before the session: ${APP_URL}/appointments/${appt.id}/consent`);
    if (isArtist && appt.consent_pending) lines.push(`${other} has not signed the consent form yet.`);
    if (links && links.google) lines.push(`Add it to your calendar: ${links.google}`);
    return {
      to: recipientId, subject: kind === 'soon' ? `Starting soon: session with ${other}` : `Tomorrow: your session with ${other}`,
      title: kind === 'soon' ? 'Starting in about two hours' : 'Your session is tomorrow',
      paragraphs: lines,
      cta: { label: 'View booking', url: `${APP_URL}/appointments` },
    };
  },
  consentSigned(appt, form) {
    return {
      to: appt.artist_id, subject: `${appt.client_name} signed the consent form`,
      title: 'Consent form signed',
      paragraphs: [`${form.full_name} signed the consent form for the session on ${fmtWhen(appt.starts_at)}.${form.flags && form.flags.length ? ` They flagged ${form.flags.length} health item${form.flags.length === 1 ? '' : 's'} to read before the session.` : ' No health items were flagged.'}`],
      cta: { label: 'View the form', url: `${APP_URL}/appointments/${appt.id}/consent` },
    };
  },
  confirmationNudge(appt) {
    return {
      to: appt.artist_id, subject: `${appt.client_name}'s booking still needs your confirmation`,
      title: 'A booking is waiting on you',
      paragraphs: [`${appt.client_name} requested ${fmtWhen(appt.starts_at)} and it is less than two days away. Confirm or decline so they can plan.`],
      cta: { label: 'Review booking', url: `${APP_URL}/appointments` },
    };
  },
  reviewReminder(appt, clientId) {
    return {
      to: clientId, subject: `How was your session with ${appt.artist_name}?`,
      title: `How did it go with ${appt.artist_name.split(' ')[0]}?`,
      paragraphs: [`Your session on ${fmtWhen(appt.starts_at)} is done. A short review helps ${appt.artist_name.split(' ')[0]} and helps other people find the right artist. Healed photos are welcome too.`],
      cta: { label: 'Leave a review', url: `${APP_URL}/appointments?review=${appt.id}` },
    };
  },
  newMessage(sender, recipientId, body) {
    return {
      to: recipientId, subject: `New message from ${sender.name}`,
      title: `${sender.name} sent you a message`,
      paragraphs: [body.length > 240 ? `${body.slice(0, 240)}...` : body],
      cta: { label: 'Reply', url: `${APP_URL}/messages/${sender.id}` },
    };
  },
};

module.exports = { send, notify, templates, APP_URL, live };
