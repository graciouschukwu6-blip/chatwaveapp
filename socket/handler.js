const { query } = require('../database');

const onlineUsers = new Map();

// Fetch link preview metadata
async function fetchLinkPreview(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'ChatWaveBot/1.0' }
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const html = await res.text();
    const getMetaContent = (property) => {
      const match = html.match(new RegExp(`<meta[^>]*(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']`, 'i'))
        || html.match(new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${property}["']`, 'i'));
      return match ? match[1] : null;
    };
    const title = getMetaContent('og:title') || getMetaContent('twitter:title') || (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
    const description = getMetaContent('og:description') || getMetaContent('twitter:description') || getMetaContent('description') || '';
    const image = getMetaContent('og:image') || getMetaContent('twitter:image') || '';
    if (!title && !description) return null;
    return { url, title: title.substring(0, 100), description: description.substring(0, 200), image };
  } catch(e) { return null; }
}

function setupSocket(io) {
  io.on('connection', async (socket) => {
    const user = socket.user;
    console.log(user.username + ' connected (Chat#: ' + user.chat_number + ')');

    // Mark user online
    onlineUsers.set(user.id, socket.id);
    await query('UPDATE users SET status = $1 WHERE id = $2', ['online', user.id]);
    io.emit('user_status', { userId: user.id, status: 'online', last_seen: null });

    // Join rooms
    const convResult = await query('SELECT conversation_id FROM conversation_members WHERE user_id = $1', [user.id]);
    convResult.rows.forEach(c => socket.join('conv_' + c.conversation_id));

    // Send message
    socket.on('send_message', async (data) => {
      try {
        const { conversation_id, content, type = 'text', file_url, file_name, reply_to, view_once = 0 } = data;

        const memberCheck = await query('SELECT id FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [conversation_id, user.id]);
        if (memberCheck.rows.length === 0) return;

        const convResult = await query('SELECT type, locked, disappearing_timer FROM conversations WHERE id = $1', [conversation_id]);
        const conv = convResult.rows[0];

        // Check if group is locked
        if (conv && conv.type === 'group' && conv.locked === 1) {
          const roleResult = await query('SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [conversation_id, user.id]);
          if (!roleResult.rows[0] || roleResult.rows[0].role !== 'admin') {
            socket.emit('error_message', { error: 'This group is locked. Only admins can send messages.' });
            return;
          }
        }

        // Check @everyone permission
        if (content && content.includes('@everyone')) {
          const roleResult = await query('SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [conversation_id, user.id]);
          if (!roleResult.rows[0] || roleResult.rows[0].role !== 'admin') {
            socket.emit('error_message', { error: 'Only admins can use @everyone' });
            return;
          }
        }

        // Check if blocked (for private convos)
        if (conv && conv.type === 'private') {
          const otherResult = await query('SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id != $2', [conversation_id, user.id]);
          if (otherResult.rows.length > 0) {
            const blockedResult = await query('SELECT id FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2', [otherResult.rows[0].user_id, user.id]);
            if (blockedResult.rows.length > 0) {
              socket.emit('error_message', { error: 'You have been blocked by this user' });
              return;
            }
          }
        }

        // Calculate expiry for disappearing messages
        let expiresAt = null;
        if (conv && conv.disappearing_timer > 0) {
          expiresAt = new Date(Date.now() + conv.disappearing_timer * 1000).toISOString();
        }

        // Detect URLs for link preview
        let linkPreview = null;
        if (type === 'text' && content) {
          const urlMatch = content.match(/https?:\/\/[^\s<]+/);
          if (urlMatch) {
            linkPreview = await fetchLinkPreview(urlMatch[0]);
          }
        }

        const insertResult = await query(
          'INSERT INTO messages (conversation_id, sender_id, content, type, file_url, file_name, reply_to, view_once, expires_at, link_preview) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id',
          [conversation_id, user.id, content, type, file_url || null, file_name || null, reply_to || null, view_once ? 1 : 0, expiresAt, linkPreview ? JSON.stringify(linkPreview) : null]
        );

        // Get reply info
        let replyData = null;
        if (reply_to) {
          const replyResult = await query('SELECT m.content, u.username as sender_name FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.id = $1', [reply_to]);
          if (replyResult.rows.length > 0) {
            replyData = { id: reply_to, content: replyResult.rows[0].content, sender_name: replyResult.rows[0].sender_name };
          }
        }

        const message = {
          id: insertResult.rows[0].id,
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
          edited: 0,
          forwarded_from: null,
          view_once: view_once ? 1 : 0,
          deleted: 0,
          expires_at: expiresAt,
          link_preview: linkPreview,
          created_at: new Date().toISOString()
        };

        io.to('conv_' + conversation_id).emit('new_message', message);
      } catch (err) { console.error('send_message error:', err); }
    });

    // Edit message
    socket.on('edit_message', async (data) => {
      try {
        const { message_id, conversation_id, content } = data;
        const msgResult = await query('SELECT * FROM messages WHERE id = $1 AND sender_id = $2', [message_id, user.id]);
        if (msgResult.rows.length === 0 || msgResult.rows[0].type !== 'text') return;

        await query('UPDATE messages SET content = $1, edited = 1 WHERE id = $2', [content, message_id]);
        io.to('conv_' + conversation_id).emit('message_edited', { message_id, conversation_id, content, edited: 1 });
      } catch (err) { console.error('edit_message error:', err); }
    });

    // Forward message
    socket.on('forward_message', async (data) => {
      try {
        const { message_id, conversation_ids } = data;
        const msgResult = await query('SELECT * FROM messages WHERE id = $1', [message_id]);
        if (msgResult.rows.length === 0) return;
        const msg = msgResult.rows[0];

        for (const convId of conversation_ids) {
          const memberCheck = await query('SELECT id FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [convId, user.id]);
          if (memberCheck.rows.length === 0) continue;

          const result = await query(
            'INSERT INTO messages (conversation_id, sender_id, content, type, file_url, file_name, forwarded_from) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
            [convId, user.id, msg.content, msg.type, msg.file_url, msg.file_name, msg.id]
          );

          const forwarded = {
            id: result.rows[0].id,
            conversation_id: convId,
            sender_id: user.id,
            sender_name: user.username,
            sender_avatar: user.avatar,
            sender_chat_number: user.chat_number,
            content: msg.content,
            type: msg.type,
            file_url: msg.file_url,
            file_name: msg.file_name,
            forwarded_from: msg.id,
            edited: 0,
            deleted: 0,
            created_at: new Date().toISOString()
          };

          io.to('conv_' + convId).emit('new_message', forwarded);
        }
      } catch (err) { console.error('forward_message error:', err); }
    });

    // Poll vote (real-time update)
    socket.on('poll_vote', (data) => {
      const { conversation_id, poll_id, votes } = data;
      io.to('conv_' + conversation_id).emit('poll_updated', { poll_id, votes });
    });

    // Disappearing timer updated
    socket.on('disappearing_updated', (data) => {
      const { conversation_id, timer, updated_by } = data;
      io.to('conv_' + conversation_id).emit('disappearing_updated', { conversation_id, timer, updated_by });
    });

    // Typing
    socket.on('typing', (data) => {
      socket.to('conv_' + data.conversation_id).emit('user_typing', {
        userId: user.id, username: user.username, conversation_id: data.conversation_id
      });
    });

    socket.on('stop_typing', (data) => {
      socket.to('conv_' + data.conversation_id).emit('user_stop_typing', {
        userId: user.id, conversation_id: data.conversation_id
      });
    });

    // Read receipts
    socket.on('mark_read', async (data) => {
      try {
        const { conversation_id, message_ids } = data;
        for (const msgId of message_ids) {
          await query('INSERT INTO read_receipts (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [msgId, user.id]);
        }
        socket.to('conv_' + conversation_id).emit('messages_read', {
          userId: user.id, username: user.username, conversation_id, message_ids
        });
      } catch (err) {}
    });

    // Reactions
    socket.on('add_reaction', async (data) => {
      try {
        const { message_id, conversation_id, emoji } = data;
        await query('INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [message_id, user.id, emoji]);
        io.to('conv_' + conversation_id).emit('reaction_added', { message_id, user_id: user.id, username: user.username, emoji });
      } catch (err) {}
    });

    socket.on('remove_reaction', async (data) => {
      try {
        const { message_id, conversation_id, emoji } = data;
        await query('DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3', [message_id, user.id, emoji]);
        io.to('conv_' + conversation_id).emit('reaction_removed', { message_id, user_id: user.id, emoji });
      } catch (err) {}
    });

    // Delete message
    socket.on('delete_message', async (data) => {
      try {
        const { message_id, conversation_id } = data;
        const msgResult = await query('SELECT * FROM messages WHERE id = $1 AND sender_id = $2', [message_id, user.id]);
        if (msgResult.rows.length === 0) return;
        await query('UPDATE messages SET deleted = 1, content = NULL, file_url = NULL, file_name = NULL WHERE id = $1', [message_id]);
        io.to('conv_' + conversation_id).emit('message_deleted', { message_id, conversation_id });
      } catch (err) {}
    });

    // Pin message
    socket.on('pin_message', async (data) => {
      try {
        const { message_id, conversation_id } = data;
        await query('INSERT INTO pinned_messages (message_id, conversation_id, pinned_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [message_id, conversation_id, user.id]);
        const msgResult = await query('SELECT m.content, u.username as sender_name FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.id = $1', [message_id]);
        const msg = msgResult.rows[0];
        io.to('conv_' + conversation_id).emit('message_pinned', {
          message_id, conversation_id, pinned_by: user.username,
          content: msg ? msg.content : '', sender_name: msg ? msg.sender_name : ''
        });
      } catch (err) {}
    });

    socket.on('unpin_message', async (data) => {
      try {
        const { message_id, conversation_id } = data;
        await query('DELETE FROM pinned_messages WHERE message_id = $1', [message_id]);
        io.to('conv_' + conversation_id).emit('message_unpinned', { message_id, conversation_id });
      } catch (err) {}
    });

    // Join conversation room
    socket.on('join_conversation', (data) => {
      socket.join('conv_' + data.conversation_id);
    });

    // Member events
    socket.on('member_removed', (data) => { io.to('conv_' + data.conversation_id).emit('member_removed', data); });
    socket.on('member_added', (data) => {
      io.to('conv_' + data.conversation_id).emit('member_added', data);
      const targetSocket = onlineUsers.get(data.user_id);
      if (targetSocket) { io.sockets.sockets.get(targetSocket)?.join('conv_' + data.conversation_id); }
    });

    // Disconnect
    socket.on('disconnect', async () => {
      onlineUsers.delete(user.id);
      const now = new Date().toISOString();
      await query('UPDATE users SET status = $1, last_seen = $2 WHERE id = $3', ['offline', now, user.id]);
      io.emit('user_status', { userId: user.id, status: 'offline', last_seen: now });
      console.log(user.username + ' disconnected');
    });
  });
}

module.exports = { setupSocket, onlineUsers };
