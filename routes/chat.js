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
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// Voice note upload
const voiceStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../public/uploads/voice')),
  filename: (req, file, cb) => {
    cb(null, 'voice_' + Date.now() + '-' + Math.round(Math.random() * 1E9) + '.webm');
  }
});
const uploadVoice = multer({ storage: voiceStorage, limits: { fileSize: 10 * 1024 * 1024 } });

// Search user by chat number or username
router.get('/users/search', authenticateToken, (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ users: [] });

  const users = db.prepare(
    `SELECT id, username, chat_number, avatar, status, last_seen 
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

  // Check if blocked
  const blocked = db.prepare(
    'SELECT id FROM blocked_users WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)'
  ).get(req.user.id, otherUser.id, otherUser.id, req.user.id);
  if (blocked) {
    return res.status(403).json({ error: 'Cannot message this user' });
  }

  // Check if private conversation already exists
  const existing = db.prepare(`
    SELECT c.id FROM conversations c
    JOIN conversation_members cm1 ON c.id = cm1.conversation_id AND cm1.user_id = ?
    JOIN conversation_members cm2 ON c.id = cm2.conversation_id AND cm2.user_id = ?
    WHERE c.type = 'private'
  `).get(req.user.id, otherUser.id);

  if (existing) {
    return res.json({ conversation_id: existing.id, user: otherUser });
  }

  // Create new conversation
  const conv = db.prepare('INSERT INTO conversations (type, created_by) VALUES (?, ?)').run('private', req.user.id);
  db.prepare('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)').run(conv.lastInsertRowid, req.user.id);
  db.prepare('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)').run(conv.lastInsertRowid, otherUser.id);

  res.status(201).json({ conversation_id: conv.lastInsertRowid, user: otherUser });
});

// Create group conversation
router.post('/conversations/group', authenticateToken, (req, res) => {
  const { name, members } = req.body;
  
  if (!name || !members || members.length < 1) {
    return res.status(400).json({ error: 'Group name and at least 1 other member required' });
  }

  const conv = db.prepare('INSERT INTO conversations (type, name, created_by) VALUES (?, ?, ?)').run('group', name, req.user.id);
  
  db.prepare('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)').run(conv.lastInsertRowid, req.user.id);
  
  for (const chatNum of members) {
    const user = db.prepare('SELECT id FROM users WHERE chat_number = ?').get(chatNum);
    if (user) {
      db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id) VALUES (?, ?)').run(conv.lastInsertRowid, user.id);
    }
  }

  res.status(201).json({ conversation_id: conv.lastInsertRowid, name });
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
        ELSE NULL
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
       AND m.id NOT IN (SELECT message_id FROM read_receipts WHERE user_id = ?)) as unread_count
    FROM conversations c
    JOIN conversation_members cm ON c.id = cm.conversation_id
    WHERE cm.user_id = ?
    ORDER BY last_message_time DESC
  `).all(req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id);

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
      SELECT rr.message_id, rr.user_id, u.username FROM read_receipts rr
      JOIN users u ON rr.user_id = u.id
      WHERE rr.message_id IN (${messageIds.join(',')})
    `).all();
  }

  res.json({ messages, reactions, receipts });
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
  res.json({ success: true });
});

// Add reaction
router.post('/messages/:id/reactions', authenticateToken, (req, res) => {
  const { emoji } = req.body;
  if (!emoji) return res.status(400).json({ error: 'Emoji required' });

  try {
    db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(req.params.id, req.user.id, emoji);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove reaction
router.delete('/messages/:id/reactions', authenticateToken, (req, res) => {
  const { emoji } = req.body;
  db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(req.params.id, req.user.id, emoji);
  res.json({ success: true });
});

// Block user
router.post('/users/block', authenticateToken, (req, res) => {
  const { chat_number } = req.body;
  const user = db.prepare('SELECT id FROM users WHERE chat_number = ?').get(chat_number);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'Cannot block yourself' });

  db.prepare('INSERT OR IGNORE INTO blocked_users (blocker_id, blocked_id) VALUES (?, ?)').run(req.user.id, user.id);
  res.json({ success: true, message: 'User blocked' });
});

// Unblock user
router.post('/users/unblock', authenticateToken, (req, res) => {
  const { chat_number } = req.body;
  const user = db.prepare('SELECT id FROM users WHERE chat_number = ?').get(chat_number);
  if (!user) return res.status(404).json({ error: 'User not found' });

  db.prepare('DELETE FROM blocked_users WHERE blocker_id = ? AND blocked_id = ?').run(req.user.id, user.id);
  res.json({ success: true, message: 'User unblocked' });
});

// Get blocked users
router.get('/users/blocked', authenticateToken, (req, res) => {
  const blocked = db.prepare(`
    SELECT u.id, u.username, u.chat_number, u.avatar 
    FROM users u 
    JOIN blocked_users b ON u.id = b.blocked_id 
    WHERE b.blocker_id = ?
  `).all(req.user.id);
  res.json({ blocked });
});

// Pin message
router.post('/messages/:id/pin', authenticateToken, (req, res) => {
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });

  const member = db.prepare('SELECT id FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(msg.conversation_id, req.user.id);
  if (!member) return res.status(403).json({ error: 'Not a member' });

  try {
    db.prepare('INSERT OR IGNORE INTO pinned_messages (message_id, conversation_id, pinned_by) VALUES (?, ?, ?)').run(msg.id, msg.conversation_id, req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unpin message
router.delete('/messages/:id/pin', authenticateToken, (req, res) => {
  db.prepare('DELETE FROM pinned_messages WHERE message_id = ?').run(req.params.id);
  res.json({ success: true });
});

// Get pinned messages for a conversation
router.get('/conversations/:id/pinned', authenticateToken, (req, res) => {
  const pinned = db.prepare(`
    SELECT m.*, u.username as sender_name, p.created_at as pinned_at
    FROM pinned_messages p
    JOIN messages m ON p.message_id = m.id
    JOIN users u ON m.sender_id = u.id
    WHERE p.conversation_id = ? AND m.deleted = 0
    ORDER BY p.created_at DESC
  `).all(req.params.id);
  res.json({ pinned });
});

// Upload file
router.post('/upload', authenticateToken, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ file_url: '/uploads/' + req.file.filename, file_name: req.file.originalname });
});

// Upload voice note
router.post('/upload/voice', authenticateToken, uploadVoice.single('voice'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ file_url: '/uploads/voice/' + req.file.filename, file_name: req.file.filename });
});

// Get group members
router.get('/conversations/:id/members', authenticateToken, (req, res) => {
  const members = db.prepare(`
    SELECT u.id, u.username, u.chat_number, u.avatar, u.status, u.last_seen
    FROM users u
    JOIN conversation_members cm ON u.id = cm.user_id
    WHERE cm.conversation_id = ?
  `).all(req.params.id);
  res.json({ members });
});

module.exports = router;
