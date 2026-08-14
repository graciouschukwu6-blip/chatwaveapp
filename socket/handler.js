const db = require('../database');

const onlineUsers = new Map();

function setupSocket(io) {
  io.on('connection', (socket) => {
    const user = socket.user;
    console.log(user.username + ' connected (Chat#: ' + user.chat_number + ')');

    // Mark user online
    onlineUsers.set(user.id, socket.id);
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run('online', user.id);
    io.emit('user_status', { userId: user.id, status: 'online', last_seen: null });

    // Join rooms
    const conversations = db.prepare(
      'SELECT conversation_id FROM conversation_members WHERE user_id = ?'
    ).all(user.id);
    conversations.forEach(c => socket.join('conv_' + c.conversation_id));

    // Send message
    socket.on('send_message', (data) => {
      const { conversation_id, content, type = 'text', file_url, file_name, reply_to } = data;

      const member = db.prepare(
        'SELECT id FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
      ).get(conversation_id, user.id);
      if (!member) return;

      // Check if blocked (for private convos)
      const conv = db.prepare('SELECT type FROM conversations WHERE id = ?').get(conversation_id);
      if (conv && conv.type === 'private') {
        const otherMember = db.prepare(
          'SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?'
        ).get(conversation_id, user.id);
        if (otherMember) {
          const blocked = db.prepare(
            'SELECT id FROM blocked_users WHERE blocker_id = ? AND blocked_id = ?'
          ).get(otherMember.user_id, user.id);
          if (blocked) {
            socket.emit('error_message', { error: 'You have been blocked by this user' });
            return;
          }
        }
      }

      const result = db.prepare(
        'INSERT INTO messages (conversation_id, sender_id, content, type, file_url, file_name, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(conversation_id, user.id, content, type, file_url || null, file_name || null, reply_to || null);

      // Get reply info if replying
      let replyData = null;
      if (reply_to) {
        const replyMsg = db.prepare('SELECT m.content, u.username as sender_name FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.id = ?').get(reply_to);
        if (replyMsg) {
          replyData = { id: reply_to, content: replyMsg.content, sender_name: replyMsg.sender_name };
        }
      }

      const message = {
        id: result.lastInsertRowid,
        conversation_id,
        sender_id: user.id,
        sender_name: user.username,
        sender_avatar: user.avatar,
        sender_chat_number: user.chat_number,
        content,
        type,
        file_url,
        file_name,
        reply_to,
        reply_content: replyData ? replyData.content : null,
        reply_sender_name: replyData ? replyData.sender_name : null,
        deleted: 0,
        created_at: new Date().toISOString()
      };

      io.to('conv_' + conversation_id).emit('new_message', message);
    });

    // Typing
    socket.on('typing', (data) => {
      socket.to('conv_' + data.conversation_id).emit('user_typing', {
        userId: user.id,
        username: user.username,
        conversation_id: data.conversation_id
      });
    });

    socket.on('stop_typing', (data) => {
      socket.to('conv_' + data.conversation_id).emit('user_stop_typing', {
        userId: user.id,
        conversation_id: data.conversation_id
      });
    });

    // Read receipts
    socket.on('mark_read', (data) => {
      const { conversation_id, message_ids } = data;
      for (const msgId of message_ids) {
        db.prepare('INSERT OR IGNORE INTO read_receipts (message_id, user_id) VALUES (?, ?)').run(msgId, user.id);
      }
      socket.to('conv_' + conversation_id).emit('messages_read', {
        userId: user.id,
        username: user.username,
        conversation_id,
        message_ids
      });
    });

    // Reactions
    socket.on('add_reaction', (data) => {
      const { message_id, conversation_id, emoji } = data;
      try {
        db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(message_id, user.id, emoji);
        io.to('conv_' + conversation_id).emit('reaction_added', {
          message_id,
          user_id: user.id,
          username: user.username,
          emoji
        });
      } catch (err) {}
    });

    socket.on('remove_reaction', (data) => {
      const { message_id, conversation_id, emoji } = data;
      db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(message_id, user.id, emoji);
      io.to('conv_' + conversation_id).emit('reaction_removed', {
        message_id,
        user_id: user.id,
        emoji
      });
    });

    // Delete message
    socket.on('delete_message', (data) => {
      const { message_id, conversation_id } = data;
      const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND sender_id = ?').get(message_id, user.id);
      if (!msg) return;
      db.prepare('UPDATE messages SET deleted = 1, content = NULL, file_url = NULL, file_name = NULL WHERE id = ?').run(message_id);
      io.to('conv_' + conversation_id).emit('message_deleted', { message_id, conversation_id });
    });

    // Pin message
    socket.on('pin_message', (data) => {
      const { message_id, conversation_id } = data;
      try {
        db.prepare('INSERT OR IGNORE INTO pinned_messages (message_id, conversation_id, pinned_by) VALUES (?, ?, ?)').run(message_id, conversation_id, user.id);
        const msg = db.prepare('SELECT m.content, u.username as sender_name FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.id = ?').get(message_id);
        io.to('conv_' + conversation_id).emit('message_pinned', {
          message_id,
          conversation_id,
          pinned_by: user.username,
          content: msg ? msg.content : '',
          sender_name: msg ? msg.sender_name : ''
        });
      } catch (err) {}
    });

    socket.on('unpin_message', (data) => {
      const { message_id, conversation_id } = data;
      db.prepare('DELETE FROM pinned_messages WHERE message_id = ?').run(message_id);
      io.to('conv_' + conversation_id).emit('message_unpinned', { message_id, conversation_id });
    });

    // Join conversation
    socket.on('join_conversation', (data) => {
      socket.join('conv_' + data.conversation_id);
    });

    // Disconnect
    socket.on('disconnect', () => {
      onlineUsers.delete(user.id);
      const now = new Date().toISOString();
      db.prepare('UPDATE users SET status = ?, last_seen = ? WHERE id = ?').run('offline', now, user.id);
      io.emit('user_status', { userId: user.id, status: 'offline', last_seen: now });
      console.log(user.username + ' disconnected');
    });
  });
}

module.exports = { setupSocket, onlineUsers };
