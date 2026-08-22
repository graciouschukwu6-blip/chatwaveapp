const express = require('express');
const crypto = require('crypto');
const { query } = require('../database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// ===== CHANNELS =====

// Create channel
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { name, description, is_public } = req.body;
    if (!name) return res.status(400).json({ error: 'Channel name required' });

    const inviteCode = crypto.randomBytes(4).toString('hex');
    const conv = await query(
      `INSERT INTO conversations (type, name, description, invite_code, created_by) VALUES ('channel', $1, $2, $3, $4) RETURNING id`,
      [name, description || null, inviteCode, req.user.id]
    );
    const convId = conv.rows[0].id;

    // Creator is admin
    await query('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, $3)', [convId, req.user.id, 'admin']);

    res.status(201).json({ id: convId, name, invite_code: inviteCode });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// List public channels (for discovery)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await query(`
      SELECT c.id, c.name, c.description, c.created_at,
        (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) as subscriber_count
      FROM conversations c WHERE c.type = 'channel'
      ORDER BY subscriber_count DESC LIMIT 50
    `);
    res.json({ channels: result.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Subscribe to channel
router.post('/:id/subscribe', authenticateToken, async (req, res) => {
  try {
    const convId = req.params.id;
    const conv = await query('SELECT id, type FROM conversations WHERE id = $1 AND type = $2', [convId, 'channel']);
    if (conv.rows.length === 0) return res.status(404).json({ error: 'Channel not found' });

    await query(
      'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [convId, req.user.id, 'subscriber']
    );
    res.json({ subscribed: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Unsubscribe from channel
router.post('/:id/unsubscribe', authenticateToken, async (req, res) => {
  try {
    const convId = req.params.id;
    // Admins can't unsubscribe (they must transfer/delete)
    const member = await query('SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [convId, req.user.id]);
    if (member.rows.length > 0 && member.rows[0].role === 'admin') {
      return res.status(400).json({ error: 'Admins cannot unsubscribe. Transfer ownership first.' });
    }
    await query('DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [convId, req.user.id]);
    res.json({ subscribed: false });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Get channel info
router.get('/:id/info', authenticateToken, async (req, res) => {
  try {
    const convId = req.params.id;
    const conv = await query('SELECT * FROM conversations WHERE id = $1 AND type = $2', [convId, 'channel']);
    if (conv.rows.length === 0) return res.status(404).json({ error: 'Channel not found' });

    const members = await query(`
      SELECT cm.role, u.id, u.username, u.avatar FROM conversation_members cm
      JOIN users u ON cm.user_id = u.id WHERE cm.conversation_id = $1
    `, [convId]);

    const admins = members.rows.filter(m => m.role === 'admin');
    const subscriberCount = members.rows.length;

    res.json({ channel: conv.rows[0], admins, subscriber_count: subscriberCount });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
