const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const db = require('../database');
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
function generateChatNumber() {
  while (true) {
    const num = Math.floor(10000000 + Math.random() * 90000000).toString();
    const exists = db.prepare('SELECT id FROM users WHERE chat_number = ?').get(num);
    if (!exists) return num;
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
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existingUser = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
    if (existingUser) {
      return res.status(400).json({ error: 'Username or email already taken' });
    }

    const hashed = await bcrypt.hash(rawPin, 12);
    const chatNumber = generateChatNumber();

    const result = db.prepare(
      'INSERT INTO users (username, email, password, chat_number) VALUES (?, ?, ?, ?)'
    ).run(username, email, hashed, chatNumber);

    const token = jwt.sign({ userId: result.lastInsertRowid }, process.env.JWT_SECRET, {
      expiresIn: '7d'
    });

    res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.status(201).json({ 
      message: 'Account created successfully',
      user: { id: result.lastInsertRowid, username, email, chat_number: chatNumber, avatar: null, bio: '', status_message: '' },
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

    const user = db.prepare(
      'SELECT * FROM users WHERE username = ? OR email = ? OR chat_number = ?'
    ).get(login, login, login);

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(rawPin, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
      expiresIn: '7d'
    });

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
router.put('/profile', authenticateToken, (req, res) => {
  const { username, bio, status_message } = req.body;
  
  if (username && username !== req.user.username) {
    const exists = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, req.user.id);
    if (exists) {
      return res.status(400).json({ error: 'Username already taken' });
    }
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, req.user.id);
  }
  
  if (bio !== undefined) {
    db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(bio.substring(0, 200), req.user.id);
  }
  
  if (status_message !== undefined) {
    db.prepare('UPDATE users SET status_message = ? WHERE id = ?').run(status_message.substring(0, 100), req.user.id);
  }
  
  const updated = db.prepare('SELECT id, username, email, chat_number, avatar, bio, status_message FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: updated });
});

// Upload avatar
router.post('/avatar', authenticateToken, uploadAvatar.single('avatar'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  const avatarUrl = '/uploads/avatars/' + req.file.filename;
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, req.user.id);
  res.json({ avatar: avatarUrl });
});

// Get user profile by id
router.get('/users/:id', authenticateToken, (req, res) => {
  const user = db.prepare('SELECT id, username, chat_number, avatar, bio, status_message, status, last_seen, created_at FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

module.exports = router;
