const express = require('express');
const multer = require('multer');
const path = require('path');
const db = require('../database');
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

// Voice note upload
const voiceStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../public/uploads/voice')),
  filename: (req, file, cb) => {
    cb(null, 'voice_' + Date.now() + '-' + Math.round(Math.random() * 1E9) + '.webm');
  }
});
const uploadVoice = multer({ storage: voiceStorage, limits: { fileSize: 10 * 1024 * 1024 } });

// Group avatar upload
const groupAvatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../public/uploads/groups')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, 'group_' + req.params.id + '_' + Date.now() + ext);
  }
});
const uploadGroupAvatar = multer({ storage: groupAvatarStorage, limits: { fileSize: 5 * 1024 * 1024 } });

// Search user by chat number or username
router.get('/users/search', authenticateToken, (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ users: [] });

  const users = db.prepare(
    `SELECT id, username, chat_number, avatar, status, last_seen, bio, status_message
     FROM users 
     WHERE (chat_number LIKE ? OR username LIKE ?) AND id != ?
     AND id NOT IN (SELECT blocked_id FROM blocked_users WHERE blocker_id = ?)
     AND id NOT IN (SELECT blocker_id FROM blocked_users WHERE blocked_id = ?)`
  ).all(`%${q}%`, `%${q}%`, req.user.id, req.user.id, req.user.id);

  res.json({ users });
});

// Start or get a private conversation with a user (by chat number)
router.post('/conversations/private', authenticateToken, (req, res) => {
  const { chat_number } = req.body;
  
  const otherUser = db.prepare('SELECT id, username, chat_number, avatar FROM users WHERE chat_number = ?').get(chat_number);
  if (!otherUser) {
    return res.status(404).json({ error: 'User not found with that chat number' });
  }

  if (otherUser.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot start a conversation with yourself' });
  }

  const blocked = db.prepare(
    'SELECT id FROM blocked_users WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)'
  ).get(req.user.id, otherUser.id, otherUser.id, req.user.id);
  if (blocked) {
    return res.status(403).json({ error: 'Cannot message this user' });
  }

  const existing = db.prepare(`
    SELECT c.id FROM conversations c
    JOIN conversation_members cm1 ON c.id = cm1.conversation_id AND cm1.user_id = ?
    JOIN conversation_members cm2 ON c.id = cm2.conversation_id AND cm2.user_id = ?
    WHERE c.type = 'private'
  `).get(req.user.id, otherUser.id);

  if (existing) {
    return res.json({ conversation_id: existing.id, user: otherUser });
  }

  const conv = db.prepare('INSERT INTO conversations (type, created_by) VALUES (?, ?)').run('private', req.user.id);
  db.prepare('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)').run(conv.lastInsertRowid, req.user.id, 'member');
  db.prepare('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)').run(conv.lastInsertRowid, otherUser.id, 'member');

  res.status(201).json({ conversation_id: conv.lastInsertRowid, user: otherUser });
});

// Create group conversation
router.post('/conversations/group', authenticateToken, (req, res) => {
  const { name, members } = req.body;
  
  if (!name || !members || members.length < 1) {
    return res.status(400).json({ error: 'Group name and at least 1 other member required' });
  }

  const conv = db.prepare('INSERT INTO conversations (type, name, created_by) VALUES (?, ?, ?)').run('group', name, req.user.id);
  
  // Creator is admin
  db.prepare('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)').run(conv.lastInsertRowid, req.user.id, 'admin');
  
  for (const chatNum of members) {
    const user = db.prepare('SELECT id FROM users WHERE chat_number = ?').get(chatNum.trim());
    if (user) {
      db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)').run(conv.lastInsertRowid, user.id, 'member');
    }
  }

  res.status(201).json({ conversation_id: conv.lastInsertRowid, name });
});

// Update group (name, avatar) - admin only
router.put('/conversations/:id', authenticateToken, uploadGroupAvatar.single('group_avatar'), (req, res) => {
  const convId = req.params.id;
  const member = db.prepare('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(convId, req.user.id);
  if (!member || member.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can update group settings' });
  }

  if (req.body.name) {
    db.prepare('UPDATE conversations SET name = ? WHERE id = ?').run(req.body.name, convId);
  }
  if (req.file) {
    const avatarUrl = '/uploads/groups/' + req.file.filename;
    db.prepare('UPDATE conversations SET group_avatar = ? WHERE id = ?').run(avatarUrl, convId);
  }

  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
  res.json({ conversation: conv });
});

// Add member to group - admin only
router.post('/conversations/:id/members', authenticateToken, (req, res) => {
  const convId = req.params.id;
  const { chat_number } = req.body;

  const member = db.prepare('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(convId, req.user.id);
  if (!member || member.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can add members' });
  }

  const user = db.prepare('SELECT id, username, chat_number, avatar FROM users WHERE chat_number = ?').get(chat_number);
  if (!user) return res.status(404).json({ error: 'User not found' });

  try {
    db.prepare('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)').run(convId, user.id, 'member');
    res.json({ message: 'Member added', user });
  } catch (e) {
    res.status(400).json({ error: 'User is already a member' });
  }
});

// Remove member from group - admin only
router.delete('/conversations/:id/members/:userId', authenticateToken, (req, res) => {
  const convId = req.params.id;
  const targetId = parseInt(req.params.userId);

  const member = db.prepare('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(convId, req.user.id);
  if (!member || member.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can remove members' });
  }

  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'Cannot remove yourself' });
  }

  db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(convId, targetId);
  res.json({ message: 'Member removed' });
});

// Get group members
router.get('/conversations/:id/members', authenticateToken, (req, res) => {
  const convId = req.params.id;
  const members = db.prepare(`
    SELECT u.id, u.username, u.chat_number, u.avatar, u.status, u.last_seen, cm.role
    FROM conversation_members cm
    JOIN users u ON cm.user_id = u.id
    WHERE cm.conversation_id = ?
    ORDER BY cm.role DESC, u.username ASC
  `).all(convId);
  res.json({ members });
});

// Get all conversations for current user
router.get('/conversations', authenticateToken, (req, res) => {
  const conversations = db.prepare(`
    SELECT c.*, 
      CASE 
        WHEN c.type = 'private' THEN (
          SELECT u.username FROM users u 
          JOIN conversation_members cm ON u.id = cm.user_id 
          WHERE cm.conversation_id = c.id AND u.id != ?
        )
        ELSE c.name
      END as display_name,
      CASE 
        WHEN c.type = 'private' THEN (
          SELECT u.avatar FROM users u 
          JOIN conversation_members cm ON u.id = cm.user_id 
          WHERE cm.conversation_id = c.id AND u.id != ?
        )
        ELSE c.group_avatar
      END as display_avatar,
      CASE 
        WHEN c.type = 'private' THEN (
          SELECT u.chat_number FROM users u 
          JOIN conversation_members cm ON u.id = cm.user_id 
          WHERE cm.conversation_id = c.id AND u.id != ?
        )
        ELSE NULL
      END as display_chat_number,
      CASE 
        WHEN c.type = 'private' THEN (
          SELECT u.id FROM users u 
          JOIN conversation_members cm ON u.id = cm.user_id 
          WHERE cm.conversation_id = c.id AND u.id != ?
        )
        ELSE NULL
      END as display_user_id,
      CASE 
        WHEN c.type = 'private' THEN (
          SELECT u.status FROM users u 
          JOIN conversation_members cm ON u.id = cm.user_id 
          WHERE cm.conversation_id = c.id AND u.id != ?
        )
        ELSE NULL
      END as display_status,
      CASE 
        WHEN c.type = 'private' THEN (
          SELECT u.last_seen FROM users u 
          JOIN conversation_members cm ON u.id = cm.user_id 
          WHERE cm.conversation_id = c.id AND u.id != ?
        )
        ELSE NULL
      END as display_last_seen,
      (SELECT content FROM messages WHERE conversation_id = c.id AND deleted = 0 ORDER BY created_at DESC LIMIT 1) as last_message,
      (SELECT type FROM messages WHERE conversation_id = c.id AND deleted = 0 ORDER BY created_at DESC LIMIT 1) as last_message_type,
      (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_time,
      (SELECT COUNT(*) FROM messages m 
       WHERE m.conversation_id = c.id 
       AND m.sender_id != ?
       AND m.deleted = 0
       AND m.id NOT IN (SELECT message_id FROM read_receipts WHERE user_id = ?)) as unread_count,
      (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) as member_count
    FROM conversations c
    JOIN conversation_members cm ON c.id = cm.conversation_id
    WHERE cm.user_id = ?
    ORDER BY last_message_time DESC
  `).all(req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id);

  res.json({ conversations });
});

// Get messages for a conversation
router.get('/conversations/:id/messages', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { limit = 50, before } = req.query;

  const member = db.prepare('SELECT id FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(id, req.user.id);
  if (!member) {
    return res.status(403).json({ error: 'Not a member of this conversation' });
  }

  let query = `
    SELECT m.*, u.username as sender_name, u.avatar as sender_avatar, u.chat_number as sender_chat_number,
      rm.content as reply_content, rm.sender_id as reply_sender_id, ru.username as reply_sender_name
    FROM messages m
    JOIN users u ON m.sender_id = u.id
    LEFT JOIN messages rm ON m.reply_to = rm.id
    LEFT JOIN users ru ON rm.sender_id = ru.id
    WHERE m.conversation_id = ?
  `;
  const params = [id];

  if (before) {
    query += ' AND m.id < ?';
    params.push(before);
  }

  query += ' ORDER BY m.created_at DESC LIMIT ?';
  params.push(parseInt(limit));

  const messages = db.prepare(query).all(...params).reverse();

  // Get reactions for messages
  const messageIds = messages.map(m => m.id);
  let reactions = [];
  if (messageIds.length > 0) {
    reactions = db.prepare(`
      SELECT r.message_id, r.emoji, r.user_id, u.username 
      FROM reactions r
      JOIN users u ON r.user_id = u.id
      WHERE r.message_id IN (${messageIds.join(',')})
    `).all();
  }

  // Get read receipts
  let receipts = [];
  if (messageIds.length > 0) {
    receipts = db.prepare(`
      SELECT rr.message_id, rr.user_id, u.username, rr.read_at FROM read_receipts rr
      JOIN users u ON rr.user_id = u.id
      WHERE rr.message_id IN (${messageIds.join(',')})
    `).all();
  }

  res.json({ messages, reactions, receipts });
});

// Edit message
router.put('/messages/:id', authenticateToken, (req, res) => {
  const { content } = req.body;
  const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND sender_id = ?').get(req.params.id, req.user.id);
  if (!msg) return res.status(404).json({ error: 'Message not found or not yours' });
  if (msg.type !== 'text') return res.status(400).json({ error: 'Can only edit text messages' });
  
  db.prepare('UPDATE messages SET content = ?, edited = 1 WHERE id = ?').run(content, req.params.id);
  res.json({ message: 'Message updated', id: msg.id, content, edited: 1, conversation_id: msg.conversation_id });
});

// Forward message
router.post('/messages/:id/forward', authenticateToken, (req, res) => {
  const { conversation_ids } = req.body;
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });

  const forwarded = [];
  for (const convId of conversation_ids) {
    const member = db.prepare('SELECT id FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(convId, req.user.id);
    if (!member) continue;

    const result = db.prepare(
      'INSERT INTO messages (conversation_id, sender_id, content, type, file_url, file_name, forwarded_from) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(convId, req.user.id, msg.content, msg.type, msg.file_url, msg.file_name, msg.id);
    forwarded.push({ conversation_id: convId, message_id: result.lastInsertRowid });
  }

  res.json({ forwarded });
});

// Get message info (read by)
router.get('/messages/:id/info', authenticateToken, (req, res) => {
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });

  const readBy = db.prepare(`
    SELECT u.username, u.avatar, rr.read_at 
    FROM read_receipts rr
    JOIN users u ON rr.user_id = u.id
    WHERE rr.message_id = ?
  `).all(req.params.id);

  res.json({ message: msg, read_by: readBy });
});

// Search messages
router.get('/messages/search', authenticateToken, (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ messages: [] });

  const messages = db.prepare(`
    SELECT m.*, u.username as sender_name, c.name as conv_name,
      CASE WHEN c.type = 'private' THEN (
        SELECT u2.username FROM users u2
        JOIN conversation_members cm2 ON u2.id = cm2.user_id
        WHERE cm2.conversation_id = c.id AND u2.id != ?
      ) ELSE c.name END as display_conv_name
    FROM messages m
    JOIN users u ON m.sender_id = u.id
    JOIN conversations c ON m.conversation_id = c.id
    JOIN conversation_members cm ON c.id = cm.conversation_id
    WHERE cm.user_id = ? AND m.content LIKE ? AND m.deleted = 0
    ORDER BY m.created_at DESC
    LIMIT 30
  `).all(req.user.id, req.user.id, `%${q}%`);

  res.json({ messages });
});

// Delete message
router.delete('/messages/:id', authenticateToken, (req, res) => {
  const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND sender_id = ?').get(req.params.id, req.user.id);
  if (!msg) return res.status(404).json({ error: 'Message not found or not yours' });

  db.prepare('UPDATE messages SET deleted = 1, content = NULL, file_url = NULL, file_name = NULL WHERE id = ?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Upload file
router.post('/upload', authenticateToken, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: '/uploads/' + req.file.filename, name: req.file.originalname });
});

// Upload voice
router.post('/upload/voice', authenticateToken, uploadVoice.single('voice'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: '/uploads/voice/' + req.file.filename, name: req.file.filename });
});

// Get pinned messages
router.get('/conversations/:id/pinned', authenticateToken, (req, res) => {
  const pinned = db.prepare(`
    SELECT pm.*, m.content, m.type, m.file_url, u.username as sender_name, pu.username as pinned_by_name
    FROM pinned_messages pm
    JOIN messages m ON pm.message_id = m.id
    JOIN users u ON m.sender_id = u.id
    JOIN users pu ON pm.pinned_by = pu.id
    WHERE pm.conversation_id = ?
    ORDER BY pm.created_at DESC
  `).all(req.params.id);
  res.json({ pinned });
});

// Block user
router.post('/block', authenticateToken, (req, res) => {
  const { chat_number } = req.body;
  const user = db.prepare('SELECT id, username FROM users WHERE chat_number = ?').get(chat_number);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'Cannot block yourself' });

  try {
    db.prepare('INSERT INTO blocked_users (blocker_id, blocked_id) VALUES (?, ?)').run(req.user.id, user.id);
    res.json({ message: 'User blocked', user: { id: user.id, username: user.username } });
  } catch (e) {
    res.status(400).json({ error: 'Already blocked' });
  }
});

// Unblock user
router.delete('/block/:userId', authenticateToken, (req, res) => {
  db.prepare('DELETE FROM blocked_users WHERE blocker_id = ? AND blocked_id = ?').run(req.user.id, req.params.userId);
  res.json({ message: 'Unblocked' });
});

// Get blocked users
router.get('/blocked', authenticateToken, (req, res) => {
  const blocked = db.prepare(`
    SELECT u.id, u.username, u.chat_number, u.avatar
    FROM blocked_users bu
    JOIN users u ON bu.blocked_id = u.id
    WHERE bu.blocker_id = ?
  `).all(req.user.id);
  res.json({ blocked });
});

module.exports = router;
