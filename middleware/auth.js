const jwt = require('jsonwebtoken');
const { query } = require('../database');

async function authenticateToken(req, res, next) {
  const token = req.cookies?.token || req.headers['authorization']?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await query('SELECT id, username, email, chat_number, avatar, bio, status_message, status FROM users WHERE id = $1', [decoded.userId]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid token. User not found.' });
    }
    
    req.user = result.rows[0];
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token.' });
  }
}

async function authenticateSocket(socket, next) {
  const token = socket.handshake.auth?.token || socket.handshake.headers?.cookie?.split('token=')[1]?.split(';')[0];
  
  if (!token) {
    return next(new Error('Authentication error'));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await query('SELECT id, username, email, chat_number, avatar, bio, status_message FROM users WHERE id = $1', [decoded.userId]);
    
    if (result.rows.length === 0) {
      return next(new Error('User not found'));
    }
    
    socket.user = result.rows[0];
    next();
  } catch (err) {
    return next(new Error('Invalid token'));
  }
}

module.exports = { authenticateToken, authenticateSocket };
