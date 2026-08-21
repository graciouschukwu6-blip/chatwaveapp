const express = require('express');
const multer = require('multer');
const path = require('path');
const db = require('../database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Status media upload config
const statusStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../public/uploads/status')),
  filename: (req, file, cb) => {
    const uniqueName = 'status_' + Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});
const uploadStatus = multer({
  storage: statusStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|mp4|webm|mov/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    if (ext) cb(null, true);
    else cb(new Error('Only image and video files are allowed'));
  }
});

// Gradient presets for text statuses
const GRADIENTS = [
  'linear-gradient(135deg, #667eea, #764ba2)',
  'linear-gradient(135deg, #f093fb, #f5576c)',
  'linear-gradient(135deg, #4facfe, #00f2fe)',
  'linear-gradient(135deg, #43e97b, #38f9d7)',
  'linear-gradient(135deg, #fa709a, #fee140)',
  'linear-gradient(135deg, #a18cd1, #fbc2eb)',
  'linear-gradient(135deg, #fccb90, #d57eeb)',
  'linear-gradient(135deg, #667eea, #f093fb)',
  'linear-gradient(135deg, #ff0844, #ffb199)',
  'linear-gradient(135deg, #96fbc4, #f9f586)'
];

// Create status
router.post('/', authenticateToken, uploadStatus.single('media'), (req, res) => {
  try {
    const { type, content, mentions, bg_gradient } = req.body;

    if (!type || !['text', 'image', 'video'].includes(type)) {
      return res.status(400).json({ error: 'Invalid status type' });
    }

    if (type === 'text' && !content) {
      return res.status(400).json({ error: 'Text content is required for text status' });
    }

    if ((type === 'image' || type === 'video') && !req.file) {
      return res.status(400).json({ error: 'Media file is required' });
    }

    const mediaUrl = req.file ? '/uploads/status/' + req.file.filename : null;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const mentionsJson = mentions || '[]';
    const gradient = type === 'text' ? (bg_gradient || GRADIENTS[Math.floor(Math.random() * GRADIENTS.length)]) : null;

    const result = db.prepare(
      'INSERT INTO statuses (user_id, type, content, media_url, mentions, bg_gradient, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(req.user.id, type, content || null, mediaUrl, mentionsJson, gradient, expiresAt);

    res.status(201).json({
      id: result.lastInsertRowid,
      type,
      content: content || null,
      media_url: mediaUrl,
      mentions: mentionsJson,
      bg_gradient: gradient,
      expires_at: expiresAt
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Get status feed (friends' statuses from last 24h)
router.get('/feed', authenticateToken, (req, res) => {
  try {
    // Friends = users who share at least one conversation with current user
    const friendStatuses = db.prepare(`
      SELECT s.*, u.username, u.avatar, u.chat_number,
        (SELECT COUNT(*) FROM status_views sv WHERE sv.status_id = s.id) as view_count,
        (SELECT COUNT(*) FROM status_views sv WHERE sv.status_id = s.id AND sv.viewer_id = ?) as viewed_by_me
      FROM statuses s
      JOIN users u ON s.user_id = u.id
      WHERE s.user_id != ?
        AND s.expires_at > datetime('now')
        AND s.user_id IN (
          SELECT DISTINCT cm2.user_id FROM conversation_members cm1
          JOIN conversation_members cm2 ON cm1.conversation_id = cm2.conversation_id
          WHERE cm1.user_id = ? AND cm2.user_id != ?
        )
      ORDER BY s.created_at DESC
    `).all(req.user.id, req.user.id, req.user.id, req.user.id);

    // Group by user
    const grouped = {};
    friendStatuses.forEach(s => {
      if (!grouped[s.user_id]) {
        grouped[s.user_id] = {
          user_id: s.user_id,
          username: s.username,
          avatar: s.avatar,
          chat_number: s.chat_number,
          statuses: [],
          has_unviewed: false
        };
      }
      grouped[s.user_id].statuses.push(s);
      if (!s.viewed_by_me) grouped[s.user_id].has_unviewed = true;
    });

    // Sort: unviewed first, then by most recent
    const feed = Object.values(grouped).sort((a, b) => {
      if (a.has_unviewed && !b.has_unviewed) return -1;
      if (!a.has_unviewed && b.has_unviewed) return 1;
      return new Date(b.statuses[0].created_at) - new Date(a.statuses[0].created_at);
    });

    res.json({ feed });
  } catch (err) {
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Get my statuses
router.get('/mine', authenticateToken, (req, res) => {
  try {
    const statuses = db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM status_views sv WHERE sv.status_id = s.id) as view_count
      FROM statuses s
      WHERE s.user_id = ? AND s.expires_at > datetime('now')
      ORDER BY s.created_at DESC
    `).all(req.user.id);

    res.json({ statuses });
  } catch (err) {
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Get viewers for a status
router.get('/:id/views', authenticateToken, (req, res) => {
  try {
    const status = db.prepare('SELECT * FROM statuses WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!status) {
      return res.status(404).json({ error: 'Status not found or not yours' });
    }

    const viewers = db.prepare(`
      SELECT u.id, u.username, u.avatar, u.chat_number, sv.viewed_at
      FROM status_views sv
      JOIN users u ON sv.viewer_id = u.id
      WHERE sv.status_id = ?
      ORDER BY sv.viewed_at DESC
    `).all(req.params.id);

    res.json({ viewers, count: viewers.length });
  } catch (err) {
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Mark status as viewed
router.post('/:id/view', authenticateToken, (req, res) => {
  try {
    const status = db.prepare('SELECT * FROM statuses WHERE id = ?').get(req.params.id);
    if (!status) {
      return res.status(404).json({ error: 'Status not found' });
    }

    // Don't record view for own status
    if (status.user_id === req.user.id) {
      return res.json({ message: 'Own status' });
    }

    db.prepare('INSERT OR IGNORE INTO status_views (status_id, viewer_id) VALUES (?, ?)').run(req.params.id, req.user.id);
    res.json({ message: 'Viewed' });
  } catch (err) {
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Delete status
router.delete('/:id', authenticateToken, (req, res) => {
  try {
    const status = db.prepare('SELECT * FROM statuses WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!status) {
      return res.status(404).json({ error: 'Status not found or not yours' });
    }

    db.prepare('DELETE FROM status_views WHERE status_id = ?').run(req.params.id);
    db.prepare('DELETE FROM statuses WHERE id = ?').run(req.params.id);
    res.json({ message: 'Status deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

module.exports = router;
