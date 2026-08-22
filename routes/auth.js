const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const { query } = require('../database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Avatar upload config
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../public/uploads/avatars')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, 'avatar_' + req.user.id + '_' + Date.now() + ext);
  }
});
const uploadAvatar = multer({ 
  storage: avatarStorage, 
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext && mime) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

// Generate unique 8-digit chat number
async function generateChatNumber() {
  while (true) {
    const num = Math.floor(10000000 + Math.random() * 90000000).toString();
    const result = await query('SELECT id FROM users WHERE chat_number = $1', [num]);
    if (result.rows.length === 0) return num;
  }
}

// Register
router.post('/register', async (req, res) => {
  try {
    const { username, email } = req.body;
    const rawPin = req.body.password;
    
    if (!username || !email || !rawPin) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    if (rawPin.length < 6) {
      return res.status(400).json({ error: 'Must be at least 6 characters' });
    }

    const existing = await query('SELECT id FROM users WHERE username = $1 OR email = $2', [username, email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Username or email already taken' });
    }

    const hashed = await bcrypt.hash(rawPin, 12);
    const chatNumber = await generateChatNumber();

    const result = await query(
      'INSERT INTO users (username, email, pw_hash, chat_number) VALUES ($1, $2, $3, $4) RETURNING id',
      [username, email, hashed, chatNumber]
    );

    const userId = result.rows[0].id;
    const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.status(201).json({ 
      message: 'Account created successfully',
      user: { id: userId, username, email, chat_number: chatNumber, avatar: null, bio: '', status_message: '' },
      token 
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { login } = req.body;
    const rawPin = req.body.password;
    
    if (!login || !rawPin) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const result = await query(
      'SELECT * FROM users WHERE username = $1 OR email = $2 OR chat_number = $3',
      [login, login, login]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(rawPin, user.pw_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if two-step verification is enabled
    if (user.two_step_pin) {
      // Don't issue token yet — require PIN verification
      const tempToken = jwt.sign({ userId: user.id, twoStep: true }, process.env.JWT_SECRET, { expiresIn: '5m' });
      return res.json({ requires_pin: true, temp_token: tempToken });
    }

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ 
      message: 'Login successful',
      user: { id: user.id, username: user.username, email: user.email, chat_number: user.chat_number, avatar: user.avatar, bio: user.bio || '', status_message: user.status_message || '' },
      token 
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Logout
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Logged out successfully' });
});

// Get current user
router.get('/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// Update profile
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const { username, bio, status_message } = req.body;
    
    if (username && username !== req.user.username) {
      const exists = await query('SELECT id FROM users WHERE username = $1 AND id != $2', [username, req.user.id]);
      if (exists.rows.length > 0) {
        return res.status(400).json({ error: 'Username already taken' });
      }
      await query('UPDATE users SET username = $1 WHERE id = $2', [username, req.user.id]);
    }
    
    if (bio !== undefined) {
      await query('UPDATE users SET bio = $1 WHERE id = $2', [bio.substring(0, 200), req.user.id]);
    }
    
    if (status_message !== undefined) {
      await query('UPDATE users SET status_message = $1 WHERE id = $2', [status_message.substring(0, 100), req.user.id]);
    }
    
    const updated = await query('SELECT id, username, email, chat_number, avatar, bio, status_message FROM users WHERE id = $1', [req.user.id]);
    res.json({ user: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Upload avatar
router.post('/avatar', authenticateToken, uploadAvatar.single('avatar'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  const avatarUrl = '/uploads/avatars/' + req.file.filename;
  await query('UPDATE users SET avatar = $1 WHERE id = $2', [avatarUrl, req.user.id]);
  res.json({ avatar: avatarUrl });
});

// Get user profile by id
router.get('/users/:id', authenticateToken, async (req, res) => {
  const result = await query('SELECT id, username, chat_number, avatar, bio, status_message, status, last_seen, created_at FROM users WHERE id = $1', [req.params.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ user: result.rows[0] });
});

// ===== TWO-STEP VERIFICATION =====

// Verify PIN during login
router.post('/two-step/verify', async (req, res) => {
  try {
    const { pin, temp_token } = req.body;
    if (!pin || !temp_token) return res.status(400).json({ error: 'PIN and token required' });

    let decoded;
    try {
      decoded = jwt.verify(temp_token, process.env.JWT_SECRET);
    } catch(e) {
      return res.status(401).json({ error: 'Session expired. Please login again.' });
    }

    if (!decoded.twoStep) return res.status(400).json({ error: 'Invalid token' });

    const result = await query('SELECT id, username, email, chat_number, avatar, bio, status_message, two_step_pin FROM users WHERE id = $1', [decoded.userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const user = result.rows[0];
    const pinMatch = await bcrypt.compare(pin, user.two_step_pin);
    if (!pinMatch) return res.status(401).json({ error: 'Incorrect PIN' });

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({
      message: 'Login successful',
      user: { id: user.id, username: user.username, email: user.email, chat_number: user.chat_number, avatar: user.avatar, bio: user.bio || '', status_message: user.status_message || '' },
      token
    });
  } catch(err) {
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Enable two-step verification
router.post('/two-step/enable', authenticateToken, async (req, res) => {
  try {
    const { pin, email } = req.body;
    if (!pin || pin.length !== 6 || !/^\d{6}$/.test(pin)) {
      return res.status(400).json({ error: 'PIN must be exactly 6 digits' });
    }

    const hashedPin = await bcrypt.hash(pin, 12);
    await query('UPDATE users SET two_step_pin = $1, two_step_email = $2 WHERE id = $3', [hashedPin, email || null, req.user.id]);
    res.json({ message: 'Two-step verification enabled', enabled: true });
  } catch(err) {
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Disable two-step verification
router.post('/two-step/disable', authenticateToken, async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin) return res.status(400).json({ error: 'Current PIN required' });

    const result = await query('SELECT two_step_pin FROM users WHERE id = $1', [req.user.id]);
    if (!result.rows[0].two_step_pin) return res.status(400).json({ error: 'Two-step not enabled' });

    const match = await bcrypt.compare(pin, result.rows[0].two_step_pin);
    if (!match) return res.status(401).json({ error: 'Incorrect PIN' });

    await query('UPDATE users SET two_step_pin = NULL, two_step_email = NULL WHERE id = $1', [req.user.id]);
    res.json({ message: 'Two-step verification disabled', enabled: false });
  } catch(err) {
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Get two-step status
router.get('/two-step/status', authenticateToken, async (req, res) => {
  const result = await query('SELECT two_step_pin, two_step_email FROM users WHERE id = $1', [req.user.id]);
  const user = result.rows[0];
  res.json({ enabled: !!user.two_step_pin, email: user.two_step_email || '' });
});

module.exports = router;
