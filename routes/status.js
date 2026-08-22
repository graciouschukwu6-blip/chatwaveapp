const express = require('express');
const multer = require('multer');
const path = require('path');
const { query } = require('../database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Status media upload
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
    if (allowed.test(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Only image and video files are allowed'));
  }
});

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
router.post('/', authenticateToken, uploadStatus.single('media'), async (req, res) => {
  try {
    const { type, content, mentions, bg_gradient } = req.body;
    if (!type || !['text', 'image', 'video'].includes(type)) {
      return res.status(400).json({ error: 'Invalid status type' });
    }
    if (type === 'text' && !content) return res.status(400).json({ error: 'Text content required' });
    if ((type === 'image' || type === 'video') && !req.file) return res.status(400).json({ error: 'Media file required' });

    const mediaUrl = req.file ? '/uploads/status/' + req.file.filename : null;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const mentionsJson = mentions || '[]';
    const gradient = type === 'text' ? (bg_gradient || GRADIENTS[Math.floor(Math.random() * GRADIENTS.length)]) : null;

    const result = await query(
      'INSERT INTO statuses (user_id, type, content, media_url, mentions, bg_gradient, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [req.user.id, type, content || null, mediaUrl, mentionsJson, gradient, expiresAt]
    );

    res.status(201).json({
      id: result.rows[0].id, type, content: content || null,
      media_url: mediaUrl, mentions: mentionsJson, bg_gradient: gradient, expires_at: expiresAt
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get status feed
router.get('/feed', authenticateToken, async (req, res) => {
  try {
    const result = await query(`
      SELECT s.*, u.username, u.avatar, u.chat_number,
        (SELECT COUNT(*) FROM status_views sv WHERE sv.status_id = s.id) as view_count,
        (SELECT COUNT(*) FROM status_views sv WHERE sv.status_id = s.id AND sv.viewer_id = $1) as viewed_by_me
      FROM statuses s
      JOIN users u ON s.user_id = u.id
      WHERE s.user_id != $1
        AND s.expires_at > NOW()
        AND s.user_id IN (
          SELECT DISTINCT cm2.user_id FROM conversation_members cm1
          JOIN conversation_members cm2 ON cm1.conversation_id = cm2.conversation_id
          WHERE cm1.user_id = $1 AND cm2.user_id != $1
        )
      ORDER BY s.created_at DESC
    `, [req.user.id]);

    // Group by user
    const grouped = {};
    result.rows.forEach(s => {
      if (!grouped[s.user_id]) {
        grouped[s.user_id] = {
          user_id: s.user_id, username: s.username, avatar: s.avatar,
          chat_number: s.chat_number, statuses: [], has_unviewed: false
        };
      }
      grouped[s.user_id].statuses.push(s);
      if (parseInt(s.viewed_by_me) === 0) grouped[s.user_id].has_unviewed = true;
    });

    const feed = Object.values(grouped).sort((a, b) => {
      if (a.has_unviewed && !b.has_unviewed) return -1;
      if (!a.has_unviewed && b.has_unviewed) return 1;
      return new Date(b.statuses[0].created_at) - new Date(a.statuses[0].created_at);
    });

    res.json({ feed });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get my statuses
router.get('/mine', authenticateToken, async (req, res) => {
  try {
    const result = await query(`
      SELECT s.*, (SELECT COUNT(*) FROM status_views sv WHERE sv.status_id = s.id) as view_count
      FROM statuses s WHERE s.user_id = $1 AND s.expires_at > NOW()
      ORDER BY s.created_at DESC
    `, [req.user.id]);
    res.json({ statuses: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get viewers
router.get('/:id/views', authenticateToken, async (req, res) => {
  try {
    const statusCheck = await query('SELECT * FROM statuses WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (statusCheck.rows.length === 0) return res.status(404).json({ error: 'Status not found' });
    const result = await query(`
      SELECT u.id, u.username, u.avatar, u.chat_number, sv.viewed_at
      FROM status_views sv JOIN users u ON sv.viewer_id = u.id
      WHERE sv.status_id = $1 ORDER BY sv.viewed_at DESC
    `, [req.params.id]);
    res.json({ viewers: result.rows, count: result.rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mark as viewed
router.post('/:id/view', authenticateToken, async (req, res) => {
  try {
    const statusCheck = await query('SELECT * FROM statuses WHERE id = $1', [req.params.id]);
    if (statusCheck.rows.length === 0) return res.status(404).json({ error: 'Status not found' });
    if (statusCheck.rows[0].user_id === req.user.id) return res.json({ message: 'Own status' });
    await query('INSERT INTO status_views (status_id, viewer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, req.user.id]);
    res.json({ message: 'Viewed' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete status
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const statusCheck = await query('SELECT * FROM statuses WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (statusCheck.rows.length === 0) return res.status(404).json({ error: 'Status not found' });
    await query('DELETE FROM status_views WHERE status_id = $1', [req.params.id]);
    await query('DELETE FROM statuses WHERE id = $1', [req.params.id]);
    res.json({ message: 'Status deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
