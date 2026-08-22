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
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversation_members (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      role TEXT DEFAULT 'member',
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
  `);

  console.log('Database tables initialized');
}

module.exports = { pool, query, initDb };
