'use strict';

const express = require('express');
const { db, STYLES } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { upload } = require('../upload');
const { processReference } = require('../images');
const mailer = require('../mailer');

const router = express.Router();

const REQUEST_SELECT = `
  SELECT r.*, u.name AS client_name, u.avatar_url AS client_avatar_url,
         (SELECT COUNT(*) FROM proposals p WHERE p.request_id = r.id) AS proposal_count
  FROM tattoo_requests r JOIN users u ON u.id = r.client_id
`;

const getRequest = db.prepare(`${REQUEST_SELECT} WHERE r.id = ?`);
const listOpen = db.prepare(`${REQUEST_SELECT} WHERE r.status = 'open' AND u.suspended_at IS NULL ORDER BY r.created_at DESC, r.id DESC`);
const listForClient = db.prepare(`${REQUEST_SELECT} WHERE r.client_id = ? ORDER BY r.created_at DESC, r.id DESC`);
const listForArtist = db.prepare(`
  ${REQUEST_SELECT}
  WHERE r.id IN (SELECT request_id FROM proposals WHERE artist_id = ?)
  ORDER BY r.created_at DESC, r.id DESC
`);
const insertRequest = db.prepare(`
  INSERT INTO tattoo_requests
    (client_id, title, description, style, placement, size, budget_min, budget_max, location, reference_image_url)
  VALUES
    (@client_id, @title, @description, @style, @placement, @size, @budget_min, @budget_max, @location, @reference_image_url)
`);
const updateStatus = db.prepare('UPDATE tattoo_requests SET status = ? WHERE id = ?');
const deleteRequest = db.prepare('DELETE FROM tattoo_requests WHERE id = ?');

const proposalsFor = db.prepare(`
  SELECT p.*, u.name AS artist_name, u.avatar_url AS artist_avatar_url, u.location AS artist_location,
         ap.studio_name, ap.styles AS artist_styles
  FROM proposals p
  JOIN users u ON u.id = p.artist_id
  LEFT JOIN artist_profiles ap ON ap.user_id = p.artist_id
  WHERE p.request_id = ? ORDER BY p.created_at ASC, p.id ASC
`);
const myProposal = db.prepare('SELECT * FROM proposals WHERE request_id = ? AND artist_id = ?');
const getProposal = db.prepare('SELECT * FROM proposals WHERE id = ?');
const insertProposal = db.prepare(`
  INSERT INTO proposals (request_id, artist_id, message, quoted_price, estimated_hours)
  VALUES (?, ?, ?, ?, ?)
`);
const setProposalStatus = db.prepare('UPDATE proposals SET status = ? WHERE id = ?');
const declineOthers = db.prepare(`UPDATE proposals SET status = 'declined' WHERE request_id = ? AND id != ? AND status = 'pending'`);

function money(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function shape(row, user) {
  if (!row) return row;
  row.is_owner = !!user && user.id === row.client_id;
  if (user && user.role === 'artist') {
    const mine = myProposal.get(row.id, user.id);
    row.my_proposal = mine || null;
  }
  return row;
}

/** GET /api/requests?style=&location=&mine=1 */
router.get('/', (req, res) => {
  const style = String(req.query.style || '').trim();
  const location = String(req.query.location || '').trim().toLowerCase();
  const mine = req.query.mine === '1';

  let rows;
  if (mine && req.user) {
    rows = req.user.role === 'client' ? listForClient.all(req.user.id) : listForArtist.all(req.user.id);
  } else {
    rows = listOpen.all();
  }
  if (style) rows = rows.filter((r) => r.style === style);
  if (location) rows = rows.filter((r) => (r.location || '').toLowerCase().includes(location));
  res.json({ requests: rows.map((r) => shape(r, req.user)), styles: STYLES });
});

router.post('/', requireRole('client'), upload.single('reference'), async (req, res) => {
  const body = req.body || {};
  const title = String(body.title || '').trim();
  const description = String(body.description || '').trim();
  if (!title) return res.status(400).json({ error: 'Give your request a title.' });
  if (description.length < 10) return res.status(400).json({ error: 'Describe the tattoo you want in a few sentences.' });
  const budgetMin = money(body.budget_min);
  const budgetMax = money(body.budget_max);
  if (budgetMin !== null && budgetMax !== null && budgetMin > budgetMax) {
    return res.status(400).json({ error: 'Minimum budget cannot exceed the maximum.' });
  }
  let referenceUrl = null;
  if (req.file) {
    try { referenceUrl = await processReference(req.file); } catch (err) { return res.status(400).json({ error: err.message }); }
  }
  const info = insertRequest.run({
    client_id: req.user.id,
    title: title.slice(0, 120),
    description: description.slice(0, 4000),
    style: STYLES.includes(body.style) ? body.style : '',
    placement: String(body.placement || '').slice(0, 60),
    size: String(body.size || '').slice(0, 60),
    budget_min: budgetMin,
    budget_max: budgetMax,
    location: String(body.location || req.user.location || '').slice(0, 120),
    reference_image_url: referenceUrl,
  });
  res.status(201).json({ request: shape(getRequest.get(info.lastInsertRowid), req.user) });
});

router.get('/:id', (req, res) => {
  const request = getRequest.get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found.' });
  shape(request, req.user);
  const canSeeAll = req.user && req.user.id === request.client_id;
  const proposals = proposalsFor.all(request.id).map((p) => ({ ...p, artist_styles: JSON.parse(p.artist_styles || '[]') }));
  // Artists only see their own proposal; the client sees all of them.
  request.proposals = canSeeAll ? proposals : proposals.filter((p) => req.user && p.artist_id === req.user.id);
  res.json({ request });
});

router.put('/:id/status', requireRole('client'), (req, res) => {
  const request = getRequest.get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found.' });
  if (request.client_id !== req.user.id) return res.status(403).json({ error: 'This is not your request.' });
  const status = String((req.body || {}).status || '');
  if (!['open', 'in_progress', 'closed'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  updateStatus.run(status, request.id);
  res.json({ request: shape(getRequest.get(request.id), req.user) });
});

router.delete('/:id', requireRole('client'), (req, res) => {
  const request = getRequest.get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found.' });
  if (request.client_id !== req.user.id) return res.status(403).json({ error: 'This is not your request.' });
  deleteRequest.run(request.id);
  res.json({ ok: true });
});

router.post('/:id/proposals', requireRole('artist'), (req, res) => {
  const request = getRequest.get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found.' });
  if (request.status !== 'open') return res.status(400).json({ error: 'This request is no longer accepting proposals.' });
  if (myProposal.get(request.id, req.user.id)) return res.status(409).json({ error: 'You already sent a proposal for this request.' });
  const body = req.body || {};
  const message = String(body.message || '').trim();
  if (message.length < 10) return res.status(400).json({ error: 'Tell the client how you would approach the piece.' });
  const hours = body.estimated_hours === undefined || body.estimated_hours === '' ? null : Number(body.estimated_hours);
  insertProposal.run(
    request.id,
    req.user.id,
    message.slice(0, 3000),
    money(body.quoted_price),
    Number.isFinite(hours) && hours > 0 ? Math.round(hours * 10) / 10 : null,
  );
  const proposal = myProposal.get(request.id, req.user.id);
  mailer.notify(mailer.templates.proposalReceived(request, { ...proposal, artist_name: req.user.name }));
  res.status(201).json({ request: shape(getRequest.get(request.id), req.user), proposal });
});

function decideProposal(status) {
  return (req, res) => {
    const proposal = getProposal.get(req.params.id);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found.' });
    const request = getRequest.get(proposal.request_id);
    if (!request || request.client_id !== req.user.id) return res.status(403).json({ error: 'This is not your request.' });
    if (proposal.status !== 'pending') return res.status(400).json({ error: 'This proposal has already been answered.' });
    db.transaction(() => {
      setProposalStatus.run(status, proposal.id);
      if (status === 'accepted') {
        declineOthers.run(request.id, proposal.id);
        updateStatus.run('in_progress', request.id);
      }
    })();
    mailer.notify(mailer.templates.proposalDecided(request, proposal, status === 'accepted'));
    res.json({ proposal: getProposal.get(proposal.id), request: shape(getRequest.get(request.id), req.user) });
  };
}

router.post('/proposals/:id/accept', requireAuth, decideProposal('accepted'));
router.post('/proposals/:id/decline', requireAuth, decideProposal('declined'));

module.exports = router;
