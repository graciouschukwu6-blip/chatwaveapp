// ===== STATE =====
let currentUser = JSON.parse(localStorage.getItem('user'));
let token = localStorage.getItem('token');
let socket = null;
let currentConversation = null;
let conversations = [];
let replyingTo = null;
let contextMessageId = null;
let contextConversationId = null;
let mediaRecorder = null;
let audioChunks = [];
let recordingInterval = null;
let recordingSeconds = 0;

// Common emojis for picker
const EMOJIS = ['👍','❤️','😂','😮','😢','😡','🔥','👏','🎉','💯','✅','❌','👀','🙏','💪','😎','🤔','😍','💀','🥳','😭','🫡','💜','🤯'];

// Check auth
if (!token || !currentUser) {
  window.location.href = '/';
}

// DOM Elements
const sidebar = document.getElementById('sidebar');
const conversationsList = document.getElementById('conversationsList');
const emptyState = document.getElementById('emptyState');
const activeChat = document.getElementById('activeChat');
const messagesContainer = document.getElementById('messagesContainer');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');
const typingIndicator = document.getElementById('typingIndicator');
const newChatModal = document.getElementById('newChatModal');
const replyPreview = document.getElementById('replyPreview');

// ===== INIT =====
function init() {
  document.getElementById('myUsername').textContent = currentUser.username;
  document.getElementById('myChatNumber').textContent = '#' + currentUser.chat_number;
  document.getElementById('myAvatar').textContent = currentUser.username.charAt(0).toUpperCase();
  if (currentUser.avatar) {
    document.getElementById('myAvatar').style.backgroundImage = 'url(' + currentUser.avatar + ')';
    document.getElementById('myAvatar').style.backgroundSize = 'cover';
    document.getElementById('myAvatar').textContent = '';
  }

  socket = io({ auth: { token } });
  setupSocketEvents();
  loadConversations();
  setupEventListeners();
  setupNotifications();
  populateEmojiPicker();
}

// ===== NOTIFICATIONS =====
function setupNotifications() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function showNotification(title, body) {
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    new Notification(title, { body, icon: '/css/icon.png' });
  }
}

// ===== SOCKET EVENTS =====
function setupSocketEvents() {
  socket.on('connect', () => console.log('Connected'));

  socket.on('new_message', (message) => {
    if (currentConversation && currentConversation.id === message.conversation_id) {
      appendMessage(message);
      scrollToBottom();
      if (message.sender_id !== currentUser.id) {
        socket.emit('mark_read', { conversation_id: message.conversation_id, message_ids: [message.id] });
      }
    }
    // Push notification
    if (message.sender_id !== currentUser.id) {
      showNotification(message.sender_name, message.content || 'Sent a file');
    }
    loadConversations();
  });

  socket.on('user_status', (data) => {
    if (currentConversation) {
      const statusEl = document.getElementById('chatStatus');
      if (statusEl && data.userId !== currentUser.id) {
        if (data.status === 'online') {
          statusEl.textContent = 'online';
          statusEl.className = 'chat-status online';
        } else if (data.last_seen) {
          statusEl.textContent = 'last seen ' + formatLastSeen(data.last_seen);
          statusEl.className = 'chat-status last-seen';
        } else {
          statusEl.textContent = 'offline';
          statusEl.className = 'chat-status';
        }
      }
    }
    loadConversations();
  });

  socket.on('user_typing', (data) => {
    if (currentConversation && data.conversation_id === currentConversation.id) {
      typingIndicator.style.display = 'block';
      document.getElementById('typingUser').textContent = data.username;
    }
  });

  socket.on('user_stop_typing', (data) => {
    if (currentConversation && data.conversation_id === currentConversation.id) {
      typingIndicator.style.display = 'none';
    }
  });

  socket.on('messages_read', (data) => {
    if (currentConversation && data.conversation_id === currentConversation.id) {
      data.message_ids.forEach(msgId => {
        const msgEl = document.querySelector('[data-msg-id="' + msgId + '"] .msg-status');
        if (msgEl) { msgEl.textContent = 'Read'; msgEl.classList.add('read'); }
      });
    }
  });

  socket.on('reaction_added', (data) => {
    if (currentConversation && currentConversation.id) {
      updateMessageReactions(data.message_id);
    }
  });

  socket.on('reaction_removed', (data) => {
    if (currentConversation && currentConversation.id) {
      updateMessageReactions(data.message_id);
    }
  });

  socket.on('message_deleted', (data) => {
    if (currentConversation && data.conversation_id === currentConversation.id) {
      const msgEl = document.querySelector('[data-msg-id="' + data.message_id + '"]');
      if (msgEl) {
        msgEl.classList.add('deleted');
        const contentEl = msgEl.querySelector('.msg-content');
        if (contentEl) contentEl.innerHTML = '<em>This message was deleted</em>';
        const reactionsEl = msgEl.querySelector('.reactions');
        if (reactionsEl) reactionsEl.remove();
      }
    }
  });

  socket.on('message_pinned', (data) => {
    if (currentConversation && data.conversation_id === currentConversation.id) {
      showPinnedBar(data.content);
    }
  });

  socket.on('message_unpinned', (data) => {
    if (currentConversation && data.conversation_id === currentConversation.id) {
      document.getElementById('pinnedBar').style.display = 'none';
    }
  });

  socket.on('error_message', (data) => {
    alert(data.error);
  });

  socket.on('connect_error', (err) => {
    if (err.message === 'Authentication error') {
      localStorage.clear();
      window.location.href = '/';
    }
  });
}

// ===== CONVERSATIONS =====
async function loadConversations() {
  try {
    const res = await fetch('/api/chat/conversations', { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json();
    conversations = data.conversations;
    renderConversations();
  } catch (err) { console.error(err); }
}

function renderConversations() {
  conversationsList.innerHTML = '';
  if (conversations.length === 0) {
    conversationsList.innerHTML = '<p style="text-align:center;color:rgba(255,255,255,0.4);padding:20px;">No conversations yet</p>';
    return;
  }
  conversations.forEach(conv => {
    const item = document.createElement('div');
    item.className = 'conversation-item' + (currentConversation && currentConversation.id === conv.id ? ' active' : '');
    const initials = conv.display_name ? conv.display_name.charAt(0).toUpperCase() : '?';
    const isOnline = conv.display_status === 'online';
    let lastMsg = conv.last_message || 'No messages yet';
    if (conv.last_message_type === 'voice') lastMsg = 'Voice message';
    if (conv.last_message_type === 'file') lastMsg = 'File';
    const time = conv.last_message_time ? formatTime(conv.last_message_time) : '';
    const avatarStyle = conv.display_avatar ? 'background-image:url(' + conv.display_avatar + ');background-size:cover;' : '';
    const avatarText = conv.display_avatar ? '' : initials;

    item.innerHTML = '<div class="conv-avatar" style="' + avatarStyle + '">' + avatarText +
      (isOnline ? '<span class="online-dot"></span>' : '') + '</div>' +
      '<div class="conv-info"><div class="conv-name">' + (conv.display_name || 'Unknown') + '</div>' +
      '<div class="conv-last-msg">' + lastMsg + '</div></div>' +
      '<div class="conv-meta"><div class="conv-time">' + time + '</div>' +
      (conv.unread_count > 0 ? '<div class="conv-unread">' + conv.unread_count + '</div>' : '') + '</div>';

    item.addEventListener('click', () => openConversation(conv));
    conversationsList.appendChild(item);
  });
}

async function openConversation(conv) {
  currentConversation = conv;
  emptyState.style.display = 'none';
  activeChat.style.display = 'flex';

  document.getElementById('chatName').textContent = conv.display_name || conv.name || 'Chat';
  const avatarEl = document.getElementById('chatAvatar');
  if (conv.display_avatar) {
    avatarEl.style.backgroundImage = 'url(' + conv.display_avatar + ')';
    avatarEl.style.backgroundSize = 'cover';
    avatarEl.textContent = '';
  } else {
    avatarEl.style.backgroundImage = '';
    avatarEl.textContent = (conv.display_name || '?').charAt(0).toUpperCase();
  }

  const statusEl = document.getElementById('chatStatus');
  if (conv.type === 'private') {
    if (conv.display_status === 'online') {
      statusEl.textContent = 'online';
      statusEl.className = 'chat-status online';
    } else if (conv.display_last_seen) {
      statusEl.textContent = 'last seen ' + formatLastSeen(conv.display_last_seen);
      statusEl.className = 'chat-status last-seen';
    } else {
      statusEl.textContent = 'offline';
      statusEl.className = 'chat-status';
    }
  } else {
    statusEl.textContent = 'Group';
    statusEl.className = 'chat-status';
  }

  await loadMessages(conv.id);
  await loadPinnedPreview(conv.id);
  renderConversations();
  if (window.innerWidth <= 768) sidebar.classList.add('hidden');
}

// ===== MESSAGES =====
async function loadMessages(conversationId) {
  try {
    const res = await fetch('/api/chat/conversations/' + conversationId + '/messages', { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json();
    messagesContainer.innerHTML = '';
    window._currentReactions = data.reactions || [];
    window._currentReceipts = data.receipts || [];
    data.messages.forEach(msg => appendMessage(msg));
    scrollToBottom();
    const unreadIds = data.messages.filter(m => m.sender_id !== currentUser.id).map(m => m.id);
    if (unreadIds.length > 0) {
      socket.emit('mark_read', { conversation_id: conversationId, message_ids: unreadIds });
    }
  } catch (err) { console.error(err); }
}

function appendMessage(msg) {
  const div = document.createElement('div');
  const isSent = msg.sender_id === currentUser.id;

  if (msg.deleted) {
    div.className = 'message ' + (isSent ? 'sent' : 'received') + ' deleted';
    div.setAttribute('data-msg-id', msg.id);
    div.innerHTML = '<div class="msg-content"><em>This message was deleted</em></div><div class="msg-time">' + formatTime(msg.created_at) + '</div>';
    messagesContainer.appendChild(div);
    return;
  }

  div.className = 'message ' + (isSent ? 'sent' : 'received') + (msg.type === 'file' ? ' file-message' : '');
  div.setAttribute('data-msg-id', msg.id);

  let content = '';

  // Sender name in groups
  if (!isSent && currentConversation && currentConversation.type === 'group') {
    content += '<div class="sender-name">' + msg.sender_name + '</div>';
  }

  // Reply quote
  if (msg.reply_to && msg.reply_content) {
    content += '<div class="reply-quote"><span class="rq-name">' + (msg.reply_sender_name || 'User') + '</span><span class="rq-text">' + escapeHtml(msg.reply_content) + '</span></div>';
  }

  // Content
  if (msg.type === 'voice') {
    content += '<div class="voice-message"><audio controls src="' + msg.file_url + '"></audio></div>';
  } else if (msg.type === 'file' && msg.file_url) {
    const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(msg.file_name || '');
    content += '<div class="file-preview">';
    if (isImage) content += '<img src="' + msg.file_url + '" alt="' + (msg.file_name || '') + '">';
    else content += '<a href="' + msg.file_url + '" target="_blank">' + (msg.file_name || 'Download File') + '</a>';
    content += '</div>';
    if (msg.content) content += '<div class="msg-content">' + escapeHtml(msg.content) + '</div>';
  } else {
    content += '<div class="msg-content">' + escapeHtml(msg.content || '') + '</div>';
  }

  // Reactions
  const reactions = getReactionsForMessage(msg.id);
  if (reactions.length > 0) {
    content += '<div class="reactions">';
    const grouped = {};
    reactions.forEach(r => {
      if (!grouped[r.emoji]) grouped[r.emoji] = [];
      grouped[r.emoji].push(r);
    });
    for (const [emoji, users] of Object.entries(grouped)) {
      const isMine = users.some(u => u.user_id === currentUser.id);
      content += '<span class="reaction-chip' + (isMine ? ' mine' : '') + '" data-emoji="' + emoji + '" data-msg-id="' + msg.id + '">' + emoji + '<span class="r-count">' + users.length + '</span></span>';
    }
    content += '</div>';
  }

  // Time and status
  content += '<div class="msg-time">' + formatTime(msg.created_at);
  if (isSent) {
    const isRead = window._currentReceipts && window._currentReceipts.some(r => r.message_id === msg.id && r.user_id !== currentUser.id);
    content += '<span class="msg-status' + (isRead ? ' read' : '') + '">' + (isRead ? 'Read' : 'Sent') + '</span>';
  }
  content += '</div>';

  div.innerHTML = content;

  // Context menu on right-click/long-press
  div.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e, msg, isSent);
  });

  // Click on reaction chips to toggle
  div.querySelectorAll('.reaction-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const emoji = chip.dataset.emoji;
      const msgId = chip.dataset.msgId;
      if (chip.classList.contains('mine')) {
        socket.emit('remove_reaction', { message_id: parseInt(msgId), conversation_id: currentConversation.id, emoji });
      } else {
        socket.emit('add_reaction', { message_id: parseInt(msgId), conversation_id: currentConversation.id, emoji });
      }
    });
  });

  messagesContainer.appendChild(div);
}

function getReactionsForMessage(msgId) {
  if (!window._currentReactions) return [];
  return window._currentReactions.filter(r => r.message_id === msgId);
}

async function updateMessageReactions(messageId) {
  // Reload all messages (simple approach for real-time updates)
  if (currentConversation) await loadMessages(currentConversation.id);
}

// ===== SEND MESSAGE =====
function sendMessage() {
  const content = messageInput.value.trim();
  if (!content || !currentConversation) return;

  const data = {
    conversation_id: currentConversation.id,
    content,
    type: 'text'
  };

  if (replyingTo) {
    data.reply_to = replyingTo.id;
    cancelReply();
  }

  socket.emit('send_message', data);
  messageInput.value = '';
  socket.emit('stop_typing', { conversation_id: currentConversation.id });
}

// ===== REPLY =====
function setReply(msg) {
  replyingTo = msg;
  document.getElementById('replyToName').textContent = msg.sender_name || 'User';
  document.getElementById('replyToText').textContent = msg.content || 'Media';
  replyPreview.style.display = 'flex';
  messageInput.focus();
}

function cancelReply() {
  replyingTo = null;
  replyPreview.style.display = 'none';
}

// ===== CONTEXT MENU =====
function showContextMenu(e, msg, isSent) {
  const menu = document.getElementById('contextMenu');
  contextMessageId = msg.id;
  contextConversationId = msg.conversation_id;

  // Show/hide delete button
  const deleteBtn = menu.querySelector('[data-action="delete"]');
  deleteBtn.style.display = isSent ? 'block' : 'none';

  menu.style.display = 'block';
  menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 200) + 'px';

  // Store msg for reply
  menu._msg = msg;

  setTimeout(() => {
    document.addEventListener('click', hideContextMenu, { once: true });
  }, 10);
}

function hideContextMenu() {
  document.getElementById('contextMenu').style.display = 'none';
  document.getElementById('emojiPicker').style.display = 'none';
}

// ===== EMOJI PICKER =====
function populateEmojiPicker() {
  const grid = document.getElementById('emojiGrid');
  EMOJIS.forEach(emoji => {
    const btn = document.createElement('button');
    btn.textContent = emoji;
    btn.addEventListener('click', () => {
      if (contextMessageId) {
        socket.emit('add_reaction', { message_id: contextMessageId, conversation_id: currentConversation.id, emoji });
      }
      document.getElementById('emojiPicker').style.display = 'none';
    });
    grid.appendChild(btn);
  });
}

// ===== PINNED MESSAGES =====
async function loadPinnedPreview(conversationId) {
  try {
    const res = await fetch('/api/chat/conversations/' + conversationId + '/pinned', { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json();
    if (data.pinned && data.pinned.length > 0) {
      showPinnedBar(data.pinned[0].content);
    } else {
      document.getElementById('pinnedBar').style.display = 'none';
    }
  } catch (err) {}
}

function showPinnedBar(content) {
  const bar = document.getElementById('pinnedBar');
  document.getElementById('pinnedText').textContent = content || 'Pinned message';
  bar.style.display = 'flex';
}

async function loadPinnedPanel() {
  if (!currentConversation) return;
  const panel = document.getElementById('pinnedPanel');
  const body = document.getElementById('pinnedBody');

  try {
    const res = await fetch('/api/chat/conversations/' + currentConversation.id + '/pinned', { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json();

    if (!data.pinned || data.pinned.length === 0) {
      body.innerHTML = '<p style="color:rgba(255,255,255,0.4);text-align:center;padding:20px;">No pinned messages</p>';
    } else {
      body.innerHTML = '';
      data.pinned.forEach(p => {
        body.innerHTML += '<div class="pinned-item"><div class="pi-sender">' + p.sender_name + '</div><div class="pi-content">' + escapeHtml(p.content || '') + '</div><div class="pi-actions"><button class="unpin-btn" onclick="unpinMessage(' + p.id + ')">Unpin</button></div></div>';
      });
    }
    panel.style.display = 'block';
  } catch (err) {}
}

function unpinMessage(msgId) {
  socket.emit('unpin_message', { message_id: msgId, conversation_id: currentConversation.id });
  loadPinnedPanel();
}

// ===== VOICE RECORDING =====
async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      await sendVoiceNote(blob);
    };

    mediaRecorder.start();
    recordingSeconds = 0;
    document.getElementById('recordingTime').textContent = '0:00';
    document.getElementById('voiceRecording').style.display = 'flex';
    document.querySelector('.message-input-area').style.display = 'none';

    recordingInterval = setInterval(() => {
      recordingSeconds++;
      const mins = Math.floor(recordingSeconds / 60);
      const secs = recordingSeconds % 60;
      document.getElementById('recordingTime').textContent = mins + ':' + (secs < 10 ? '0' : '') + secs;
    }, 1000);
  } catch (err) {
    alert('Microphone access denied');
  }
}

function stopRecording(send) {
  clearInterval(recordingInterval);
  document.getElementById('voiceRecording').style.display = 'none';
  document.querySelector('.message-input-area').style.display = 'flex';

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    if (send) {
      mediaRecorder.stop();
    } else {
      mediaRecorder.stream.getTracks().forEach(t => t.stop());
      mediaRecorder = null;
    }
  }
}

async function sendVoiceNote(blob) {
  if (!currentConversation) return;
  const formData = new FormData();
  formData.append('voice', blob, 'voice.webm');

  try {
    const res = await fetch('/api/chat/upload/voice', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      body: formData
    });
    const data = await res.json();
    if (res.ok) {
      socket.emit('send_message', {
        conversation_id: currentConversation.id,
        content: 'Voice message',
        type: 'voice',
        file_url: data.file_url,
        file_name: data.file_name
      });
    }
  } catch (err) { console.error(err); }
}

// ===== SEARCH MESSAGES =====
async function searchMessages(query) {
  const resultsDiv = document.getElementById('searchResults');
  if (!query) { resultsDiv.innerHTML = ''; return; }

  try {
    const res = await fetch('/api/chat/messages/search?q=' + encodeURIComponent(query), { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json();

    if (!data.messages || data.messages.length === 0) {
      resultsDiv.innerHTML = '<p style="color:rgba(255,255,255,0.4);text-align:center;padding:20px;">No results found</p>';
      return;
    }

    resultsDiv.innerHTML = '';
    data.messages.forEach(msg => {
      const item = document.createElement('div');
      item.className = 'search-result-item';
      item.innerHTML = '<div class="sr-conv">' + (msg.display_conv_name || 'Chat') + '</div><div class="sr-content">' + escapeHtml(msg.content || '') + '</div><div class="sr-meta">' + msg.sender_name + ' - ' + formatTime(msg.created_at) + '</div>';
      item.addEventListener('click', () => {
        document.getElementById('searchModal').style.display = 'none';
        const conv = conversations.find(c => c.id === msg.conversation_id);
        if (conv) openConversation(conv);
      });
      resultsDiv.appendChild(item);
    });
  } catch (err) { console.error(err); }
}

// ===== PROFILE & BLOCK =====
async function loadProfile() {
  const modal = document.getElementById('profileModal');
  document.getElementById('profileUsername').textContent = currentUser.username;
  document.getElementById('profileEmail').textContent = currentUser.email;
  document.getElementById('profileChatNum').textContent = '#' + currentUser.chat_number;

  const avatarEl = document.getElementById('profileAvatar');
  if (currentUser.avatar) {
    avatarEl.style.backgroundImage = 'url(' + currentUser.avatar + ')';
    avatarEl.textContent = '';
  } else {
    avatarEl.textContent = currentUser.username.charAt(0).toUpperCase();
  }

  // Load blocked users
  try {
    const res = await fetch('/api/chat/users/blocked', { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json();
    const list = document.getElementById('blockedList');
    if (data.blocked.length === 0) {
      list.innerHTML = '<p style="font-size:13px;color:rgba(255,255,255,0.4);">No blocked users</p>';
    } else {
      list.innerHTML = '';
      data.blocked.forEach(u => {
        list.innerHTML += '<div class="blocked-item"><span>' + u.username + ' (#' + u.chat_number + ')</span><button class="unblock-btn" onclick="unblockUser(\''+u.chat_number+'\')">Unblock</button></div>';
      });
    }
  } catch (err) {}

  modal.style.display = 'flex';
}

async function blockUser(chatNumber) {
  try {
    const res = await fetch('/api/chat/users/block', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ chat_number: chatNumber })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    alert('User blocked');
    loadProfile();
  } catch (err) { alert(err.message); }
}

async function unblockUser(chatNumber) {
  try {
    await fetch('/api/chat/users/unblock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ chat_number: chatNumber })
    });
    loadProfile();
  } catch (err) { alert(err.message); }
}

// ===== EVENT LISTENERS =====
function setupEventListeners() {
  // Send
  sendBtn.addEventListener('click', sendMessage);
  messageInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });

  // Typing
  let typingTimeout;
  messageInput.addEventListener('input', () => {
    if (!currentConversation) return;
    socket.emit('typing', { conversation_id: currentConversation.id });
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => socket.emit('stop_typing', { conversation_id: currentConversation.id }), 2000);
  });

  // File upload
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file || !currentConversation) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('/api/chat/upload', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token }, body: formData });
      const data = await res.json();
      if (res.ok) {
        socket.emit('send_message', { conversation_id: currentConversation.id, content: '', type: 'file', file_url: data.file_url, file_name: data.file_name, reply_to: replyingTo ? replyingTo.id : null });
        cancelReply();
      }
    } catch (err) { console.error(err); }
    fileInput.value = '';
  });

  // Voice
  document.getElementById('voiceBtn').addEventListener('click', () => startRecording());
  document.getElementById('cancelRecording').addEventListener('click', () => stopRecording(false));
  document.getElementById('sendRecording').addEventListener('click', () => stopRecording(true));

  // Reply cancel
  document.getElementById('replyCancelBtn').addEventListener('click', cancelReply);

  // New chat modal
  document.getElementById('newChatBtn').addEventListener('click', () => { newChatModal.style.display = 'flex'; });
  document.getElementById('startChatBtn').addEventListener('click', () => { newChatModal.style.display = 'flex'; });
  document.getElementById('closeNewChat').addEventListener('click', () => { newChatModal.style.display = 'none'; });

  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => { c.classList.remove('active'); c.style.display = 'none'; });
      btn.classList.add('active');
      const tab = document.getElementById(btn.dataset.tab + 'Tab');
      tab.classList.add('active');
      tab.style.display = 'block';
    });
  });

  // Search user
  const privateChatInput = document.getElementById('privateChatNumber');
  let searchTimeout;
  privateChatInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(async () => {
      const q = privateChatInput.value.trim();
      const resultDiv = document.getElementById('userSearchResult');
      if (q.length < 3) { resultDiv.innerHTML = ''; resultDiv.className = 'user-search-result'; return; }
      try {
        const res = await fetch('/api/chat/users/search?q=' + q, { headers: { 'Authorization': 'Bearer ' + token } });
        const data = await res.json();
        if (data.users.length > 0) {
          resultDiv.innerHTML = 'Found: <strong>' + data.users[0].username + '</strong> (#' + data.users[0].chat_number + ')';
          resultDiv.className = 'user-search-result found';
        } else {
          resultDiv.innerHTML = 'No user found';
          resultDiv.className = 'user-search-result not-found';
        }
      } catch (err) { resultDiv.innerHTML = 'Error'; resultDiv.className = 'user-search-result not-found'; }
    }, 500);
  });

  // Start private chat
  document.getElementById('startPrivateChat').addEventListener('click', async () => {
    const chatNumber = privateChatInput.value.trim();
    if (!chatNumber) return;
    try {
      const res = await fetch('/api/chat/conversations/private', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ chat_number: chatNumber })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      socket.emit('join_conversation', { conversation_id: data.conversation_id });
      newChatModal.style.display = 'none';
      privateChatInput.value = '';
      document.getElementById('userSearchResult').innerHTML = '';
      await loadConversations();
      const conv = conversations.find(c => c.id === data.conversation_id);
      if (conv) openConversation(conv);
    } catch (err) { alert(err.message); }
  });

  // Create group
  document.getElementById('createGroupChat').addEventListener('click', async () => {
    const name = document.getElementById('groupName').value.trim();
    const membersStr = document.getElementById('groupMembers').value.trim();
    if (!name || !membersStr) return alert('Please fill all fields');
    const members = membersStr.split(',').map(s => s.trim()).filter(Boolean);
    try {
      const res = await fetch('/api/chat/conversations/group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ name, members })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      socket.emit('join_conversation', { conversation_id: data.conversation_id });
      newChatModal.style.display = 'none';
      document.getElementById('groupName').value = '';
      document.getElementById('groupMembers').value = '';
      await loadConversations();
      const conv = conversations.find(c => c.id === data.conversation_id);
      if (conv) openConversation(conv);
    } catch (err) { alert(err.message); }
  });

  // Back button (mobile)
  document.getElementById('backBtn').addEventListener('click', () => {
    sidebar.classList.remove('hidden');
    activeChat.style.display = 'none';
    emptyState.style.display = 'flex';
  });

  // Context menu actions
  document.querySelectorAll('.ctx-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const menu = document.getElementById('contextMenu');
      const msg = menu._msg;
      menu.style.display = 'none';

      if (action === 'reply') {
        setReply(msg);
      } else if (action === 'react') {
        const picker = document.getElementById('emojiPicker');
        picker.style.display = 'block';
        picker.style.left = menu.style.left;
        picker.style.top = menu.style.top;
      } else if (action === 'pin') {
        socket.emit('pin_message', { message_id: contextMessageId, conversation_id: currentConversation.id });
      } else if (action === 'delete') {
        if (confirm('Delete this message?')) {
          socket.emit('delete_message', { message_id: contextMessageId, conversation_id: currentConversation.id });
        }
      }
    });
  });

  // Pinned messages
  document.getElementById('pinnedBtn').addEventListener('click', loadPinnedPanel);
  document.getElementById('closePinned').addEventListener('click', () => { document.getElementById('pinnedPanel').style.display = 'none'; });
  document.getElementById('pinnedBarClose').addEventListener('click', () => { document.getElementById('pinnedBar').style.display = 'none'; });

  // Chat info
  document.getElementById('chatInfoBtn').addEventListener('click', async () => {
    if (!currentConversation) return;
    try {
      const res = await fetch('/api/chat/conversations/' + currentConversation.id + '/members', { headers: { 'Authorization': 'Bearer ' + token } });
      const data = await res.json();
      let html = '<h4 style="margin-bottom:12px;color:rgba(255,255,255,0.7);">Members</h4>';
      data.members.forEach(m => {
        const status = m.status === 'online' ? '<span style="color:#2ecc71;">online</span>' : '<span style="color:rgba(255,255,255,0.4);">last seen ' + formatLastSeen(m.last_seen) + '</span>';
        html += '<div class="member-item"><div class="user-avatar" style="width:36px;height:36px;font-size:14px;">' + m.username.charAt(0).toUpperCase() + '</div><div><div class="member-name">' + m.username + (m.id === currentUser.id ? ' (You)' : '') + '</div><div class="member-num">#' + m.chat_number + ' - ' + status + '</div></div></div>';
      });
      document.getElementById('infoBody').innerHTML = html;
      document.getElementById('infoPanel').style.display = 'block';
    } catch (err) {}
  });
  document.getElementById('closeInfo').addEventListener('click', () => { document.getElementById('infoPanel').style.display = 'none'; });

  // Profile
  document.getElementById('userProfileBtn').addEventListener('click', loadProfile);
  document.getElementById('closeProfile').addEventListener('click', () => { document.getElementById('profileModal').style.display = 'none'; });

  // Avatar upload
  document.getElementById('avatarInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('avatar', file);
    try {
      const res = await fetch('/api/auth/avatar', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token }, body: formData });
      const data = await res.json();
      if (res.ok) {
        currentUser.avatar = data.avatar;
        localStorage.setItem('user', JSON.stringify(currentUser));
        document.getElementById('profileAvatar').style.backgroundImage = 'url(' + data.avatar + ')';
        document.getElementById('profileAvatar').textContent = '';
        document.getElementById('myAvatar').style.backgroundImage = 'url(' + data.avatar + ')';
        document.getElementById('myAvatar').style.backgroundSize = 'cover';
        document.getElementById('myAvatar').textContent = '';
      }
    } catch (err) { console.error(err); }
  });

  // Block user
  document.getElementById('blockUserBtn').addEventListener('click', () => {
    const num = document.getElementById('blockInput').value.trim();
    if (num) { blockUser(num); document.getElementById('blockInput').value = ''; }
  });

  // Search messages
  document.getElementById('searchMsgsBtn').addEventListener('click', () => { document.getElementById('searchModal').style.display = 'flex'; });
  document.getElementById('closeSearch').addEventListener('click', () => { document.getElementById('searchModal').style.display = 'none'; });
  let msgSearchTimeout;
  document.getElementById('msgSearchInput').addEventListener('input', (e) => {
    clearTimeout(msgSearchTimeout);
    msgSearchTimeout = setTimeout(() => searchMessages(e.target.value.trim()), 500);
  });

  // Logout
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    localStorage.clear();
    window.location.href = '/';
  });

  // Search conversations
  document.getElementById('searchConversations').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('.conversation-item').forEach(item => {
      const name = item.querySelector('.conv-name').textContent.toLowerCase();
      item.style.display = name.includes(q) ? 'flex' : 'none';
    });
  });

  // Close modals on backdrop click
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
  });
}

// ===== HELPERS =====
function formatTime(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now - date;
  if (diff < 60000) return 'Now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
  if (diff < 86400000) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diff < 604800000) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatLastSeen(dateStr) {
  if (!dateStr) return 'a while ago';
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now - date;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' min ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Expose for inline onclick handlers
window.unblockUser = unblockUser;
window.unpinMessage = unpinMessage;

// Start
init();
