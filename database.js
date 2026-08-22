const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      pw_hash TEXT NOT NULL,
      chat_number TEXT UNIQUE NOT NULL,
      avatar TEXT DEFAULT NULL,
      bio TEXT DEFAULT '',
      status_message TEXT DEFAULT '',
      status TEXT DEFAULT 'offline',
      last_seen TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'private',
      name TEXT DEFAULT NULL,
      group_avatar TEXT DEFAULT NULL,
      locked INTEGER DEFAULT 0,
      disappearing_timer INTEGER DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversation_members (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      role TEXT DEFAULT 'member',
      archived BOOLEAN DEFAULT FALSE,
      muted_until TIMESTAMP DEFAULT NULL,
      joined_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(conversation_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      sender_id INTEGER NOT NULL REFERENCES users(id),
      content TEXT,
      type TEXT DEFAULT 'text',
      file_url TEXT DEFAULT NULL,
      file_name TEXT DEFAULT NULL,
      reply_to INTEGER DEFAULT NULL REFERENCES messages(id),
      edited INTEGER DEFAULT 0,
      deleted INTEGER DEFAULT 0,
      forwarded_from INTEGER DEFAULT NULL,
      view_once INTEGER DEFAULT 0,
      expires_at TIMESTAMP DEFAULT NULL,
      link_preview JSONB DEFAULT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS read_receipts (
      id SERIAL PRIMARY KEY,
      message_id INTEGER NOT NULL REFERENCES messages(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      read_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(message_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS reactions (
      id SERIAL PRIMARY KEY,
      message_id INTEGER NOT NULL REFERENCES messages(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      emoji TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(message_id, user_id, emoji)
    );

    CREATE TABLE IF NOT EXISTS blocked_users (
      id SERIAL PRIMARY KEY,
      blocker_id INTEGER NOT NULL REFERENCES users(id),
      blocked_id INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(blocker_id, blocked_id)
    );

    CREATE TABLE IF NOT EXISTS pinned_messages (
      id SERIAL PRIMARY KEY,
      message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id),
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      pinned_by INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS statuses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      type TEXT NOT NULL DEFAULT 'text',
      content TEXT DEFAULT NULL,
      media_url TEXT DEFAULT NULL,
      mentions TEXT DEFAULT '[]',
      bg_gradient TEXT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      expires_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS status_views (
      id SERIAL PRIMARY KEY,
      status_id INTEGER NOT NULL REFERENCES statuses(id),
      viewer_id INTEGER NOT NULL REFERENCES users(id),
      viewed_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(status_id, viewer_id)
    );

    CREATE TABLE IF NOT EXISTS starred_messages (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      message_id INTEGER NOT NULL REFERENCES messages(id),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS polls (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      creator_id INTEGER NOT NULL REFERENCES users(id),
      question TEXT NOT NULL,
      allow_multiple BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS poll_options (
      id SERIAL PRIMARY KEY,
      poll_id INTEGER NOT NULL REFERENCES polls(id),
      option_text TEXT NOT NULL,
      position INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS poll_votes (
      id SERIAL PRIMARY KEY,
      poll_id INTEGER NOT NULL REFERENCES polls(id),
      option_id INTEGER NOT NULL REFERENCES poll_options(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(poll_id, option_id, user_id)
    );
  `);

  // Add columns if they don't exist (safe migration for existing DBs)
  const migrations = [
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS disappearing_timer INTEGER DEFAULT 0`,
    `ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS muted_until TIMESTAMP DEFAULT NULL`,
    `ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS wallpaper TEXT DEFAULT NULL`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP DEFAULT NULL`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS link_preview JSONB DEFAULT NULL`
  ];

  for (const m of migrations) {
    try { await pool.query(m); } catch(e) { /* column may already exist */ }
  }

  console.log('Database tables initialized');
}

// Cleanup expired disappearing messages
async function cleanupExpiredMessages() {
  try {
    const result = await pool.query('DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at < NOW()');
    if (result.rowCount > 0) console.log(`Cleaned up ${result.rowCount} expired messages`);
  } catch(e) { console.error('Cleanup error:', e.message); }
}

module.exports = { pool, query, initDb, cleanupExpiredMessages };
