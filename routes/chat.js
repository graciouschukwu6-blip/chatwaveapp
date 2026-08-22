const express = require('express');
const multer = require('multer');
const path = require('path');
const { query } = require('../database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// File upload config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../public/uploads')),
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

const voiceStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../public/uploads/voice')),
  filename: (req, file, cb) => { cb(null, 'voice_' + Date.now() + '-' + Math.round(Math.random() * 1E9) + '.webm'); }
});
const uploadVoice = multer({ storage: voiceStorage, limits: { fileSize: 10 * 1024 * 1024 } });

const groupAvatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../public/uploads/groups')),
  filename: (req, file, cb) => { cb(null, 'group_' + req.params.id + '_' + Date.now() + path.extname(file.originalname)); }
});
const uploadGroupAvatar = multer({ storage: groupAvatarStorage, limits: { fileSize: 5 * 1024 * 1024 } });

// Search users
router.get('/users/search', authenticateToken, async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ users: [] });
  const result = await query(
    `SELECT id, username, chat_number, avatar, status, last_seen, bio, status_message FROM users
     WHERE (chat_number LIKE $1 OR username LIKE $2) AND id != $3
     AND id NOT IN (SELECT blocked_id FROM blocked_users WHERE blocker_id = $4)
     AND id NOT IN (SELECT blocker_id FROM blocked_users WHERE blocked_id = $5)`,
    ['%'+q+'%', '%'+q+'%', req.user.id, req.user.id, req.user.id]
  );
  res.json({ users: result.rows });
});

// Start private conversation
router.post('/conversations/private', authenticateToken, async (req, res) => {
  const { chat_number } = req.body;
  const userResult = await query('SELECT id, username, chat_number, avatar FROM users WHERE chat_number = $1', [chat_number]);
  if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
  const otherUser = userResult.rows[0];
  if (otherUser.id === req.user.id) return res.status(400).json({ error: 'Cannot chat with yourself' });

  const blocked = await query('SELECT id FROM blocked_users WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $3 AND blocked_id = $4)', [req.user.id, otherUser.id, otherUser.id, req.user.id]);
  if (blocked.rows.length > 0) return res.status(403).json({ error: 'Cannot message this user' });

  const existing = await query(`
    SELECT c.id FROM conversations c
    JOIN conversation_members cm1 ON c.id = cm1.conversation_id AND cm1.user_id = $1
    JOIN conversation_members cm2 ON c.id = cm2.conversation_id AND cm2.user_id = $2
    WHERE c.type = 'private'
  `, [req.user.id, otherUser.id]);

  if (existing.rows.length > 0) return res.json({ conversation_id: existing.rows[0].id, user: otherUser });

  const conv = await query('INSERT INTO conversations (type, created_by) VALUES ($1, $2) RETURNING id', ['private', req.user.id]);
  const convId = conv.rows[0].id;
  await query('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, $3)', [convId, req.user.id, 'member']);
  await query('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, $3)', [convId, otherUser.id, 'member']);
  res.status(201).json({ conversation_id: convId, user: otherUser });
});

// Create group
router.post('/conversations/group', authenticateToken, async (req, res) => {
  const { name, members } = req.body;
  if (!name || !members || members.length < 1) return res.status(400).json({ error: 'Group name and at least 1 member required' });

  const conv = await query('INSERT INTO conversations (type, name, created_by) VALUES ($1, $2, $3) RETURNING id', ['group', name, req.user.id]);
  const convId = conv.rows[0].id;
  await query('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, $3)', [convId, req.user.id, 'admin']);

  for (const chatNum of members) {
    const u = await query('SELECT id FROM users WHERE chat_number = $1', [chatNum.trim()]);
    if (u.rows.length > 0) {
      await query('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [convId, u.rows[0].id, 'member']);
    }
  }
  res.status(201).json({ conversation_id: convId, name });
});

// Update group
router.put('/conversations/:id', authenticateToken, uploadGroupAvatar.single('group_avatar'), async (req, res) => {
  const convId = req.params.id;
  const member = await query('SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [convId, req.user.id]);
  if (member.rows.length === 0 || member.rows[0].role !== 'admin') return res.status(403).json({ error: 'Only admins can update group' });

  if (req.body.name) await query('UPDATE conversations SET name = $1 WHERE id = $2', [req.body.name, convId]);
  if (req.file) await query('UPDATE conversations SET group_avatar = $1 WHERE id = $2', ['/uploads/groups/' + req.file.filename, convId]);

  const conv = await query('SELECT * FROM conversations WHERE id = $1', [convId]);
  res.json({ conversation: conv.rows[0] });
});

// Add member
router.post('/conversations/:id/members', authenticateToken, async (req, res) => {
  const convId = req.params.id;
  const member = await query('SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [convId, req.user.id]);
  if (member.rows.length === 0 || member.rows[0].role !== 'admin') return res.status(403).json({ error: 'Only admins can add members' });

  const u = await query('SELECT id, username, chat_number, avatar FROM users WHERE chat_number = $1', [req.body.chat_number]);
  if (u.rows.length === 0) return res.status(404).json({ error: 'User not found' });

  try {
    await query('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, $3)', [convId, u.rows[0].id, 'member']);
    res.json({ message: 'Member added', user: u.rows[0] });
  } catch (e) { res.status(400).json({ error: 'User is already a member' }); }
});

// Remove member
router.delete('/conversations/:id/members/:userId', authenticateToken, async (req, res) => {
  const convId = req.params.id;
  const targetId = parseInt(req.params.userId);
  const member = await query('SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [convId, req.user.id]);
  if (member.rows.length === 0 || member.rows[0].role !== 'admin') return res.status(403).json({ error: 'Only admins can remove members' });
  if (targetId === req.user.id) return res.status(400).json({ error: 'Cannot remove yourself' });
  await query('DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [convId, targetId]);
  res.json({ message: 'Member removed' });
});

// Change role
router.put('/conversations/:id/members/:userId/role', authenticateToken, async (req, res) => {
  const convId = req.params.id;
  const targetId = parseInt(req.params.userId);
  const { role } = req.body;
  if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

  const member = await query('SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [convId, req.user.id]);
  if (member.rows.length === 0 || member.rows[0].role !== 'admin') return res.status(403).json({ error: 'Only admins can change roles' });
  if (targetId === req.user.id) return res.status(400).json({ error: 'Cannot change own role' });

  const target = await query('SELECT id FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [convId, targetId]);
  if (target.rows.length === 0) return res.status(404).json({ error: 'Not a member' });

  await query('UPDATE conversation_members SET role = $1 WHERE conversation_id = $2 AND user_id = $3', [role, convId, targetId]);
  res.json({ message: role === 'admin' ? 'User is now an admin' : 'User is now a member', role });
});

// Lock/Unlock group
router.put('/conversations/:id/lock', authenticateToken, async (req, res) => {
  const convId = req.params.id;
  const { locked } = req.body;
  const conv = await query('SELECT type FROM conversations WHERE id = $1', [convId]);
  if (conv.rows.length === 0 || conv.rows[0].type !== 'group') return res.status(400).json({ error: 'Only groups can be locked' });

  const member = await query('SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [convId, req.user.id]);
  if (member.rows.length === 0 || member.rows[0].role !== 'admin') return res.status(403).json({ error: 'Only admins can lock' });

  await query('UPDATE conversations SET locked = $1 WHERE id = $2', [locked ? 1 : 0, convId]);
  res.json({ message: locked ? 'Locked' : 'Unlocked', locked: !!locked });
});

// Get group members
router.get('/conversations/:id/members', authenticateToken, async (req, res) => {
  const result = await query(`
    SELECT u.id, u.username, u.chat_number, u.avatar, u.status, u.last_seen, cm.role
    FROM conversation_members cm JOIN users u ON cm.user_id = u.id
    WHERE cm.conversation_id = $1 ORDER BY cm.role DESC, u.username ASC
  `, [req.params.id]);
  res.json({ members: result.rows });
});

// Get conversations
router.get('/conversations', authenticateToken, async (req, res) => {
  const result = await query(`
    SELECT c.*,
      CASE WHEN c.type = 'private' THEN (
        SELECT u.username FROM users u JOIN conversation_members cm ON u.id = cm.user_id WHERE cm.conversation_id = c.id AND u.id != $1
      ) ELSE c.name END as display_name,
      CASE WHEN c.type = 'private' THEN (
        SELECT u.avatar FROM users u JOIN conversation_members cm ON u.id = cm.user_id WHERE cm.conversation_id = c.id AND u.id != $2
      ) ELSE c.group_avatar END as display_avatar,
      CASE WHEN c.type = 'private' THEN (
        SELECT u.chat_number FROM users u JOIN conversation_members cm ON u.id = cm.user_id WHERE cm.conversation_id = c.id AND u.id != $3
      ) ELSE NULL END as display_chat_number,
      CASE WHEN c.type = 'private' THEN (
        SELECT u.status FROM users u JOIN conversation_members cm ON u.id = cm.user_id WHERE cm.conversation_id = c.id AND u.id != $4
      ) ELSE NULL END as display_status,
      CASE WHEN c.type = 'private' THEN (
        SELECT u.last_seen FROM users u JOIN conversation_members cm ON u.id = cm.user_id WHERE cm.conversation_id = c.id AND u.id != $5
      ) ELSE NULL END as display_last_seen,
      (SELECT content FROM messages WHERE conversation_id = c.id AND deleted = 0 ORDER BY created_at DESC LIMIT 1) as last_message,
      (SELECT type FROM messages WHERE conversation_id = c.id AND deleted = 0 ORDER BY created_at DESC LIMIT 1) as last_message_type,
      (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_time,
      (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) as member_count,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id != $6 AND m.deleted = 0
       AND m.id NOT IN (SELECT message_id FROM read_receipts WHERE user_id = $7)) as unread_count
    FROM conversations c
    JOIN conversation_members cm ON c.id = cm.conversation_id
    WHERE cm.user_id = $8
    ORDER BY last_message_time DESC NULLS LAST
  `, [req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id]);
  res.json({ conversations: result.rows });
});

// Get messages
router.get('/conversations/:id/messages', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { limit = 50, before } = req.query;

  const member = await query('SELECT id FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [id, req.user.id]);
  if (member.rows.length === 0) return res.status(403).json({ error: 'Not a member' });

  let sql = `SELECT m.*, u.username as sender_name, u.avatar as sender_avatar, u.chat_number as sender_chat_number,
    rm.content as reply_content, rm.sender_id as reply_sender_id, ru.username as reply_sender_name
    FROM messages m JOIN users u ON m.sender_id = u.id
    LEFT JOIN messages rm ON m.reply_to = rm.id
    LEFT JOIN users ru ON rm.sender_id = ru.id
    WHERE m.conversation_id = $1`;
  let params = [id];
  let paramIdx = 2;

  if (before) { sql += ' AND m.id < $' + paramIdx; params.push(before); paramIdx++; }
  sql += ' ORDER BY m.created_at DESC LIMIT $' + paramIdx;
  params.push(parseInt(limit));

  const messages = await query(sql, params);
  const msgs = messages.rows.reverse();
  const messageIds = msgs.map(m => m.id);

  let reactions = [];
  let receipts = [];
  if (messageIds.length > 0) {
    const rResult = await query(`SELECT r.message_id, r.emoji, r.user_id, u.username FROM reactions r JOIN users u ON r.user_id = u.id WHERE r.message_id = ANY($1)`, [messageIds]);
    reactions = rResult.rows;
    const rrResult = await query(`SELECT rr.message_id, rr.user_id, u.username FROM read_receipts rr JOIN users u ON rr.user_id = u.id WHERE rr.message_id = ANY($1)`, [messageIds]);
    receipts = rrResult.rows;
  }

  res.json({ messages: msgs, reactions, receipts });
});

// Search messages
router.get('/messages/search', authenticateToken, async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ messages: [] });
  const result = await query(`
    SELECT m.*, u.username as sender_name,
      CASE WHEN c.type = 'private' THEN (
        SELECT u2.username FROM users u2 JOIN conversation_members cm2 ON u2.id = cm2.user_id WHERE cm2.conversation_id = c.id AND u2.id != $1
      ) ELSE c.name END as display_conv_name
    FROM messages m JOIN users u ON m.sender_id = u.id JOIN conversations c ON m.conversation_id = c.id
    JOIN conversation_members cm ON c.id = cm.conversation_id
    WHERE cm.user_id = $2 AND m.content LIKE $3 AND m.deleted = 0
    ORDER BY m.created_at DESC LIMIT 30
  `, [req.user.id, req.user.id, '%'+q+'%']);
  res.json({ messages: result.rows });
});

// Edit message
router.put('/messages/:id', authenticateToken, async (req, res) => {
  const msgResult = await query('SELECT * FROM messages WHERE id = $1 AND sender_id = $2', [req.params.id, req.user.id]);
  if (msgResult.rows.length === 0) return res.status(404).json({ error: 'Not found' });
  await query('UPDATE messages SET content = $1, edited = 1 WHERE id = $2', [req.body.content, req.params.id]);
  res.json({ message: 'Edited' });
});

// Forward message
router.post('/messages/:id/forward', authenticateToken, async (req, res) => {
  const msgResult = await query('SELECT * FROM messages WHERE id = $1', [req.params.id]);
  if (msgResult.rows.length === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ message: 'Forwarded' });
});

// Message info
router.get('/messages/:id/info', authenticateToken, async (req, res) => {
  const msg = await query('SELECT * FROM messages WHERE id = $1', [req.params.id]);
  if (msg.rows.length === 0) return res.status(404).json({ error: 'Not found' });
  const readBy = await query(`SELECT u.username, rr.read_at FROM read_receipts rr JOIN users u ON rr.user_id = u.id WHERE rr.message_id = $1`, [req.params.id]);
  res.json({ message: msg.rows[0], read_by: readBy.rows });
});

// Upload file
router.post('/upload', authenticateToken, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: '/uploads/' + req.file.filename, name: req.file.filename });
});

// Upload voice
router.post('/upload/voice', authenticateToken, uploadVoice.single('voice'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: '/uploads/voice/' + req.file.filename, name: req.file.filename });
});

// Get pinned messages
router.get('/conversations/:id/pinned', authenticateToken, async (req, res) => {
  const result = await query(`
    SELECT pm.*, m.content, m.type, u.username as sender_name, pb.username as pinned_by_name
    FROM pinned_messages pm JOIN messages m ON pm.message_id = m.id
    JOIN users u ON m.sender_id = u.id JOIN users pb ON pm.pinned_by = pb.id
    WHERE pm.conversation_id = $1 ORDER BY pm.created_at DESC
  `, [req.params.id]);
  res.json({ pinned: result.rows });
});

// Block user
router.post('/block', authenticateToken, async (req, res) => {
  const { chat_number } = req.body;
  const u = await query('SELECT id FROM users WHERE chat_number = $1', [chat_number]);
  if (u.rows.length === 0) return res.status(404).json({ error: 'User not found' });
  await query('INSERT INTO blocked_users (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user.id, u.rows[0].id]);
  res.json({ message: 'Blocked' });
});

// Unblock user
router.post('/unblock', authenticateToken, async (req, res) => {
  await query('DELETE FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2', [req.user.id, parseInt(req.body.user_id)]);
  res.json({ message: 'Unblocked' });
});

// Get blocked users
router.get('/blocked', authenticateToken, async (req, res) => {
  const result = await query('SELECT u.id, u.username, u.chat_number, u.avatar FROM blocked_users bu JOIN users u ON bu.blocked_id = u.id WHERE bu.blocker_id = $1', [req.user.id]);
  res.json({ blocked: result.rows });
});

// View once
router.post('/messages/:id/view-once', authenticateToken, async (req, res) => {
  const msgResult = await query('SELECT * FROM messages WHERE id = $1 AND view_once = 1 AND deleted = 0', [req.params.id]);
  if (msgResult.rows.length === 0) return res.status(404).json({ error: 'Not found or already viewed' });
  const msg = msgResult.rows[0];

  const member = await query('SELECT id FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [msg.conversation_id, req.user.id]);
  if (member.rows.length === 0) return res.status(403).json({ error: 'Not authorized' });

  if (msg.sender_id !== req.user.id) {
    await query('UPDATE messages SET deleted = 1, content = $1, file_url = NULL, file_name = NULL WHERE id = $2', ['View once media opened', req.params.id]);
  }
  res.json({ file_url: msg.file_url, type: msg.type, file_name: msg.file_name });
});

module.exports = router;
