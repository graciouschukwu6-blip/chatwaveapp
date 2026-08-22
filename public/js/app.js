// ===== STATE =====
let currentUser = JSON.parse(localStorage.getItem('user'));
let token = localStorage.getItem('token');
let socket = null;
let currentConversation = null;
let conversations = [];
let replyingTo = null;
let contextMessageId = null;
let contextConversationId = null;
let contextIsMine = false;
let mediaRecorder = null;
let audioChunks = [];
let recordingInterval = null;
let recordingSeconds = 0;
let forwardMessageId = null;
let selectedForwardConvs = [];
let editingMessageId = null;
let viewOnceActive = false;
let starredMessageIds = [];

const EMOJIS = ['\u{1F44D}','\u{2764}','\u{1F602}','\u{1F62E}','\u{1F622}','\u{1F621}','\u{1F525}','\u{1F44F}','\u{1F389}','\u{1F4AF}','\u{2705}','\u{274C}','\u{1F440}','\u{1F64F}','\u{1F4AA}','\u{1F60E}','\u{1F914}','\u{1F60D}','\u{1F480}','\u{1F973}','\u{1F62D}','\u{1FAE1}','\u{1F49C}','\u{1F92F}'];

if (!token || !currentUser) {
  localStorage.clear();
  window.location.href = '/';
}

// Validate token on load
fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } })
  .then(function(res) {
    if (!res.ok) { localStorage.clear(); window.location.href = '/'; }
  })
  .catch(function() { localStorage.clear(); window.location.href = '/'; });

// ===== THEME =====
function getTheme() { return localStorage.getItem('cw_theme') || 'dark'; }
function setTheme(t) { document.documentElement.setAttribute('data-theme', t); localStorage.setItem('cw_theme', t); }
setTheme(getTheme());

// ===== SOUND EFFECTS =====
let audioCtx = null;
function playSound(type) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    if (type === 'message') {
      osc.frequency.setValueAtTime(800, audioCtx.currentTime);
      osc.frequency.setValueAtTime(600, audioCtx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
      osc.start(audioCtx.currentTime);
      osc.stop(audioCtx.currentTime + 0.3);
    } else if (type === 'mention') {
      osc.frequency.setValueAtTime(1000, audioCtx.currentTime);
      osc.frequency.setValueAtTime(1200, audioCtx.currentTime + 0.1);
      osc.frequency.setValueAtTime(800, audioCtx.currentTime + 0.2);
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.4);
      osc.start(audioCtx.currentTime);
      osc.stop(audioCtx.currentTime + 0.4);
    }
  } catch(e) {}
}

// ===== DOM ELEMENTS =====
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
const replyPreview = document.getElementById('replyPreview');

// ===== INIT =====
function init() {
  document.getElementById('myUsername').textContent = currentUser.username;
  document.getElementById('myChatNumber').textContent = '#' + currentUser.chat_number;
  const myAv = document.getElementById('myAvatar');
  myAv.textContent = currentUser.username.charAt(0).toUpperCase();
  if (currentUser.avatar) {
    myAv.style.backgroundImage = 'url(' + currentUser.avatar + ')';
    myAv.style.backgroundSize = 'cover';
    myAv.textContent = '';
  }

  socket = io({ auth: { token } });
  setupSocketEvents();
  loadConversations();
  setupEventListeners();
  setupNotifications();
  populateEmojiPicker();
  loadStatusFeed();
}

// ===== NOTIFICATIONS =====
function setupNotifications() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function showNotification(title, body) {
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    new Notification(title, { body });
  }
}

// ===== SOCKET EVENTS =====
function setupSocketEvents() {
  socket.on('connect', () => console.log('Connected to ChatWave'));

  socket.on('new_message', (message) => {
    if (currentConversation && currentConversation.id === message.conversation_id) {
      appendMessage(message, [], [], starredMessageIds);
      scrollToBottom();
      if (message.sender_id !== currentUser.id) {
        socket.emit('mark_read', { conversation_id: message.conversation_id, message_ids: [message.id] });
      }
    }
    if (message.sender_id !== currentUser.id) {
      // Check mute before playing sound
      var msgConv = conversations.find(c => c.id === message.conversation_id);
      var isMuted = msgConv && msgConv.muted_until && new Date(msgConv.muted_until) > new Date();
      if (!isMuted) {
        if (message.content && message.content.includes('@' + currentUser.username)) {
          playSound('mention');
        } else {
          playSound('message');
        }
        showNotification(message.sender_name, message.content || 'Sent a file');
      }
    }
    loadConversations();
  });

  socket.on('user_status', (data) => {
    if (currentConversation && currentConversation.type === 'private') {
      const statusEl = document.getElementById('chatStatus');
      if (statusEl && data.userId !== currentUser.id) {
        if (data.status === 'online') {
          statusEl.textContent = 'online';
          statusEl.className = 'chat-status online';
        } else if (data.last_seen) {
          statusEl.textContent = 'last seen ' + formatLastSeen(data.last_seen);
          statusEl.className = 'chat-status';
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
      typingIndicator.style.display = 'flex';
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

  socket.on('message_edited', (data) => {
    if (currentConversation && data.conversation_id === currentConversation.id) {
      const msgEl = document.querySelector('[data-msg-id="' + data.message_id + '"]');
      if (msgEl) {
        const contentEl = msgEl.querySelector('.msg-content');
        if (contentEl) contentEl.textContent = data.content;
        let editedEl = msgEl.querySelector('.msg-edited');
        if (!editedEl) {
          editedEl = document.createElement('span');
          editedEl.className = 'msg-edited';
          editedEl.textContent = 'edited';
          msgEl.querySelector('.msg-meta').prepend(editedEl);
        }
      }
    }
  });

  socket.on('reaction_added', (data) => {
    if (currentConversation) updateMessageReactions(data.message_id);
  });

  socket.on('reaction_removed', (data) => {
    if (currentConversation) updateMessageReactions(data.message_id);
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

  socket.on('error_message', (data) => { alert(data.error); });

  socket.on('poll_updated', (data) => {
    // Re-render poll cards for this poll
    document.querySelectorAll('.poll-card[data-poll-id="' + data.poll_id + '"]').forEach(function(card) {
      loadPollCard(data.poll_id, card);
    });
  });

  socket.on('disappearing_updated', (data) => {
    if (currentConversation && data.conversation_id === currentConversation.id) {
      currentConversation.disappearing_timer = data.timer;
    }
  });

  socket.on('group_updated', (data) => {
    if (currentConversation && data.conversation_id === currentConversation.id) {
      if (data.description !== undefined) currentConversation.description = data.description;
    }
  });

  socket.on('member_joined', (data) => {
    if (currentConversation && data.conversation_id === currentConversation.id) {
      loadConversations();
    }
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
  const searchVal = document.getElementById('searchConversations').value.toLowerCase();
  conversationsList.innerHTML = '';

  // Separate archived
  let archived = conversations.filter(c => c.archived);
  let filtered = conversations.filter(c => !c.archived);

  // Show archived header if any
  if (archived.length > 0 && !searchVal) {
    var archiveHeader = document.createElement('div');
    archiveHeader.className = 'archived-header';
    archiveHeader.innerHTML = '<span>&#128451; Archived</span><span class="archived-count">' + archived.length + '</span>';
    archiveHeader.addEventListener('click', showArchivedChats);
    conversationsList.appendChild(archiveHeader);
  }

  if (searchVal) {
    filtered = conversations.filter(c => (c.display_name || '').toLowerCase().includes(searchVal));
  }
  if (filtered.length === 0) {
    conversationsList.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:40px 20px;font-size:13px;">No conversations yet</p>';
    return;
  }
  filtered.forEach(conv => {
    const item = document.createElement('div');
    item.className = 'conversation-item' + (currentConversation && currentConversation.id === conv.id ? ' active' : '');
    const initials = conv.display_name ? conv.display_name.charAt(0).toUpperCase() : '?';
    const isOnline = conv.display_status === 'online';
    let lastMsg = conv.last_message || 'No messages yet';
    if (conv.last_message_type === 'voice') lastMsg = '\u{1F3A4} Voice message';
    if (conv.last_message_type === 'file' || conv.last_message_type === 'image' || conv.last_message_type === 'video') lastMsg = '\u{1F4CE} File';
    const time = conv.last_message_time ? formatTime(conv.last_message_time) : '';
    const avatarStyle = conv.display_avatar ? 'background-image:url(' + conv.display_avatar + ');background-size:cover;' : '';
    const avatarText = conv.display_avatar ? '' : initials;

    var isMuted = conv.muted_until && new Date(conv.muted_until) > new Date();
    var muteIcon = isMuted ? ' <span style="font-size:11px;opacity:0.5;">&#128263;</span>' : '';
    item.innerHTML = '<div class="conv-avatar" style="' + avatarStyle + '">' + avatarText +
      (isOnline ? '<span class="online-dot"></span>' : '') + '</div>' +
      '<div class="conv-info"><div class="conv-name">' + escapeHtml(conv.display_name || 'Unknown') +
      (conv.type === 'group' ? ' <span style="font-size:11px;color:var(--text-muted);">(' + conv.member_count + ')</span>' : '') +
      muteIcon + '</div><div class="conv-last-msg">' + escapeHtml(lastMsg) + '</div></div>' +
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
      statusEl.className = 'chat-status';
    } else {
      statusEl.textContent = 'offline';
      statusEl.className = 'chat-status';
    }
  } else {
    statusEl.textContent = conv.member_count + ' members';
    statusEl.className = 'chat-status';
    // Show description below if exists
    if (conv.description) {
      statusEl.textContent = conv.description.substring(0, 40) + (conv.description.length > 40 ? '...' : '');
    }
  }

  await loadMessages(conv.id);
  await loadPinnedPreview(conv.id);
  renderConversations();
  // Load group members for @mention
  if (conv.type === 'group') {
    try {
      var memRes = await fetch('/api/chat/conversations/' + conv.id + '/members', { headers: { 'Authorization': 'Bearer ' + token } });
      var memData = await memRes.json();
      groupMembers = memData.members || [];
    } catch(e) { groupMembers = []; }
    updateInputLockState();
    // Show poll button for groups
    var pollBtn = document.getElementById('pollBtn');
    if (pollBtn) pollBtn.classList.add('poll-btn-visible');
  } else {
    groupMembers = [];
    var pollBtn2 = document.getElementById('pollBtn');
    if (pollBtn2) pollBtn2.classList.remove('poll-btn-visible');
  }
  if (window.innerWidth <= 768) sidebar.classList.add('hidden');
  socket.emit('join_conversation', { conversation_id: conv.id });
  // Apply wallpaper (conv.wallpaper comes from conversations API)
  if (typeof applyWallpaper === 'function') {
    applyWallpaper(conv.wallpaper || null);
  }

  // Show/hide call buttons (only for private 1-on-1 chats)
  var voiceCallBtn = document.getElementById('voiceCallBtn');
  var videoCallBtn = document.getElementById('videoCallBtn');
  if (voiceCallBtn && videoCallBtn) {
    voiceCallBtn.style.display = conv.type === 'private' ? 'flex' : 'none';
    videoCallBtn.style.display = conv.type === 'private' ? 'flex' : 'none';
  }
}

async function loadMessages(convId) {
  try {
    const res = await fetch('/api/chat/conversations/' + convId + '/messages', { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json();
    starredMessageIds = data.starred || [];
    messagesContainer.innerHTML = '';
    data.messages.forEach(msg => appendMessage(msg, data.reactions, data.receipts, starredMessageIds));
    scrollToBottom();
    // Mark unread as read
    const unread = data.messages.filter(m => m.sender_id !== currentUser.id).map(m => m.id);
    if (unread.length > 0) {
      socket.emit('mark_read', { conversation_id: convId, message_ids: unread });
    }
  } catch (err) { console.error(err); }
}

async function loadPinnedPreview(convId) {
  try {
    const res = await fetch('/api/chat/conversations/' + convId + '/pinned', { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json();
    if (data.pinned && data.pinned.length > 0) {
      showPinnedBar(data.pinned[0].content);
    } else {
      document.getElementById('pinnedBar').style.display = 'none';
    }
  } catch(e) {}
}

function showPinnedBar(content) {
  document.getElementById('pinnedBar').style.display = 'flex';
  document.getElementById('pinnedText').textContent = content || 'Pinned message';
}

// ===== MESSAGE RENDERING =====
function appendMessage(msg, allReactions, allReceipts, starredIds) {
  const isMine = msg.sender_id === currentUser.id;
  const div = document.createElement('div');
  div.className = 'message ' + (isMine ? 'sent' : 'received');
  div.setAttribute('data-msg-id', msg.id);
  div.setAttribute('data-sender-id', msg.sender_id);

  let avatarHtml = '';
  if (!isMine) {
    const avStyle = msg.sender_avatar ? 'background-image:url(' + msg.sender_avatar + ');background-size:cover;' : '';
    const avText = msg.sender_avatar ? '' : (msg.sender_name || '?').charAt(0).toUpperCase();
    avatarHtml = '<div class="msg-avatar" style="' + avStyle + '">' + avText + '</div>';
  }

  let contentHtml = '';
  if (msg.deleted) {
    contentHtml = '<em>This message was deleted</em>';
  } else if (msg.view_once && !isMine) {
    var voIcon = msg.type === 'voice' ? '&#127908;' : (msg.type === 'video' ? '&#127909;' : '&#128247;');
    contentHtml = '<div class="view-once-msg" onclick="openViewOnce(' + msg.id + ', this)" data-msg-id="' + msg.id + '">' + voIcon + ' <span>View once</span></div>';
  } else if (msg.view_once && isMine) {
    contentHtml = '<div class="view-once-msg sent-view-once">&#128065; <span>View once ' + msg.type + '</span></div>';
  } else if (msg.type === 'image' || (msg.type === 'file' && msg.file_url && /\.(jpg|jpeg|png|gif|webp)$/i.test(msg.file_url))) {
    contentHtml = '<img src="' + msg.file_url + '" alt="image" onclick="openLightbox(this.src)" loading="lazy">';
  } else if (msg.type === 'video' || (msg.type === 'file' && msg.file_url && /\.(mp4|webm|mov)$/i.test(msg.file_url))) {
    contentHtml = '<video src="' + msg.file_url + '" controls preload="metadata"></video>';
  } else if (msg.type === 'voice') {
    contentHtml = '<div class="voice-message"><audio src="' + msg.file_url + '" controls preload="metadata"></audio></div>';
  } else if (msg.type === 'file' && msg.file_url) {
    const icon = getFileIcon(msg.file_name || msg.file_url);
    contentHtml = '<a href="' + msg.file_url + '" target="_blank" class="file-attachment">' +
      '<div class="file-icon">' + icon + '</div>' +
      '<div class="file-info"><span class="file-name">' + escapeHtml(msg.file_name || 'File') + '</span></div></a>';
  } else if (msg.type === 'poll') {
    contentHtml = '<div class="poll-card" data-poll-id="' + msg.content + '"><div class="poll-loading">&#128202; Loading poll...</div></div>';
  } else if (msg.type === 'gif') {
    contentHtml = '<img src="' + escapeHtml(msg.content) + '" alt="GIF" class="gif-message" onclick="openLightbox(this.src)" loading="lazy">';
  } else if (msg.type === 'sticker') {
    contentHtml = '<div style="font-size:64px;line-height:1;">' + (msg.content || '') + '</div>';
  } else {
    contentHtml = escapeHtml(msg.content || '');
    contentHtml = linkify(contentHtml);
    contentHtml = highlightMentions(contentHtml);
  }

  let replyHtml = '';
  if (msg.reply_to && msg.reply_content) {
    replyHtml = '<div class="msg-reply"><span class="reply-name">' + escapeHtml(msg.reply_sender_name || '') + '</span><span class="reply-text">' + escapeHtml(msg.reply_content || '').substring(0, 60) + '</span></div>';
  }

  let forwardedHtml = '';
  if (msg.forwarded_from) {
    forwardedHtml = '<span class="msg-forwarded">\u{21AA} Forwarded</span>';
  }

  let senderHtml = '';
  if (!isMine && currentConversation && currentConversation.type === 'group') {
    senderHtml = '<span class="msg-sender">' + escapeHtml(msg.sender_name || '') + '</span>';
  }

  const time = msg.created_at ? formatMsgTime(msg.created_at) : '';
  let metaHtml = '<div class="msg-meta">';
  var isStarred = starredIds && starredIds.includes(msg.id);
  if (isStarred) metaHtml += '<span class="msg-star-icon">&#11088;</span>';
  if (msg.expires_at) metaHtml += '<span class="msg-timer-icon" title="Disappearing">&#9201;</span>';
  if (msg.edited) metaHtml += '<span class="msg-edited">edited</span>';
  metaHtml += '<span class="msg-time">' + time + '</span>';
  if (isMine) metaHtml += '<span class="msg-status">Sent</span>';
  metaHtml += '</div>';

  // Reactions
  let reactionsHtml = '';
  if (!msg.deleted) {
    const msgReactions = allReactions ? allReactions.filter(r => r.message_id === msg.id) : [];
    if (msgReactions.length > 0) {
      reactionsHtml = buildReactionsHtml(msgReactions, msg.id);
    }
    reactionsHtml = '<div class="reactions" data-msg-id="' + msg.id + '">' + reactionsHtml + '</div>';
  }

  // Link preview
  var linkPreviewHtml = '';
  if (msg.link_preview && !msg.deleted) {
    var lp = typeof msg.link_preview === 'string' ? JSON.parse(msg.link_preview) : msg.link_preview;
    linkPreviewHtml = '<a href="' + escapeHtml(lp.url) + '" target="_blank" class="link-preview-card">' +
      (lp.image ? '<img src="' + escapeHtml(lp.image) + '" class="link-preview-img" loading="lazy" onerror="this.style.display=\'none\'">' : '') +
      '<div class="link-preview-body"><span class="link-preview-title">' + escapeHtml(lp.title || '') + '</span><span class="link-preview-desc">' + escapeHtml(lp.description || '') + '</span><span class="link-preview-url">' + escapeHtml(lp.url || '').substring(0, 40) + '</span></div></a>';
  }

  div.innerHTML = avatarHtml + '<div class="msg-bubble">' + forwardedHtml + senderHtml + replyHtml + '<div class="msg-content">' + contentHtml + '</div>' + linkPreviewHtml + metaHtml + reactionsHtml + '</div>';

  // Context menu
  div.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e, msg.id, msg.conversation_id, isMine, msg.type);
  });

  messagesContainer.appendChild(div);

  // Load poll if type is poll
  if (msg.type === 'poll' && msg.content && !msg.deleted) {
    loadPollCard(msg.content, div.querySelector('.poll-card'));
  }
}

function buildReactionsHtml(reactions, msgId) {
  const grouped = {};
  reactions.forEach(r => {
    if (!grouped[r.emoji]) grouped[r.emoji] = [];
    grouped[r.emoji].push(r);
  });
  let html = '';
  Object.entries(grouped).forEach(([emoji, users]) => {
    const isMine = users.some(u => u.user_id === currentUser.id);
    html += '<span class="reaction-badge' + (isMine ? ' mine' : '') + '" data-emoji="' + emoji + '" data-msg-id="' + msgId + '">' + emoji + ' ' + users.length + '</span>';
  });
  return html;
}

async function updateMessageReactions(msgId) {
  // Reload reactions for this message from server
  if (!currentConversation) return;
  try {
    const res = await fetch('/api/chat/conversations/' + currentConversation.id + '/messages?limit=100', { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json();
    const msgReactions = data.reactions.filter(r => r.message_id === msgId);
    const container = document.querySelector('.reactions[data-msg-id="' + msgId + '"]');
    if (container) container.innerHTML = buildReactionsHtml(msgReactions, msgId);
  } catch(e) {}
}


// ===== EVENT LISTENERS =====
function setupEventListeners() {
  // Theme toggle
  document.getElementById('themeToggle').addEventListener('click', () => {
    setTheme(getTheme() === 'dark' ? 'light' : 'dark');
  });

  // Send message
  sendBtn.addEventListener('click', sendMessage);
  messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // Typing
  let typingTimeout;
  messageInput.addEventListener('input', () => {
    // @mention detection
    if (currentConversation && currentConversation.type === 'group') {
      var val = messageInput.value;
      var cursorPos = messageInput.selectionStart;
      var textBefore = val.substring(0, cursorPos);
      var atMatch = textBefore.match(/@(\w*)$/);
      if (atMatch) {
        showMentionDropdown(atMatch[1]);
      } else {
        hideMentionDropdown();
      }
    } else {
      hideMentionDropdown();
    }

    if (!currentConversation) return;
    socket.emit('typing', { conversation_id: currentConversation.id });
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      socket.emit('stop_typing', { conversation_id: currentConversation.id });
    }, 2000);
  });

  // File attach
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', handleFileUpload);

  // View Once toggle
  document.getElementById('viewOnceToggle').addEventListener('click', toggleViewOnce);

  // Close View Once viewer
  document.getElementById('closeViewOnce').addEventListener('click', closeViewOnceViewer);

  // Voice
  document.getElementById('voiceBtn').addEventListener('click', startRecording);
  document.getElementById('cancelRecording').addEventListener('click', cancelRecording);
  document.getElementById('sendRecording').addEventListener('click', sendRecording);

  // New chat
  document.getElementById('newChatBtn').addEventListener('click', () => showModal('newChatModal'));
  document.getElementById('startChatBtn').addEventListener('click', () => showModal('newChatModal'));
  document.getElementById('closeNewChat').addEventListener('click', () => hideModal('newChatModal'));

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      document.getElementById('privateTab').style.display = e.target.dataset.tab === 'private' ? 'block' : 'none';
      document.getElementById('groupTab').style.display = e.target.dataset.tab === 'group' ? 'block' : 'none';
      var bt = document.getElementById('broadcastTab');
      if (bt) bt.style.display = e.target.dataset.tab === 'broadcast' ? 'block' : 'none';
    });
  });

  // Start private chat
  document.getElementById('startPrivateChat').addEventListener('click', startPrivateChat);
  document.getElementById('privateChatNumber').addEventListener('input', searchUser);
  document.getElementById('createGroupChat').addEventListener('click', createGroup);

  // Back button (mobile)
  document.getElementById('backBtn').addEventListener('click', () => {
    sidebar.classList.remove('hidden');
    activeChat.style.display = 'none';
    emptyState.style.display = 'flex';
    currentConversation = null;
  });

  // Profile
  document.getElementById('userProfileBtn').addEventListener('click', openProfileModal);
  document.getElementById('closeProfile').addEventListener('click', () => hideModal('profileModal'));
  document.getElementById('avatarInput').addEventListener('change', uploadAvatar);
  document.getElementById('saveProfileBtn').addEventListener('click', saveProfile);
  document.getElementById('blockUserBtn').addEventListener('click', blockUser);

  // Search messages
  document.getElementById('searchMsgsBtn').addEventListener('click', () => showModal('searchModal'));
  document.getElementById('closeSearch').addEventListener('click', () => hideModal('searchModal'));
  document.getElementById('msgSearchInput').addEventListener('input', debounce(searchMessages, 500));

  // Search conversations filter
  document.getElementById('searchConversations').addEventListener('input', renderConversations);

  // Chat info
  document.getElementById('chatInfoBtn').addEventListener('click', showChatInfo);
  document.getElementById('closeInfo').addEventListener('click', () => { document.getElementById('infoPanel').style.display = 'none'; });
  if (document.getElementById('chatUserInfoBtn')) document.getElementById('chatUserInfoBtn').addEventListener('click', viewChatUserProfile);

  // Pinned
  document.getElementById('pinnedBtn').addEventListener('click', showPinnedPanel);
  document.getElementById('closePinned').addEventListener('click', () => { document.getElementById('pinnedPanel').style.display = 'none'; });
  document.getElementById('pinnedBarClose').addEventListener('click', () => { document.getElementById('pinnedBar').style.display = 'none'; });

  // Reply cancel
  document.getElementById('replyCancelBtn').addEventListener('click', cancelReply);

  // Logout
  document.getElementById('logoutBtn').addEventListener('click', logout);

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(ov => {
    ov.addEventListener('click', () => {
      document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
    });
  });

  // Close context menu
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.context-menu')) {
      document.getElementById('contextMenu').style.display = 'none';
    }
    if (!e.target.closest('.emoji-picker') && !e.target.closest('.ctx-btn')) {
      document.getElementById('emojiPicker').style.display = 'none';
    }
  });

  // Context menu actions
  document.querySelectorAll('.ctx-btn').forEach(btn => {
    btn.addEventListener('click', () => handleContextAction(btn.dataset.action));
  });

  // Forward modal
  document.getElementById('closeForward').addEventListener('click', () => hideModal('forwardModal'));
  document.getElementById('forwardSendBtn').addEventListener('click', confirmForward);

  // Edit modal
  document.getElementById('closeEdit').addEventListener('click', () => hideModal('editModal'));
  document.getElementById('editSaveBtn').addEventListener('click', confirmEdit);

  // User view modal
  document.getElementById('closeUserView').addEventListener('click', () => hideModal('userViewModal'));

  // Lightbox
  document.getElementById('closeLightbox').addEventListener('click', closeLightbox);
  document.getElementById('lightbox').addEventListener('click', (e) => {
    if (e.target === document.getElementById('lightbox')) closeLightbox();
  });

  // Reaction badge click (delegation)
  messagesContainer.addEventListener('click', (e) => {
    const badge = e.target.closest('.reaction-badge');
    if (badge) {
      const emoji = badge.dataset.emoji;
      const msgId = parseInt(badge.dataset.msgId);
      if (badge.classList.contains('mine')) {
        socket.emit('remove_reaction', { message_id: msgId, conversation_id: currentConversation.id, emoji });
      } else {
        socket.emit('add_reaction', { message_id: msgId, conversation_id: currentConversation.id, emoji });
      }
    }
  });

  // Starred messages
  document.getElementById('starredBtn').addEventListener('click', openStarredModal);
  document.getElementById('closeStarred').addEventListener('click', () => hideModal('starredModal'));

  // Poll
  document.getElementById('pollBtn').addEventListener('click', () => { if (currentConversation && currentConversation.type === 'group') showModal('pollModal'); });
  document.getElementById('closePoll').addEventListener('click', () => hideModal('pollModal'));
  document.getElementById('addPollOption').addEventListener('click', addPollOptionInput);
  document.getElementById('createPollBtn').addEventListener('click', createPoll);

  // Mute modal
  document.getElementById('closeMute').addEventListener('click', () => hideModal('muteModal'));
  document.querySelectorAll('.mute-option').forEach(btn => {
    btn.addEventListener('click', () => muteConversation(btn.dataset.duration));
  });

}

// ===== SEND MESSAGE =====
function sendMessage() {
  const content = messageInput.value.trim();
  if (!content || !currentConversation) return;

  socket.emit('send_message', {
    conversation_id: currentConversation.id,
    content,
    type: 'text',
    reply_to: replyingTo
  });

  messageInput.value = '';
  cancelReply();
  socket.emit('stop_typing', { conversation_id: currentConversation.id });
}

// ===== FILE UPLOAD =====
async function handleFileUpload(e) {
  const file = e.target.files[0];
  if (!file || !currentConversation) return;
  var isMedia = /\.(jpg|jpeg|png|gif|webp|mp4|webm|mov)$/i.test(file.name);

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/api/chat/upload', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      body: formData
    });
    const data = await res.json();
    if (data.url) {
      let type = 'file';
      if (/\.(jpg|jpeg|png|gif|webp)$/i.test(file.name)) type = 'image';
      else if (/\.(mp4|webm|mov)$/i.test(file.name)) type = 'video';

      var viewOnce = isMedia && viewOnceActive;
      socket.emit('send_message', {
        conversation_id: currentConversation.id,
        content: file.name,
        type: type,
        file_url: data.url,
        file_name: file.name,
        reply_to: replyingTo,
        view_once: viewOnce ? 1 : 0
      });
      cancelReply();
      if (viewOnce) toggleViewOnce();
    }
  } catch (err) { console.error(err); }
  fileInput.value = '';
}

// ===== VOICE RECORDING =====
async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
    mediaRecorder.start();
    recordingSeconds = 0;
    document.getElementById('voiceRecording').style.display = 'flex';
    document.querySelector('.message-input-area').style.display = 'none';
    recordingInterval = setInterval(() => {
      recordingSeconds++;
      document.getElementById('recordingTime').textContent = Math.floor(recordingSeconds / 60) + ':' + String(recordingSeconds % 60).padStart(2, '0');
    }, 1000);
  } catch(e) { alert('Microphone access denied'); }
}

function cancelRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  clearInterval(recordingInterval);
  document.getElementById('voiceRecording').style.display = 'none';
  document.querySelector('.message-input-area').style.display = 'flex';
  if (mediaRecorder) mediaRecorder.stream.getTracks().forEach(t => t.stop());
}

async function sendRecording() {
  if (!mediaRecorder || !currentConversation) return;
  mediaRecorder.onstop = async () => {
    const blob = new Blob(audioChunks, { type: 'audio/webm' });
    const formData = new FormData();
    formData.append('voice', blob, 'voice.webm');
    try {
      const res = await fetch('/api/chat/upload/voice', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
        body: formData
      });
      const data = await res.json();
      if (data.url) {
        var voiceViewOnce = viewOnceActive;
        socket.emit('send_message', {
          conversation_id: currentConversation.id,
          content: 'Voice message',
          type: 'voice',
          file_url: data.url,
          file_name: data.name,
          view_once: voiceViewOnce ? 1 : 0
        });
        if (voiceViewOnce) toggleViewOnce();
      }
    } catch(e) { console.error(e); }
  };
  mediaRecorder.stop();
  clearInterval(recordingInterval);
  document.getElementById('voiceRecording').style.display = 'none';
  document.querySelector('.message-input-area').style.display = 'flex';
  mediaRecorder.stream.getTracks().forEach(t => t.stop());
}


// ===== CONTEXT MENU =====
function showContextMenu(e, msgId, convId, isMine, type) {
  contextMessageId = msgId;
  contextConversationId = convId;
  contextIsMine = isMine;
  const menu = document.getElementById('contextMenu');
  menu.style.display = 'block';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  // Show/hide edit (only for own text messages)
  const editBtn = menu.querySelector('[data-action="edit"]');
  editBtn.style.display = (isMine && type === 'text') ? 'block' : 'none';
  // Show/hide delete
  menu.querySelector('[data-action="delete"]').style.display = isMine ? 'block' : 'none';
}

function handleContextAction(action) {
  document.getElementById('contextMenu').style.display = 'none';
  switch(action) {
    case 'reply': startReply(); break;
    case 'edit': openEditModal(); break;
    case 'forward': openForwardModal(); break;
    case 'react': showEmojiPicker(); break;
    case 'star': toggleStarMessage(); break;
    case 'pin': pinMessage(); break;
    case 'info': showMessageInfo(); break;
    case 'delete': deleteMessage(); break;
  }
}

function startReply() {
  const msgEl = document.querySelector('[data-msg-id="' + contextMessageId + '"]');
  if (!msgEl) return;
  const name = msgEl.querySelector('.msg-sender')?.textContent || currentUser.username;
  const content = msgEl.querySelector('.msg-content')?.textContent || '';
  replyingTo = contextMessageId;
  document.getElementById('replyToName').textContent = name;
  document.getElementById('replyToText').textContent = content.substring(0, 60);
  replyPreview.style.display = 'flex';
  messageInput.focus();
}

function cancelReply() {
  replyingTo = null;
  replyPreview.style.display = 'none';
}

// ===== EDIT MESSAGE =====
function openEditModal() {
  const msgEl = document.querySelector('[data-msg-id="' + contextMessageId + '"]');
  if (!msgEl) return;
  const content = msgEl.querySelector('.msg-content')?.textContent || '';
  editingMessageId = contextMessageId;
  document.getElementById('editInput').value = content;
  showModal('editModal');
}

function confirmEdit() {
  const content = document.getElementById('editInput').value.trim();
  if (!content || !editingMessageId) return;
  socket.emit('edit_message', {
    message_id: editingMessageId,
    conversation_id: currentConversation.id,
    content
  });
  hideModal('editModal');
  editingMessageId = null;
}

// ===== FORWARD MESSAGE =====
function openForwardModal() {
  forwardMessageId = contextMessageId;
  selectedForwardConvs = [];
  const list = document.getElementById('forwardConvsList');
  list.innerHTML = '';
  conversations.forEach(conv => {
    const item = document.createElement('div');
    item.className = 'forward-item';
    item.dataset.convId = conv.id;
    const initials = conv.display_name ? conv.display_name.charAt(0).toUpperCase() : '?';
    const avStyle = conv.display_avatar ? 'background-image:url(' + conv.display_avatar + ');background-size:cover;' : '';
    item.innerHTML = '<div class="conv-avatar" style="width:36px;height:36px;font-size:14px;' + avStyle + '">' + (conv.display_avatar ? '' : initials) + '</div>' +
      '<span class="conv-name">' + escapeHtml(conv.display_name || conv.name || 'Chat') + '</span>';
    item.addEventListener('click', () => {
      item.classList.toggle('selected');
      const id = parseInt(item.dataset.convId);
      if (item.classList.contains('selected')) {
        selectedForwardConvs.push(id);
      } else {
        selectedForwardConvs = selectedForwardConvs.filter(c => c !== id);
      }
    });
    list.appendChild(item);
  });
  showModal('forwardModal');
}

function confirmForward() {
  if (!forwardMessageId || selectedForwardConvs.length === 0) return;
  socket.emit('forward_message', { message_id: forwardMessageId, conversation_ids: selectedForwardConvs });
  hideModal('forwardModal');
  forwardMessageId = null;
}

// ===== REACTIONS =====
function showEmojiPicker() {
  const picker = document.getElementById('emojiPicker');
  const menu = document.getElementById('contextMenu');
  picker.style.left = menu.style.left;
  picker.style.top = menu.style.top;
  picker.style.display = 'block';
}

function populateEmojiPicker() {
  const grid = document.getElementById('emojiGrid');
  grid.innerHTML = '';
  EMOJIS.forEach(emoji => {
    const btn = document.createElement('button');
    btn.textContent = emoji;
    btn.addEventListener('click', () => {
      socket.emit('add_reaction', { message_id: contextMessageId, conversation_id: currentConversation.id, emoji });
      document.getElementById('emojiPicker').style.display = 'none';
    });
    grid.appendChild(btn);
  });
}

// ===== PIN/DELETE =====
function pinMessage() {
  socket.emit('pin_message', { message_id: contextMessageId, conversation_id: currentConversation.id });
}

function deleteMessage() {
  if (confirm('Delete this message?')) {
    socket.emit('delete_message', { message_id: contextMessageId, conversation_id: currentConversation.id });
  }
}

// ===== MESSAGE INFO =====
async function showMessageInfo() {
  try {
    const res = await fetch('/api/chat/messages/' + contextMessageId + '/info', { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json();
    const panel = document.getElementById('infoPanel');
    const body = document.getElementById('infoBody');
    body.innerHTML = '<h4 style="margin-bottom:12px;">Message Info</h4>' +
      '<p style="font-size:13px;color:var(--text-muted);margin-bottom:16px;">Sent: ' + formatMsgTime(data.message.created_at) + '</p>' +
      '<h4 style="margin-bottom:8px;">Read by</h4>' +
      (data.read_by.length === 0 ? '<p style="font-size:13px;color:var(--text-muted);">No one yet</p>' :
      data.read_by.map(r => '<div class="member-item"><span class="member-name">' + escapeHtml(r.username) + '</span><span style="font-size:11px;color:var(--text-muted);">' + formatMsgTime(r.read_at) + '</span></div>').join(''));
    panel.style.display = 'flex';
  } catch(e) {}
}

// ===== PINNED PANEL =====
async function showPinnedPanel() {
  try {
    const res = await fetch('/api/chat/conversations/' + currentConversation.id + '/pinned', { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json();
    const panel = document.getElementById('pinnedPanel');
    const body = document.getElementById('pinnedBody');
    if (data.pinned.length === 0) {
      body.innerHTML = '<p style="text-align:center;padding:20px;color:var(--text-muted);">No pinned messages</p>';
    } else {
      body.innerHTML = data.pinned.map(p => '<div class="member-item" style="flex-direction:column;align-items:flex-start;margin-bottom:8px;">' +
        '<span style="font-size:11px;color:var(--accent);">' + escapeHtml(p.sender_name) + '</span>' +
        '<span style="font-size:13px;">' + escapeHtml(p.content || 'File') + '</span>' +
        '<button onclick="unpinMsg(' + p.message_id + ')" style="font-size:11px;color:var(--error);background:none;border:none;cursor:pointer;margin-top:4px;">Unpin</button>' +
        '</div>').join('');
    }
    panel.style.display = 'flex';
  } catch(e) {}
}

function unpinMsg(msgId) {
  socket.emit('unpin_message', { message_id: msgId, conversation_id: currentConversation.id });
  document.getElementById('pinnedPanel').style.display = 'none';
}

// ===== PROFILE =====
async function openProfileModal() {
  document.getElementById('profileUsername').value = currentUser.username;
  document.getElementById('profileBio').value = currentUser.bio || '';
  document.getElementById('profileStatusMsg').value = currentUser.status_message || '';
  document.getElementById('profileEmail').textContent = currentUser.email;
  document.getElementById('profileChatNum').textContent = '#' + currentUser.chat_number;
  const av = document.getElementById('profileAvatar');
  av.textContent = currentUser.username.charAt(0).toUpperCase();
  if (currentUser.avatar) {
    av.style.backgroundImage = 'url(' + currentUser.avatar + ')';
    av.style.backgroundSize = 'cover';
    av.textContent = '';
  }
  await loadBlockedUsers();
  loadTwoStepStatus();
  showModal('profileModal');
}

async function saveProfile() {
  const username = document.getElementById('profileUsername').value.trim();
  const bio = document.getElementById('profileBio').value;
  const status_message = document.getElementById('profileStatusMsg').value;
  try {
    const res = await fetch('/api/auth/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ username, bio, status_message })
    });
    const data = await res.json();
    if (res.ok) {
      currentUser = { ...currentUser, ...data.user };
      localStorage.setItem('user', JSON.stringify(currentUser));
      document.getElementById('myUsername').textContent = currentUser.username;
      hideModal('profileModal');
    } else { alert(data.error); }
  } catch(e) { alert('Error saving profile'); }
}

async function uploadAvatar(e) {
  const file = e.target.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('avatar', file);
  try {
    const res = await fetch('/api/auth/avatar', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      body: formData
    });
    const data = await res.json();
    if (data.avatar) {
      currentUser.avatar = data.avatar;
      localStorage.setItem('user', JSON.stringify(currentUser));
      const av = document.getElementById('profileAvatar');
      av.style.backgroundImage = 'url(' + data.avatar + ')';
      av.style.backgroundSize = 'cover';
      av.textContent = '';
      const myAv = document.getElementById('myAvatar');
      myAv.style.backgroundImage = 'url(' + data.avatar + ')';
      myAv.style.backgroundSize = 'cover';
      myAv.textContent = '';
    }
  } catch(e) {}
}

// ===== VIEW USER PROFILE =====
async function viewChatUserProfile() {
  if (!currentConversation || currentConversation.type !== 'private') return;
  const userId = currentConversation.display_user_id;
  if (!userId) return;
  try {
    const res = await fetch('/api/auth/users/' + userId, { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json();
    if (data.user) showUserProfile(data.user);
  } catch(e) {}
}

function showUserProfile(user) {
  var body = document.getElementById('userViewBody');
  var avStyle = user.avatar ? 'background-image:url(' + user.avatar + ');background-size:cover;' : '';
  var avText = user.avatar ? '' : user.username.charAt(0).toUpperCase();
  var statusText = user.status === 'online' ? 'Online' : 'Last seen ' + formatLastSeen(user.last_seen);
  var joined = user.created_at ? 'Joined ' + new Date(user.created_at).toLocaleDateString() : '';

  body.innerHTML = '<div style="text-align:center;padding:20px 0;">' +
    '<div class="profile-avatar" style="width:80px;height:80px;border-radius:50%;margin:0 auto 12px;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:700;background:var(--surface);' + avStyle + '">' + avText + '</div>' +
    '<h3 style="margin-bottom:4px;">' + escapeHtml(user.username) + '</h3>' +
    '<p style="color:var(--text-muted);font-size:13px;">#' + user.chat_number + '</p>' +
    '<p style="color:var(--accent);font-size:13px;margin-top:4px;">' + statusText + '</p>' +
    '</div>' +
    '<div style="padding:0 20px;">' +
    (user.bio ? '<div style="margin-bottom:12px;"><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase;">Bio</label><p style="font-size:14px;">' + escapeHtml(user.bio) + '</p></div>' : '') +
    (user.status_message ? '<div style="margin-bottom:12px;"><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase;">Status</label><p style="font-size:14px;">' + escapeHtml(user.status_message) + '</p></div>' : '') +
    '<p style="font-size:12px;color:var(--text-muted);margin-top:16px;">' + joined + '</p>' +
    '</div>';
  showModal('userViewModal');
}

// ===== BLOCKED USERS =====
async function loadBlockedUsers() {
  try {
    const res = await fetch('/api/chat/blocked', { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json();
    const list = document.getElementById('blockedList');
    if (data.blocked.length === 0) {
      list.innerHTML = '<p style="font-size:12px;color:var(--text-muted);">No blocked users</p>';
    } else {
      list.innerHTML = data.blocked.map(u => '<div class="member-item"><span class="member-name">' + escapeHtml(u.username) + '</span>' +
        '<button class="remove-member-btn" onclick="unblockUser(' + u.id + ')">\u{2715}</button></div>').join('');
    }
  } catch(e) {}
}

async function blockUser() {
  const chatNum = document.getElementById('blockInput').value.trim();
  if (!chatNum) return;
  try {
    const res = await fetch('/api/chat/block', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ chat_number: chatNum })
    });
    const data = await res.json();
    if (res.ok) {
      document.getElementById('blockInput').value = '';
      loadBlockedUsers();
    } else { alert(data.error); }
  } catch(e) {}
}

async function unblockUser(userId) {
  try {
    await fetch('/api/chat/block/' + userId, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } });
    loadBlockedUsers();
  } catch(e) {}
}

// ===== CHAT INFO =====
async function showChatInfo() {
  const panel = document.getElementById('infoPanel');
  const body = document.getElementById('infoBody');

  // Common controls (archive, mute, disappearing)
  var commonHtml = '<div class="info-actions" style="margin-bottom:16px;display:flex;flex-direction:column;gap:8px;">';
  commonHtml += '<button class="btn-info-action" onclick="archiveConversation(' + currentConversation.id + ')">&#128451; ' + (currentConversation.archived ? 'Unarchive' : 'Archive') + ' Chat</button>';
  commonHtml += '<button class="btn-info-action" onclick="openMuteModal()">&#128263; Mute Notifications</button>';
  commonHtml += '<button class="btn-info-action" onclick="showWallpaperPicker()">&#127912; Chat Wallpaper</button>';
  commonHtml += '<button class="btn-info-action" onclick="exportChat()">&#128228; Export Chat</button>';
  var timerVal = currentConversation.disappearing_timer || 0;
  var timerLabel = timerVal === 0 ? 'Off' : (timerVal === 86400 ? '24 hours' : (timerVal === 604800 ? '7 days' : '90 days'));
  commonHtml += '<div class="info-disappearing"><span style="font-size:13px;">&#9201; Disappearing messages: <strong>' + timerLabel + '</strong></span>';
  commonHtml += '<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">';
  commonHtml += '<button class="btn-timer' + (timerVal === 0 ? ' active' : '') + '" onclick="setDisappearingTimer(0)">Off</button>';
  commonHtml += '<button class="btn-timer' + (timerVal === 86400 ? ' active' : '') + '" onclick="setDisappearingTimer(86400)">24h</button>';
  commonHtml += '<button class="btn-timer' + (timerVal === 604800 ? ' active' : '') + '" onclick="setDisappearingTimer(604800)">7d</button>';
  commonHtml += '<button class="btn-timer' + (timerVal === 7776000 ? ' active' : '') + '" onclick="setDisappearingTimer(7776000)">90d</button>';
  commonHtml += '</div></div></div><hr style="border:none;border-top:1px solid var(--border);margin-bottom:16px;">';

  if (currentConversation.type === 'group') {
    try {
      const res = await fetch('/api/chat/conversations/' + currentConversation.id + '/members', { headers: { 'Authorization': 'Bearer ' + token } });
      const data = await res.json();
      const isAdmin = data.members.some(m => m.id === currentUser.id && m.role === 'admin');
      
      let html = '<div style="text-align:center;margin-bottom:20px;">';
      html += '<h3>' + escapeHtml(currentConversation.name || 'Group') + '</h3>';
      html += '<p style="font-size:13px;color:var(--text-muted);">' + data.members.length + ' members</p>';

      // Group Description
      var desc = currentConversation.description || '';
      if (isAdmin) {
        html += '<div style="margin-top:12px;text-align:left;"><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase;display:block;margin-bottom:4px;">Description</label>';
        html += '<textarea id="groupDescInput" rows="2" style="width:100%;padding:8px;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;outline:none;resize:none;font-family:inherit;" placeholder="Add group description...">' + escapeHtml(desc) + '</textarea>';
        html += '<button onclick="updateGroupDescription('+currentConversation.id+', document.getElementById(\'groupDescInput\').value)" style="margin-top:6px;padding:6px 12px;background:var(--accent);border:none;border-radius:6px;color:#fff;font-size:12px;cursor:pointer;">Save</button></div>';
      } else if (desc) {
        html += '<p style="margin-top:8px;font-size:13px;color:var(--text-secondary);font-style:italic;">' + escapeHtml(desc) + '</p>';
      }

      if (isAdmin) {
        var lockStatus = currentConversation.locked ? true : false;
        html += '<div style="margin-top:12px;"><button class="btn-lock" onclick="toggleGroupLock()">' + (lockStatus ? '&#128275; Unlock Group' : '&#128274; Lock Group') + '</button></div>';
        html += '<div class="input-group" style="margin-top:12px;text-align:left;"><label>Add Member</label><input type="text" id="addMemberInput" placeholder="Chat number"><button class="btn-primary" style="margin-top:8px;" onclick="addGroupMember()">Add</button></div>';
      }
      if (currentConversation.locked) {
        html += '<p style="font-size:12px;color:var(--error);margin-top:8px;">&#128274; Group is locked — only admins can message</p>';
      }
      html += '</div>';
      html += '<h4 style="margin-bottom:8px;">Members</h4>';
      data.members.forEach(m => {
        html += '<div class="member-item"><span class="member-name">' + escapeHtml(m.username) + '</span>';
        if (m.role === 'admin') html += '<span class="member-role">Admin</span>';
        if (isAdmin && m.id !== currentUser.id) {
          var roleBtn = m.role === 'admin' ? '<button class="role-toggle-btn" onclick="toggleMemberRole(' + m.id + ',\'member\')" title="Remove Admin">&#9660; Remove Admin</button>' : '<button class="role-toggle-btn" onclick="toggleMemberRole(' + m.id + ',\'admin\')" title="Make Admin">&#9650; Make Admin</button>';
          html += roleBtn;
          html += '<button class="remove-member-btn" onclick="removeGroupMember(' + m.id + ')">\u{2715}</button>';
        }
        html += '</div>';
      });

      // Invite Link (admin only)
      if (isAdmin) {
        var inviteHtml = await showInviteLink(currentConversation.id);
        html += inviteHtml;
      }

      body.innerHTML = commonHtml + html;
    } catch(e) { body.innerHTML = '<p>Error loading info</p>'; }
  } else {
    body.innerHTML = commonHtml + '<p style="text-align:center;color:var(--text-muted);">Private conversation</p>';
  }
  panel.style.display = 'flex';
}

async function addGroupMember() {
  const input = document.getElementById('addMemberInput');
  const chatNum = input.value.trim();
  if (!chatNum) return;
  try {
    const res = await fetch('/api/chat/conversations/' + currentConversation.id + '/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ chat_number: chatNum })
    });
    const data = await res.json();
    if (res.ok) {
      input.value = '';
      showChatInfo();
      socket.emit('member_added', { conversation_id: currentConversation.id, user_id: data.user.id, username: data.user.username });
    } else { alert(data.error); }
  } catch(e) {}
}

async function removeGroupMember(userId) {
  if (!confirm('Remove this member?')) return;
  try {
    const res = await fetch('/api/chat/conversations/' + currentConversation.id + '/members/' + userId, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (res.ok) {
      showChatInfo();
      socket.emit('member_removed', { conversation_id: currentConversation.id, user_id: userId });
    }
  } catch(e) {}
}

async function toggleMemberRole(userId, newRole) {
  var action = newRole === 'admin' ? 'Make this member an admin?' : 'Remove admin privileges from this member?';
  if (!confirm(action)) return;
  try {
    var res = await fetch('/api/chat/conversations/' + currentConversation.id + '/members/' + userId + '/role', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ role: newRole })
    });
    var data = await res.json();
    if (res.ok) {
      showChatInfo();
    } else { alert(data.error); }
  } catch(e) {}
}

async function toggleGroupLock() {
  var isLocked = currentConversation.locked ? true : false;
  var action = isLocked ? 'Unlock the group so all members can message?' : 'Lock the group so only admins can message?';
  if (!confirm(action)) return;
  try {
    var res = await fetch('/api/chat/conversations/' + currentConversation.id + '/lock', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ locked: !isLocked })
    });
    var data = await res.json();
    if (res.ok) {
      currentConversation.locked = !isLocked;
      showChatInfo();
      updateInputLockState();
    } else { alert(data.error); }
  } catch(e) {}
}

function updateInputLockState() {
  var input = document.getElementById('messageInput');
  var sendBtn = document.getElementById('sendBtn');
  if (currentConversation && currentConversation.type === 'group' && currentConversation.locked) {
    // Check if user is admin
    fetch('/api/chat/conversations/' + currentConversation.id + '/members', { headers: { 'Authorization': 'Bearer ' + token } })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var isAdmin = data.members.some(function(m) { return m.id === currentUser.id && m.role === 'admin'; });
        if (!isAdmin) {
          input.disabled = true;
          input.placeholder = 'Group is locked — only admins can message';
          sendBtn.disabled = true;
        } else {
          input.disabled = false;
          input.placeholder = 'Type a message...';
          sendBtn.disabled = false;
        }
      });
  } else {
    input.disabled = false;
    input.placeholder = 'Type a message...';
    sendBtn.disabled = false;
  }
}

// ===== @MENTION AUTOCOMPLETE =====
var mentionDropdown = null;
var groupMembers = [];

function showMentionDropdown(query) {
  if (!mentionDropdown) {
    mentionDropdown = document.createElement('div');
    mentionDropdown.className = 'mention-dropdown';
    document.querySelector('.message-input-area').appendChild(mentionDropdown);
  }
  var filtered = groupMembers.filter(function(m) {
    return m.username.toLowerCase().startsWith(query.toLowerCase()) && m.id !== currentUser.id;
  });
  if (query === '') {
    filtered = [{ username: 'everyone', id: 'everyone' }].concat(groupMembers.filter(function(m) { return m.id !== currentUser.id; }));
  }
  if (filtered.length === 0) { hideMentionDropdown(); return; }
  mentionDropdown.innerHTML = filtered.slice(0, 6).map(function(m) {
    return '<div class="mention-option" data-name="' + escapeHtml(m.username) + '">' + (m.username === 'everyone' ? '<strong>@everyone</strong>' : '@' + escapeHtml(m.username)) + '</div>';
  }).join('');
  mentionDropdown.style.display = 'block';
}

function hideMentionDropdown() {
  if (mentionDropdown) mentionDropdown.style.display = 'none';
}

// ===== SEARCH =====
async function searchUser() {
  const q = document.getElementById('privateChatNumber').value.trim();
  const container = document.getElementById('userSearchResult');
  if (!q || q.length < 3) { container.innerHTML = ''; return; }
  try {
    const res = await fetch('/api/chat/users/search?q=' + encodeURIComponent(q), { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json();
    if (data.users.length > 0) {
      container.innerHTML = data.users.map(u => '<div style="padding:8px;display:flex;align-items:center;gap:8px;"><strong>' + escapeHtml(u.username) + '</strong><span style="color:var(--text-muted);font-size:12px;">#' + u.chat_number + '</span></div>').join('');
    } else {
      container.innerHTML = '<p style="font-size:12px;color:var(--text-muted);padding:8px;">No users found</p>';
    }
  } catch(e) {}
}

async function startPrivateChat() {
  const chatNum = document.getElementById('privateChatNumber').value.trim();
  if (!chatNum) return;
  try {
    const res = await fetch('/api/chat/conversations/private', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ chat_number: chatNum })
    });
    const data = await res.json();
    if (res.ok) {
      hideModal('newChatModal');
      await loadConversations();
      const conv = conversations.find(c => c.id === data.conversation_id);
      if (conv) openConversation(conv);
    } else { alert(data.error); }
  } catch(e) {}
}

async function createGroup() {
  const name = document.getElementById('groupName').value.trim();
  const membersStr = document.getElementById('groupMembers').value.trim();
  if (!name || !membersStr) return;
  const members = membersStr.split(',').map(s => s.trim()).filter(s => s);
  try {
    const res = await fetch('/api/chat/conversations/group', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ name, members })
    });
    if (res.ok) {
      hideModal('newChatModal');
      loadConversations();
    } else {
      const data = await res.json();
      alert(data.error);
    }
  } catch(e) {}
}

async function searchMessages() {
  const q = document.getElementById('msgSearchInput').value.trim();
  const container = document.getElementById('searchResults');
  if (!q) { container.innerHTML = ''; return; }
  try {
    const res = await fetch('/api/chat/messages/search?q=' + encodeURIComponent(q), { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json();
    container.innerHTML = data.messages.map(m => '<div class="search-result-item" onclick="goToConv(' + m.conversation_id + ')">' +
      '<div class="result-conv">' + escapeHtml(m.display_conv_name || 'Chat') + '</div>' +
      '<div class="result-text">' + escapeHtml(m.content || '') + '</div>' +
      '<div class="result-time">' + formatMsgTime(m.created_at) + ' - ' + escapeHtml(m.sender_name) + '</div>' +
      '</div>').join('') || '<p style="text-align:center;color:var(--text-muted);padding:20px;">No results</p>';
  } catch(e) {}
}

function goToConv(convId) {
  hideModal('searchModal');
  const conv = conversations.find(c => c.id === convId);
  if (conv) openConversation(conv);
}

// ===== LIGHTBOX =====
function openLightbox(src) {
  document.getElementById('lightboxImg').src = src;
  document.getElementById('lightbox').style.display = 'flex';
}

// ===== VIEW ONCE =====
async function openViewOnce(msgId, el) {
  if (el.classList.contains('opened')) return;
  try {
    var res = await fetch('/api/chat/messages/' + msgId + '/view-once', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var data = await res.json();
    if (res.ok && data.file_url) {
      // Open full-screen viewer
      var viewer = document.getElementById('viewOnceViewer');
      var contentEl = document.getElementById('viewOnceContent');
      if (data.type === 'voice') {
        contentEl.innerHTML = '<audio src="' + data.file_url + '" autoplay controls style="width:80%;max-width:400px;"></audio>';
      } else if (data.type === 'video') {
        contentEl.innerHTML = '<video src="' + data.file_url + '" autoplay playsinline controls style="max-width:90vw;max-height:80vh;border-radius:8px;"></video>';
      } else {
        contentEl.innerHTML = '<img src="' + data.file_url + '" style="max-width:90vw;max-height:80vh;border-radius:8px;object-fit:contain;">';
      }
      viewer.style.display = 'flex';
      el.classList.add('opened');
      el.innerHTML = '<em style="color:var(--text-muted);">&#128065; Opened</em>';
    } else {
      el.innerHTML = '<em style="color:var(--text-muted);">&#128065; Opened</em>';
    }
  } catch(e) {
    el.innerHTML = '<em style="color:var(--text-muted);">Failed to load</em>';
  }
}

function toggleViewOnce() {
  viewOnceActive = !viewOnceActive;
  var btn = document.getElementById('viewOnceToggle');
  if (viewOnceActive) {
    btn.classList.add('active');
    btn.title = 'View once ON — next media will be view once';
  } else {
    btn.classList.remove('active');
    btn.title = 'Toggle view once';
  }
}

function closeViewOnceViewer() {
  var viewer = document.getElementById('viewOnceViewer');
  var contentEl = document.getElementById('viewOnceContent');
  var videos = contentEl.querySelectorAll('video');
  var audios = contentEl.querySelectorAll('audio');
  videos.forEach(function(v) { v.pause(); v.src = ''; });
  audios.forEach(function(a) { a.pause(); a.src = ''; });
  contentEl.innerHTML = '';
  viewer.style.display = 'none';
}

function closeLightbox() {
  document.getElementById('lightbox').style.display = 'none';
  document.getElementById('lightboxImg').src = '';
}

// ===== LOGOUT =====
async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch(e) {}
  localStorage.clear();
  window.location.href = '/';
}

// ===== UTILITIES =====
function showModal(id) { document.getElementById(id).style.display = 'flex'; }
function hideModal(id) { document.getElementById(id).style.display = 'none'; }

function escapeHtml(s) {
  if (!s) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function linkify(text) {
  return text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" style="color:inherit;text-decoration:underline;">$1</a>');
}

function highlightMentions(text) {
  text = text.replace(/@everyone/g, '<span class="mention mention-everyone">@everyone</span>');
  text = text.replace(/@(\w+)/g, '<span class="mention">@$1</span>');
  return text;
}

function getFileIcon(name) {
  if (!name) return '\u{1F4C4}';
  const ext = name.split('.').pop().toLowerCase();
  if (['pdf'].includes(ext)) return '\u{1F4D5}';
  if (['doc', 'docx'].includes(ext)) return '\u{1F4DD}';
  if (['zip', 'rar', '7z'].includes(ext)) return '\u{1F4E6}';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '\u{1F4CA}';
  if (['mp3', 'wav', 'ogg'].includes(ext)) return '\u{1F3B5}';
  return '\u{1F4C4}';
}

function formatTime(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatMsgTime(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatLastSeen(dateStr) {
  if (!dateStr) return 'unknown';
  const d = new Date(dateStr);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function scrollToBottom() {
  setTimeout(() => {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }, 50);
}

function debounce(fn, delay) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// Mention dropdown click handler
document.addEventListener('click', function(e) {
  if (e.target.classList.contains('mention-option')) {
    var name = e.target.getAttribute('data-name');
    var input = document.getElementById('messageInput');
    var val = input.value;
    var cursorPos = input.selectionStart;
    var textBefore = val.substring(0, cursorPos);
    var textAfter = val.substring(cursorPos);
    var newBefore = textBefore.replace(/@\w*$/, '@' + name + ' ');
    input.value = newBefore + textAfter;
    input.focus();
    input.selectionStart = input.selectionEnd = newBefore.length;
    hideMentionDropdown();
  } else if (!e.target.closest('.mention-dropdown')) {
    hideMentionDropdown();
  }
});

// ===== STATUS/STORIES =====
const STATUS_GRADIENTS = [
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

let statusFeed = [];
let myStatuses = [];
let currentStatusUser = null;
let currentStatusIndex = 0;
let statusTimer = null;
let selectedGradient = STATUS_GRADIENTS[0];
let statusMediaFile = null;
let statusType = 'text';

async function loadStatusFeed() {
  try {
    var res = await fetch('/api/status/feed', { headers: { 'Authorization': 'Bearer ' + token } });
    var data = await res.json();
    statusFeed = data.feed || [];

    var mineRes = await fetch('/api/status/mine', { headers: { 'Authorization': 'Bearer ' + token } });
    var mineData = await mineRes.json();
    myStatuses = mineData.statuses || [];

    renderStatusBar();
  } catch(e) { console.error('Status feed error:', e); }
}

function renderStatusBar() {
  var bar = document.getElementById('statusBar');
  if (!bar) return;
  var html = '';

  // My status
  var myAvStyle = currentUser.avatar ? 'background-image:url(' + currentUser.avatar + ');background-size:cover;' : '';
  var myAvText = currentUser.avatar ? '' : currentUser.username.charAt(0).toUpperCase();
  var myRingClass = myStatuses.length > 0 ? '<div class="status-avatar-ring"></div>' : '';
  html += '<div class="status-item" onclick="' + (myStatuses.length > 0 ? 'openStatusViewer(\'mine\')' : 'openStatusCreate()') + '">';
  html += '<div class="status-avatar" style="' + myAvStyle + '">' + myAvText + myRingClass;
  if (myStatuses.length === 0) html += '<div class="status-add-btn">+</div>';
  html += '</div>';
  html += '<span class="status-item-name">My Status</span></div>';

  // Friends' statuses
  statusFeed.forEach(function(userGroup) {
    var avStyle = userGroup.avatar ? 'background-image:url(' + userGroup.avatar + ');background-size:cover;' : '';
    var avText = userGroup.avatar ? '' : userGroup.username.charAt(0).toUpperCase();
    var viewedClass = userGroup.has_unviewed ? '' : ' viewed';
    html += '<div class="status-item' + viewedClass + '" onclick="openStatusViewer(\'' + userGroup.user_id + '\')">';
    html += '<div class="status-avatar" style="' + avStyle + '">' + avText + '<div class="status-avatar-ring"></div></div>';
    html += '<span class="status-item-name">' + escapeHtml(userGroup.username) + '</span></div>';
  });

  bar.innerHTML = html;
}

function openStatusCreate() {
  showModal('statusCreateModal');
  loadStatusFriends();
  statusType = 'text';
  statusMediaFile = null;
  selectedGradient = STATUS_GRADIENTS[0];
  renderGradientPicker();
  document.getElementById('statusTextForm').style.display = 'block';
  document.getElementById('statusMediaForm').style.display = 'none';
  document.getElementById('statusMediaPreview').style.display = 'none';
  document.getElementById('statusTextInput').value = '';
  document.getElementById('statusCaptionInput').value = '';
  document.querySelectorAll('.status-type-btn').forEach(function(b) { b.classList.remove('active'); });
  document.querySelector('.status-type-btn[data-type="text"]').classList.add('active');
}

function renderGradientPicker() {
  var picker = document.getElementById('gradientPicker');
  picker.innerHTML = STATUS_GRADIENTS.map(function(g, i) {
    return '<div class="gradient-swatch' + (g === selectedGradient ? ' active' : '') + '" style="background:' + g + ';" data-idx="' + i + '"></div>';
  }).join('');
}

// Status type tabs
document.addEventListener('click', function(e) {
  if (e.target.classList.contains('status-type-btn')) {
    document.querySelectorAll('.status-type-btn').forEach(function(b) { b.classList.remove('active'); });
    e.target.classList.add('active');
    statusType = e.target.getAttribute('data-type');
    if (statusType === 'text') {
      document.getElementById('statusTextForm').style.display = 'block';
      document.getElementById('statusMediaForm').style.display = 'none';
    } else {
      document.getElementById('statusTextForm').style.display = 'none';
      document.getElementById('statusMediaForm').style.display = 'block';
      var mediaInput = document.getElementById('statusMediaInput');
      mediaInput.accept = statusType === 'image' ? 'image/*' : 'video/*';
    }
  }
  if (e.target.classList.contains('gradient-swatch')) {
    var idx = parseInt(e.target.getAttribute('data-idx'));
    selectedGradient = STATUS_GRADIENTS[idx];
    document.querySelectorAll('.gradient-swatch').forEach(function(s) { s.classList.remove('active'); });
    e.target.classList.add('active');
  }
});

// Media input change
document.getElementById('statusMediaInput').addEventListener('change', function(e) {
  var file = e.target.files[0];
  if (!file) return;
  statusMediaFile = file;
  var preview = document.getElementById('statusMediaPreview');
  if (file.type.startsWith('image/')) {
    preview.innerHTML = '<img src="' + URL.createObjectURL(file) + '">';
  } else {
    preview.innerHTML = '<video src="' + URL.createObjectURL(file) + '" controls></video>';
  }
  preview.style.display = 'block';
  document.getElementById('statusMediaArea').style.display = 'none';
});

// Post status
document.getElementById('postStatusBtn').addEventListener('click', async function() {
  var formData = new FormData();
  formData.append('type', statusType);

  if (statusType === 'text') {
    var text = document.getElementById('statusTextInput').value.trim();
    if (!text) return alert('Please enter some text');
    formData.append('content', text);
    formData.append('bg_gradient', selectedGradient);
    // Extract mentions
    var mentions = text.match(/@(\w+)/g) || [];
    formData.append('mentions', JSON.stringify(mentions.map(function(m) { return m.substring(1); })));
  } else {
    if (!statusMediaFile) return alert('Please select a file');
    formData.append('media', statusMediaFile);
    var caption = document.getElementById('statusCaptionInput').value.trim();
    if (caption) {
      formData.append('content', caption);
      var capMentions = caption.match(/@(\w+)/g) || [];
      formData.append('mentions', JSON.stringify(capMentions.map(function(m) { return m.substring(1); })));
    }
  }

  try {
    var res = await fetch('/api/status', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      body: formData
    });
    var data = await res.json();
    if (res.ok) {
      hideModal('statusCreateModal');
      loadStatusFeed();
    } else { alert(data.error); }
  } catch(e) { alert('Error posting status'); }
});

// Close status create
document.getElementById('closeStatusCreate').addEventListener('click', function() { hideModal('statusCreateModal'); });

// Status @mention autocomplete
var statusFriends = [];
async function loadStatusFriends() {
  try {
    var res = await fetch('/api/chat/conversations', { headers: { 'Authorization': 'Bearer ' + token } });
    var data = await res.json();
    var friendMap = {};
    (data.conversations || []).forEach(function(c) {
      if (c.type === 'private' && c.display_name) {
        friendMap[c.display_name] = { username: c.display_name, chat_number: c.display_chat_number };
      }
    });
    statusFriends = Object.values(friendMap);
  } catch(e) { statusFriends = []; }
}

function handleStatusMention(inputEl) {
  var val = inputEl.value;
  var cursorPos = inputEl.selectionStart;
  var textBefore = val.substring(0, cursorPos);
  var atMatch = textBefore.match(/@(\w*)$/);
  var dropdown = document.getElementById('statusMentionDropdown');
  if (atMatch) {
    var query = atMatch[1].toLowerCase();
    var filtered = statusFriends.filter(function(f) {
      return f.username.toLowerCase().startsWith(query);
    }).slice(0, 6);
    if (filtered.length === 0) { dropdown.style.display = 'none'; return; }
    dropdown.innerHTML = filtered.map(function(f) {
      return '<div class="mention-option" data-name="' + escapeHtml(f.username) + '">@' + escapeHtml(f.username) + '</div>';
    }).join('');
    dropdown.style.display = 'block';
    dropdown.setAttribute('data-target', inputEl.id);
  } else {
    dropdown.style.display = 'none';
  }
}

document.getElementById('statusTextInput').addEventListener('input', function() { handleStatusMention(this); });
document.getElementById('statusCaptionInput').addEventListener('input', function() { handleStatusMention(this); });

document.getElementById('statusMentionDropdown').addEventListener('click', function(e) {
  if (e.target.classList.contains('mention-option')) {
    var name = e.target.getAttribute('data-name');
    var targetId = this.getAttribute('data-target');
    var input = document.getElementById(targetId);
    var val = input.value;
    var cursorPos = input.selectionStart;
    var textBefore = val.substring(0, cursorPos);
    var textAfter = val.substring(cursorPos);
    var newBefore = textBefore.replace(/@\w*$/, '@' + name + ' ');
    input.value = newBefore + textAfter;
    input.focus();
    input.selectionStart = input.selectionEnd = newBefore.length;
    this.style.display = 'none';
  }
});

// Status Viewer
async function openStatusViewer(userId) {
  var viewer = document.getElementById('statusViewer');
  viewer.style.display = 'flex';

  if (userId === 'mine') {
    currentStatusUser = { user_id: currentUser.id, username: currentUser.username, avatar: currentUser.avatar, statuses: myStatuses };
  } else {
    currentStatusUser = statusFeed.find(function(u) { return u.user_id == userId; });
  }

  if (!currentStatusUser || currentStatusUser.statuses.length === 0) {
    viewer.style.display = 'none';
    if (userId === 'mine') openStatusCreate();
    return;
  }

  currentStatusIndex = 0;
  showCurrentStatus();
}

function showCurrentStatus() {
  var s = currentStatusUser.statuses[currentStatusIndex];
  if (!s) { closeStatusViewer(); return; }

  // Update header
  var avEl = document.getElementById('statusViewerAvatar');
  if (currentStatusUser.avatar) {
    avEl.style.backgroundImage = 'url(' + currentStatusUser.avatar + ')';
    avEl.textContent = '';
  } else {
    avEl.style.backgroundImage = '';
    avEl.textContent = currentStatusUser.username.charAt(0).toUpperCase();
  }
  document.getElementById('statusViewerName').textContent = currentStatusUser.username;
  document.getElementById('statusViewerTime').textContent = formatStatusTime(s.created_at);

  // Progress bar
  var progressHtml = '';
  for (var i = 0; i < currentStatusUser.statuses.length; i++) {
    var cls = i < currentStatusIndex ? 'done' : (i === currentStatusIndex ? 'active' : '');
    progressHtml += '<div class="status-progress-seg ' + cls + '"><div class="fill"></div></div>';
  }
  document.getElementById('statusProgress').innerHTML = progressHtml;

  // Content
  var contentEl = document.getElementById('statusViewerContent');
  stopStatusMedia();
  var captionHtml = '';
  if (s.type === 'text') {
    var bg = s.bg_gradient || STATUS_GRADIENTS[0];
    var textContent = highlightMentions(escapeHtml(s.content || ''));
    contentEl.innerHTML = '<div class="status-text-display" style="background:' + bg + ';">' + textContent + '</div>';
  } else if (s.type === 'image') {
    contentEl.innerHTML = '<img src="' + s.media_url + '">';
    if (s.content) captionHtml = '<div class="status-caption">' + highlightMentions(escapeHtml(s.content)) + '</div>';
  } else if (s.type === 'video') {
    contentEl.innerHTML = '<video src="' + s.media_url + '" autoplay playsinline></video>';
    if (s.content) captionHtml = '<div class="status-caption">' + highlightMentions(escapeHtml(s.content)) + '</div>';
  }
  if (captionHtml) contentEl.innerHTML += captionHtml;

  // Views (only for own statuses)
  var viewsBtn = document.getElementById('statusViewsBtn');
  var replyArea = document.getElementById('statusReplyArea');
  if (currentStatusUser.user_id === currentUser.id) {
    viewsBtn.style.display = 'inline-flex';
    document.getElementById('statusViewCount').textContent = s.view_count || 0;
    replyArea.style.display = 'none';
  } else {
    viewsBtn.style.display = 'none';
    replyArea.style.display = 'flex';
    // Mark as viewed
    fetch('/api/status/' + s.id + '/view', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    }).catch(function() {});
  }

  // Auto-advance timer
  clearTimeout(statusTimer);
  var duration = s.type === 'text' ? 5000 : (s.type === 'image' ? 7000 : 15000);
  // Animate progress
  var activeSeg = document.querySelector('.status-progress-seg.active .fill');
  if (activeSeg) {
    activeSeg.style.transition = 'width ' + duration + 'ms linear';
    setTimeout(function() { activeSeg.style.width = '100%'; }, 50);
  }
  statusTimer = setTimeout(function() { nextStatus(); }, duration);
}

function nextStatus() {
  if (currentStatusIndex < currentStatusUser.statuses.length - 1) {
    currentStatusIndex++;
    showCurrentStatus();
  } else {
    closeStatusViewer();
  }
}

function prevStatus() {
  if (currentStatusIndex > 0) {
    currentStatusIndex--;
    showCurrentStatus();
  }
}

function closeStatusViewer() {
  clearTimeout(statusTimer);
  stopStatusMedia();
  document.getElementById('statusViewer').style.display = 'none';
  document.getElementById('statusViewersPanel').style.display = 'none';
  loadStatusFeed();
}

function stopStatusMedia() {
  var contentEl = document.getElementById('statusViewerContent');
  var videos = contentEl.querySelectorAll('video');
  var audios = contentEl.querySelectorAll('audio');
  videos.forEach(function(v) { v.pause(); v.src = ''; v.load(); });
  audios.forEach(function(a) { a.pause(); a.src = ''; a.load(); });
}

document.getElementById('statusNavRight').addEventListener('click', nextStatus);
document.getElementById('statusNavLeft').addEventListener('click', prevStatus);
document.getElementById('closeStatusViewer').addEventListener('click', closeStatusViewer);

// Views panel
document.getElementById('statusViewsBtn').addEventListener('click', async function() {
  var s = currentStatusUser.statuses[currentStatusIndex];
  clearTimeout(statusTimer);
  try {
    var res = await fetch('/api/status/' + s.id + '/views', { headers: { 'Authorization': 'Bearer ' + token } });
    var data = await res.json();
    var panel = document.getElementById('statusViewersPanel');
    var list = document.getElementById('statusViewersList');
    if (data.viewers.length === 0) {
      list.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px;">No views yet</p>';
    } else {
      list.innerHTML = data.viewers.map(function(v) {
        var vAvStyle = v.avatar ? 'background-image:url(' + v.avatar + ');background-size:cover;' : '';
        var vAvText = v.avatar ? '' : v.username.charAt(0).toUpperCase();
        return '<div class="status-viewer-item"><div class="viewer-avatar" style="' + vAvStyle + '">' + vAvText + '</div><span class="viewer-name">' + escapeHtml(v.username) + '</span><span class="viewer-time">' + formatStatusTime(v.viewed_at) + '</span></div>';
      }).join('');
    }
    panel.style.display = 'block';
  } catch(e) {}
});

document.getElementById('closeViewersPanel').addEventListener('click', function() {
  document.getElementById('statusViewersPanel').style.display = 'none';
  showCurrentStatus(); // Resume timer
});

// Status Reply
document.getElementById('statusReplySend').addEventListener('click', sendStatusReply);
document.getElementById('statusReplyInput').addEventListener('keypress', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); sendStatusReply(); }
});
document.getElementById('statusReplyInput').addEventListener('focus', function() {
  clearTimeout(statusTimer);
});

async function sendStatusReply() {
  var input = document.getElementById('statusReplyInput');
  var text = input.value.trim();
  if (!text || !currentStatusUser) return;

  var statusOwnerId = currentStatusUser.user_id;
  var s = currentStatusUser.statuses[currentStatusIndex];

  // Start or get private conversation with the status owner
  try {
    var res = await fetch('/api/chat/conversations/private', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ chat_number: currentStatusUser.chat_number })
    });
    var data = await res.json();
    if (data.conversation_id) {
      // Build WhatsApp-style status reference
      var statusRef = '';
      if (s.type === 'text') {
        statusRef = s.content.substring(0, 60);
      } else if (s.type === 'image') {
        statusRef = '\u{1F4F7} Photo';
      } else {
        statusRef = '\u{1F3AC} Video';
      }
      var replyContent = '\u{1F4AC} Replied to status: "' + statusRef + '"\n\n' + text;
      socket.emit('send_message', {
        conversation_id: data.conversation_id,
        content: replyContent,
        type: 'text',
        reply_to: null
      });
      input.value = '';
      closeStatusViewer();
      // Open the conversation
      currentConversation = { id: data.conversation_id, type: 'private', display_name: currentStatusUser.username };
      await loadConversations();
      var conv = conversations.find(function(c) { return c.id === data.conversation_id; });
      if (conv) openConversation(conv);
    }
  } catch(e) {
    console.error('Failed to send status reply', e);
  }
}

function formatStatusTime(dateStr) {
  if (!dateStr) return '';
  var d = new Date(dateStr);
  var now = new Date();
  var diff = now - d;
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return d.toLocaleDateString();
}

// ===== MOBILE KEYBOARD FIX =====
// Handles virtual keyboard on iOS/Android pushing content up
(function() {
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function() {
      var viewport = window.visualViewport;
      var chatArea = document.querySelector('.active-chat');
      if (chatArea && window.innerWidth <= 768) {
        chatArea.style.height = viewport.height + 'px';
        var container = document.getElementById('messagesContainer');
        if (container) {
          setTimeout(function() { container.scrollTop = container.scrollHeight; }, 100);
        }
      }
    });
    window.visualViewport.addEventListener('scroll', function() {
      document.documentElement.style.setProperty('--vv-offset', window.visualViewport.offsetTop + 'px');
    });
  }
})();

// ===== START =====
if (token && currentUser) { init(); }

// ===== STAR MESSAGES =====
async function toggleStarMessage() {
  if (!contextMessageId) return;
  try {
    const res = await fetch('/api/chat/messages/' + contextMessageId + '/star', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    if (data.starred) {
      starredMessageIds.push(contextMessageId);
    } else {
      starredMessageIds = starredMessageIds.filter(id => id !== contextMessageId);
    }
    // Update star icon in UI
    var msgEl = document.querySelector('[data-msg-id="' + contextMessageId + '"]');
    if (msgEl) {
      var meta = msgEl.querySelector('.msg-meta');
      var existing = meta.querySelector('.msg-star-icon');
      if (data.starred && !existing) {
        meta.insertAdjacentHTML('afterbegin', '<span class="msg-star-icon">&#11088;</span>');
      } else if (!data.starred && existing) {
        existing.remove();
      }
    }
  } catch(e) { console.error(e); }
}

async function openStarredModal() {
  showModal('starredModal');
  var list = document.getElementById('starredList');
  list.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:20px;">Loading...</p>';
  try {
    var res = await fetch('/api/chat/starred', { headers: { 'Authorization': 'Bearer ' + token } });
    var data = await res.json();
    if (!data.messages || data.messages.length === 0) {
      list.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:40px 20px;font-size:13px;">No starred messages</p>';
      return;
    }
    list.innerHTML = '';
    data.messages.forEach(function(msg) {
      var item = document.createElement('div');
      item.className = 'starred-item';
      item.innerHTML = '<div class="starred-header"><span class="starred-sender">' + escapeHtml(msg.sender_name) + '</span><span class="starred-conv">' + escapeHtml(msg.conversation_name || '') + '</span></div>' +
        '<div class="starred-content">' + escapeHtml(msg.content || (msg.type + ' message')).substring(0, 120) + '</div>' +
        '<div class="starred-time">' + formatMsgTime(msg.created_at) + '</div>';
      item.addEventListener('click', function() {
        hideModal('starredModal');
        var c = conversations.find(cv => cv.id === msg.conversation_id);
        if (c) openConversation(c);
      });
      list.appendChild(item);
    });
  } catch(e) { list.innerHTML = '<p style="color:var(--error);text-align:center;padding:20px;">Failed to load</p>'; }
}

// ===== ARCHIVE =====
async function archiveConversation(convId) {
  try {
    var res = await fetch('/api/chat/conversations/' + convId + '/archive', {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
    });
    var data = await res.json();
    var conv = conversations.find(c => c.id === convId);
    if (conv) conv.archived = data.archived;
    renderConversations();
  } catch(e) { console.error(e); }
}

function showArchivedChats() {
  var archived = conversations.filter(c => c.archived);
  conversationsList.innerHTML = '';
  var backBtn = document.createElement('div');
  backBtn.className = 'archived-header';
  backBtn.innerHTML = '<span>&#8592; Back</span>';
  backBtn.addEventListener('click', renderConversations);
  conversationsList.appendChild(backBtn);

  archived.forEach(function(conv) {
    var item = document.createElement('div');
    item.className = 'conversation-item';
    var initials = conv.display_name ? conv.display_name.charAt(0).toUpperCase() : '?';
    item.innerHTML = '<div class="conv-avatar">' + initials + '</div>' +
      '<div class="conv-info"><div class="conv-name">' + escapeHtml(conv.display_name || 'Unknown') + '</div></div>' +
      '<button class="btn-unarchive" title="Unarchive">&#128451;</button>';
    item.querySelector('.btn-unarchive').addEventListener('click', function(e) {
      e.stopPropagation();
      archiveConversation(conv.id);
    });
    item.addEventListener('click', function() { openConversation(conv); });
    conversationsList.appendChild(item);
  });
}

// ===== MUTE =====
function openMuteModal() { showModal('muteModal'); }

async function muteConversation(duration) {
  if (!currentConversation) return;
  try {
    await fetch('/api/chat/conversations/' + currentConversation.id + '/mute', {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration })
    });
    hideModal('muteModal');
    await loadConversations();
  } catch(e) { console.error(e); }
}

// ===== DISAPPEARING MESSAGES =====
async function setDisappearingTimer(timer) {
  if (!currentConversation) return;
  try {
    await fetch('/api/chat/conversations/' + currentConversation.id + '/disappearing', {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timer })
    });
    currentConversation.disappearing_timer = timer;
    socket.emit('disappearing_updated', {
      conversation_id: currentConversation.id,
      timer,
      updated_by: currentUser.username
    });
  } catch(e) { console.error(e); }
}

// ===== POLLS =====
function addPollOptionInput() {
  var container = document.getElementById('pollOptionsContainer');
  var count = container.querySelectorAll('.poll-option-input').length;
  if (count >= 10) return;
  var input = document.createElement('input');
  input.type = 'text';
  input.className = 'poll-option-input';
  input.placeholder = 'Option ' + (count + 1);
  input.style.marginBottom = '8px';
  container.appendChild(input);
}

async function createPoll() {
  if (!currentConversation || currentConversation.type !== 'group') return;
  var question = document.getElementById('pollQuestion').value.trim();
  var optionInputs = document.querySelectorAll('#pollOptionsContainer .poll-option-input');
  var options = [];
  optionInputs.forEach(function(inp) { if (inp.value.trim()) options.push(inp.value.trim()); });
  if (!question || options.length < 2) return;

  var allowMultiple = document.getElementById('pollAllowMultiple').checked;
  try {
    var res = await fetch('/api/chat/conversations/' + currentConversation.id + '/polls', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, options, allow_multiple: allowMultiple })
    });
    var data = await res.json();
    hideModal('pollModal');
    // Send as socket message so everyone sees it in real-time
    socket.emit('send_message', {
      conversation_id: currentConversation.id,
      content: String(data.poll_id),
      type: 'poll'
    });
    // Reset form
    document.getElementById('pollQuestion').value = '';
    document.getElementById('pollOptionsContainer').innerHTML = '<input type="text" class="poll-option-input" placeholder="Option 1" style="margin-bottom:8px;"><input type="text" class="poll-option-input" placeholder="Option 2" style="margin-bottom:8px;">';
    document.getElementById('pollAllowMultiple').checked = false;
  } catch(e) { console.error(e); }
}

async function loadPollCard(pollId, container) {
  if (!container) return;
  try {
    var res = await fetch('/api/chat/polls/' + pollId, { headers: { 'Authorization': 'Bearer ' + token } });
    var data = await res.json();
    renderPollCard(data, container);
  } catch(e) { container.innerHTML = '<em>Poll unavailable</em>'; }
}

function renderPollCard(data, container) {
  var poll = data.poll, options = data.options, votes = data.votes;
  var totalVotes = votes.length;
  var html = '<div class="poll-question">&#128202; ' + escapeHtml(poll.question) + '</div>';
  options.forEach(function(opt) {
    var optVotes = votes.filter(v => v.option_id === opt.id);
    var pct = totalVotes > 0 ? Math.round((optVotes.length / totalVotes) * 100) : 0;
    var myVote = optVotes.some(v => v.user_id === currentUser.id);
    html += '<div class="poll-option' + (myVote ? ' voted' : '') + '" data-option-id="' + opt.id + '" data-poll-id="' + poll.id + '">' +
      '<div class="poll-option-bar" style="width:' + pct + '%;"></div>' +
      '<span class="poll-option-text">' + escapeHtml(opt.option_text) + '</span>' +
      '<span class="poll-option-count">' + optVotes.length + '</span></div>';
  });
  html += '<div class="poll-footer">' + totalVotes + ' vote' + (totalVotes !== 1 ? 's' : '') + '</div>';
  container.innerHTML = html;

  // Add click handlers
  container.querySelectorAll('.poll-option').forEach(function(el) {
    el.addEventListener('click', function() { votePoll(el.dataset.pollId, el.dataset.optionId, container); });
  });
}

async function votePoll(pollId, optionId, container) {
  try {
    var res = await fetch('/api/chat/polls/' + pollId + '/vote', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ option_id: parseInt(optionId) })
    });
    var data = await res.json();
    // Re-fetch full poll to re-render
    var pollRes = await fetch('/api/chat/polls/' + pollId, { headers: { 'Authorization': 'Bearer ' + token } });
    var pollData = await pollRes.json();
    renderPollCard(pollData, container);
    // Notify others
    if (currentConversation) {
      socket.emit('poll_vote', { conversation_id: currentConversation.id, poll_id: pollId, votes: data.votes });
    }
  } catch(e) { console.error(e); }
}

// ===== PHASE 2: EMOJI KEYBOARD, GIF SEARCH, STICKERS, WALLPAPERS =====

// Comprehensive Emoji Dataset
const EMOJI_DATA = {
  'Smileys': ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🫡','🤐','🤨','😐','😑','😶','🫥','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🥵','🥶','🥴','😵','🤯','🤠','🥳','🥸','😎','🤓','🧐','😕','🫤','😟','🙁','☹️','😮','😯','😲','😳','🥺','🥹','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖'],
  'People': ['👋','🤚','🖐️','✋','🖖','🫱','🫲','🫳','🫴','👌','🤌','🤏','✌️','🤞','🫰','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','🫵','👍','👎','✊','👊','🤛','🤜','👏','🙌','🫶','👐','🤲','🤝','🙏','✍️','💅','🤳','💪','🦾','🦿','🦵','🦶','👂','🦻','👃','🧠','🫀','🫁','🦷','🦴','👀','👁️','👅','👄','🫦','👶','🧒','👦','👧','🧑','👱','👨','🧔','👩','🧓','👴','👵','🙍','🙎','🙅','🙆','💁','🙋','🧏','🙇','🤦','🤷','👮','🕵️','💂','🥷','👷','🫅','🤴','👸','👳','👲','🧕','🤵','👰','🤰','🫃','🫄','🤱','👼','🎅','🤶','🦸','🦹','🧙','🧚','🧛','🧜','🧝','🧞','🧟','🧌','💆','💇','🚶','🧍','🧎','🏃','💃','🕺','🕴️','👯','🧖','🧗','🤸','⛹️','🏋️','🚴','🚵','🤼','🤽','🤾','🤺','⛷️','🏂','🏌️','🏇','🧘','🛀','🛌','👭','👫','👬','💏','💑','👪','👨‍👩‍👦','👨‍👩‍👧','👨‍👩‍👧‍👦'],
  'Animals': ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐻‍❄️','🐨','🐯','🦁','🐮','🐷','🐽','🐸','🐵','🙈','🙉','🙊','🐒','🐔','🐧','🐦','🐤','🐣','🐥','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🪱','🐛','🦋','🐌','🐞','🐜','🪰','🪲','🪳','🦟','🦗','🕷️','🕸️','🦂','🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐','🦞','🦀','🪼','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🪸','🐊','🐅','🐆','🦓','🫏','🦍','🦧','🐘','🦣','🦛','🦏','🐪','🐫','🦒','🦘','🦬','🐃','🐂','🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🦮','🐕‍🦺','🐈','🐈‍⬛','🪶','🐓','🦃','🦤','🦚','🦜','🦢','🪿','🦩','🕊️','🐇','🦝','🦨','🦡','🦫','🦦','🦥','🐁','🐀','🐿️','🦔'],
  'Food': ['🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🫛','🥦','🥬','🥒','🌶️','🫑','🌽','🥕','🫒','🧄','🧅','🫚','🥔','🍠','🫘','🥐','🥯','🍞','🥖','🥨','🧀','🥚','🍳','🧈','🥞','🧇','🥓','🥩','🍗','🍖','🦴','🌭','🍔','🍟','🍕','🫓','🥪','🥙','🧆','🌮','🌯','🫔','🥗','🥘','🫕','🥫','🍝','🍜','🍲','🍛','🍣','🍱','🥟','🦪','🍤','🍙','🍚','🍘','🍥','🥠','🥮','🍢','🍡','🍧','🍨','🍦','🥧','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','🌰','🥜','🍯','🥛','🍼','🫖','☕','🍵','🧃','🥤','🧋','🫙','🍶','🍺','🍻','🥂','🍷','🫗','🥃','🍸','🍹','🧉','🍾','🧊','🥄','🍴','🍽️','🥣','🥡','🥢','🧂'],
  'Activities': ['⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🪀','🏓','🏸','🏒','🏑','🥍','🏏','🪃','🥅','⛳','🪁','🏹','🎣','🤿','🥊','🥋','🎽','🛹','🛼','🛷','⛸️','🥌','🎿','⛷️','🏂','🪂','🏋️','🤼','🤸','⛹️','🤺','🤾','🏌️','🏇','🧘','🏄','🏊','🤽','🚣','🧗','🚴','🚵','🎖️','🏆','🥇','🥈','🥉','🏅','🎪','🤹','🎭','🎨','🎬','🎤','🎧','🎼','🎹','🥁','🪘','🪇','🎷','🎺','🪗','🎸','🪕','🎻','🎲','♟️','🎯','🎳','🎮','🕹️','🧩','🪅','🪩','🪆'],
  'Travel': ['🚗','🚕','🚙','🚌','🚎','🏎️','🚓','🚑','🚒','🚐','🛻','🚚','🚛','🚜','🏍️','🛵','🦽','🦼','🛺','🚲','🛴','🛹','🛼','🚏','🛣️','🛤️','🛞','⛽','🛞','🚨','🚥','🚦','🛑','🚧','⚓','🛟','⛵','🛶','🚤','🛳️','⛴️','🛥️','🚢','✈️','🛩️','🛫','🛬','🪂','💺','🚁','🚟','🚠','🚡','🛰️','🚀','🛸','🌍','🌎','🌏','🌐','🗺️','🧭','🏔️','⛰️','🌋','🗻','🏕️','🏖️','🏜️','🏝️','🏞️','🏟️','🏛️','🏗️','🧱','🪨','🪵','🛖','🏘️','🏚️','🏠','🏡','🏢','🏣','🏤','🏥','🏦','🏨','🏩','🏪','🏫','🏬','🏭','🏯','🏰','💒','🗼','🗽','⛪','🕌','🛕','🕍','⛩️','🕋','⛲','⛺','🌁','🌃','🏙️','🌄','🌅','🌆','🌇','🌉','♨️','🎠','🛝','🎡','🎢','💈','🎪','🚂','🚃','🚄','🚅','🚆','🚇','🚈','🚉','🚊','🚝','🚞','🚋','🚔','🚍','🚘','🚖'],
  'Objects': ['⌚','📱','📲','💻','⌨️','🖥️','🖨️','🖱️','🖲️','🕹️','🗜️','💽','💾','💿','📀','📼','📷','📸','📹','🎥','📽️','🎞️','📞','☎️','📟','📠','📺','📻','🎙️','🎚️','🎛️','🧭','⏱️','⏲️','⏰','🕰️','⌛','⏳','📡','🔋','🪫','🔌','💡','🔦','🕯️','🪔','🧯','🛢️','🪙','💸','💵','💴','💶','💷','🪪','💳','💰','🧾','✉️','📧','📨','📩','📤','📥','📦','📫','📪','📬','📭','📮','🗳️','✏️','✒️','🖋️','🖊️','🖌️','🖍️','📝','💼','📁','📂','🗂️','📅','📆','🗒️','🗓️','📇','📈','📉','📊','📋','📌','📍','📎','🖇️','📏','📐','✂️','🗃️','🗄️','🗑️','🔒','🔓','🔏','🔐','🔑','🗝️','🔨','🪓','⛏️','⚒️','🛠️','🗡️','⚔️','💣','🪃','🏹','🛡️','🪚','🔧','🪛','🔩','⚙️','🗜️','⚖️','🦯','🔗','⛓️','🪝','🧰','🧲','🪜','🧪','🧫','🧬','🔬','🔭','📡','💉','🩸','💊','🩹','🩼','🩺','🩻','🚪','🛗','🪞','🪟','🛏️','🛋️','🪑','🚽','🪠','🚿','🛁','🪤','🪒','🧴','🧷','🧹','🧺','🧻','🪣','🧼','🫧','🪥','🧽','🧯','🛒','🚬','⚰️','🪦','⚱️','🧿','🪬','🏺','🔮','📿','🧿','💈'],
  'Symbols': ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❤️‍🔥','❤️‍🩹','❣️','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☪️','🕉️','☸️','✡️','🔯','🕎','☯️','☦️','🛐','⛎','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','🆔','⚛️','🉑','☢️','☣️','📴','📳','🈶','🈚','🈸','🈺','🈷️','✴️','🆚','💮','🉐','㊙️','㊗️','🈴','🈵','🈹','🈲','🅰️','🅱️','🆎','🆑','🅾️','🆘','❌','⭕','🛑','⛔','📛','🚫','💯','💢','♨️','🚷','🚯','🚳','🚱','🔞','📵','🚭','❗','❕','❓','❔','‼️','⁉️','🔅','🔆','〽️','⚠️','🚸','🔱','⚜️','🔰','♻️','✅','🈯','💹','❇️','✳️','❎','🌐','💠','Ⓜ️','🌀','💤','🏧','🚾','♿','🅿️','🛗','🈳','🈂️','🛂','🛃','🛄','🛅','🚹','🚺','🚼','⚧️','🚻','🚮','🎦','📶','🈁','🔣','ℹ️','🔤','🔡','🔠','🆖','🆗','🆙','🆒','🆕','🆓','0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟','🔢','#️⃣','*️⃣','⏏️','▶️','⏸️','⏯️','⏹️','⏺️','⏭️','⏮️','⏩','⏪','⏫','⏬','◀️','🔼','🔽','➡️','⬅️','⬆️','⬇️','↗️','↘️','↙️','↖️','↕️','↔️','↪️','↩️','⤴️','⤵️','🔀','🔁','🔂','🔄','🔃','🎵','🎶','➕','➖','➗','✖️','🟰','♾️','💲','💱','™️','©️','®️','〰️','➰','➿','🔚','🔙','🔛','🔝','🔜','✔️','☑️','🔘','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🟤','🔺','🔻','🔸','🔹','🔶','🔷','🔳','🔲','▪️','▫️','◾','◽','◼️','◻️','🟥','🟧','🟨','🟩','🟦','🟪','⬛','⬜','🟫','🔈','🔇','🔉','🔊','🔔','🔕','📣','📢','👁️‍🗨️','💬','💭','🗯️','♠️','♣️','♥️','♦️','🃏','🎴','🀄','🕐','🕑','🕒','🕓','🕔','🕕','🕖','🕗','🕘','🕙','🕚','🕛']
};

// Sticker packs (emoji-based large stickers)
const STICKER_PACKS = [
  ['😂','🤣','😭','💀','🙏','🔥','❤️','👀','💯','🎉','👋','✨','🥺','😍','🤮'],
  ['👑','🦋','🌈','🌸','🍕','🎮','💎','🚀','⚡','🌙','🎵','🍀','🦄','🐱','🐶'],
  ['👍','👎','✌️','🤞','🤟','🤘','👏','💪','🙌','🫶','🤝','🫡','🤌','👊','✊'],
  ['🎂','🎁','🎈','🎊','🥳','🎆','🎇','✨','🌟','⭐','💫','🪩','🎭','🎪','🎨']
];

// Wallpaper presets
const WALLPAPER_PRESETS = [
  '#0b141a', '#1a2e35', '#0d1f2d', '#12261e', '#1a1a2e',
  '#1e3a3a', '#2d1b2e', '#0f2027', '#1b1b3a', '#162447',
  '#1f4037', '#2c3e50', '#1a1a40', '#0f3443', '#34495e',
  '#2c2c54', '#706fd3', '#33d9b2', '#218c74', '#474787',
  '#e17055', '#00b894', '#6c5ce7', '#fd79a8', '#ffeaa7'
];

const WALLPAPER_GRADIENTS = [
  'linear-gradient(135deg, #0b141a, #1a2e35)',
  'linear-gradient(135deg, #0f2027, #203a43, #2c5364)',
  'linear-gradient(135deg, #1a1a2e, #16213e, #0f3460)',
  'linear-gradient(135deg, #232526, #414345)',
  'linear-gradient(135deg, #1d2b64, #f8cdda20)',
  'linear-gradient(135deg, #0c3547, #1a5276)',
  'linear-gradient(135deg, #141e30, #243b55)',
  'linear-gradient(135deg, #000428, #004e92)',
  'linear-gradient(135deg, #200122, #6f0000)',
  'linear-gradient(135deg, #1f4037, #99f2c8)'
];

// Expression panel state
let expressionPanelOpen = false;
let currentExpressionTab = 'emoji';
let gifSearchTimeout = null;

// Initialize expression panel
function initExpressionPanel() {
  var panel = document.getElementById('expressionPanel');
  var btn = document.getElementById('emojiPanelBtn');
  if (!btn || !panel) return;

  btn.addEventListener('click', toggleExpressionPanel);

  // Tab switching
  panel.querySelectorAll('.expression-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      switchExpressionTab(tab.dataset.tab);
    });
  });

  // Search
  var searchInput = document.getElementById('expressionSearch');
  searchInput.addEventListener('input', function() {
    if (currentExpressionTab === 'emoji') {
      filterEmojis(searchInput.value);
    } else if (currentExpressionTab === 'gif') {
      clearTimeout(gifSearchTimeout);
      gifSearchTimeout = setTimeout(function() { searchGifs(searchInput.value); }, 400);
    }
  });

  // Close panel on outside click
  document.addEventListener('click', function(e) {
    if (expressionPanelOpen && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      closeExpressionPanel();
    }
  });

  // Build emoji grid
  buildEmojiGrid();
  buildStickerGrid();

  // Wallpaper modal
  var closeWp = document.getElementById('closeWallpaper');
  if (closeWp) closeWp.addEventListener('click', function() { hideModal('wallpaperModal'); });
  var resetWp = document.getElementById('resetWallpaperBtn');
  if (resetWp) resetWp.addEventListener('click', resetWallpaper);
}

function toggleExpressionPanel() {
  if (expressionPanelOpen) {
    closeExpressionPanel();
  } else {
    openExpressionPanel();
  }
}

function openExpressionPanel() {
  var panel = document.getElementById('expressionPanel');
  panel.style.display = 'flex';
  expressionPanelOpen = true;
  if (currentExpressionTab === 'gif') loadTrendingGifs();
}

function closeExpressionPanel() {
  var panel = document.getElementById('expressionPanel');
  panel.style.display = 'none';
  expressionPanelOpen = false;
}

function switchExpressionTab(tab) {
  currentExpressionTab = tab;
  var panel = document.getElementById('expressionPanel');
  panel.querySelectorAll('.expression-tab').forEach(function(t) { t.classList.toggle('active', t.dataset.tab === tab); });
  document.getElementById('emojiTabContent').style.display = tab === 'emoji' ? 'block' : 'none';
  document.getElementById('gifTabContent').style.display = tab === 'gif' ? 'block' : 'none';
  document.getElementById('stickersTabContent').style.display = tab === 'stickers' ? 'block' : 'none';

  var searchInput = document.getElementById('expressionSearch');
  if (tab === 'emoji') { searchInput.placeholder = 'Search emoji...'; searchInput.value = ''; }
  else if (tab === 'gif') { searchInput.placeholder = 'Search GIFs...'; searchInput.value = ''; loadTrendingGifs(); }
  else { searchInput.placeholder = 'Stickers'; searchInput.value = ''; }
}

function buildEmojiGrid() {
  var categories = document.getElementById('emojiCategories');
  var grid = document.getElementById('emojiFullGrid');
  if (!categories || !grid) return;

  var catIcons = { 'Smileys': '😀', 'People': '👋', 'Animals': '🐱', 'Food': '🍎', 'Activities': '⚽', 'Travel': '🌍', 'Objects': '💡', 'Symbols': '❤️' };
  var catNames = Object.keys(EMOJI_DATA);

  // Recently used
  var recent = JSON.parse(localStorage.getItem('cw_recent_emojis') || '[]');

  // Category buttons
  categories.innerHTML = '';
  if (recent.length > 0) {
    var recentBtn = document.createElement('button');
    recentBtn.className = 'emoji-cat-btn active';
    recentBtn.textContent = '🕐';
    recentBtn.title = 'Recent';
    recentBtn.addEventListener('click', function() { scrollToCategory('recent'); setActiveCat(recentBtn); });
    categories.appendChild(recentBtn);
  }
  catNames.forEach(function(cat) {
    var btn = document.createElement('button');
    btn.className = 'emoji-cat-btn' + (recent.length === 0 && cat === catNames[0] ? ' active' : '');
    btn.textContent = catIcons[cat] || '📁';
    btn.title = cat;
    btn.addEventListener('click', function() { scrollToCategory(cat); setActiveCat(btn); });
    categories.appendChild(btn);
  });

  // Build grid
  renderFullEmojiGrid(recent);
}

function renderFullEmojiGrid(recent) {
  var grid = document.getElementById('emojiFullGrid');
  grid.innerHTML = '';

  if (!recent) recent = JSON.parse(localStorage.getItem('cw_recent_emojis') || '[]');

  if (recent.length > 0) {
    var label = document.createElement('div');
    label.className = 'emoji-section-label';
    label.textContent = 'Recent';
    label.id = 'emoji-section-recent';
    grid.appendChild(label);
    recent.forEach(function(e) { grid.appendChild(makeEmojiButton(e)); });
  }

  Object.keys(EMOJI_DATA).forEach(function(cat) {
    var label = document.createElement('div');
    label.className = 'emoji-section-label';
    label.textContent = cat;
    label.id = 'emoji-section-' + cat;
    grid.appendChild(label);
    EMOJI_DATA[cat].forEach(function(e) { grid.appendChild(makeEmojiButton(e)); });
  });
}

function makeEmojiButton(emoji) {
  var btn = document.createElement('button');
  btn.textContent = emoji;
  btn.addEventListener('click', function() { insertEmoji(emoji); });
  return btn;
}

function insertEmoji(emoji) {
  var input = document.getElementById('messageInput');
  var pos = input.selectionStart || input.value.length;
  input.value = input.value.slice(0, pos) + emoji + input.value.slice(pos);
  input.focus();
  input.selectionStart = input.selectionEnd = pos + emoji.length;

  // Save to recent
  var recent = JSON.parse(localStorage.getItem('cw_recent_emojis') || '[]');
  recent = recent.filter(function(e) { return e !== emoji; });
  recent.unshift(emoji);
  if (recent.length > 24) recent = recent.slice(0, 24);
  localStorage.setItem('cw_recent_emojis', JSON.stringify(recent));
}

function filterEmojis(query) {
  var grid = document.getElementById('emojiFullGrid');
  if (!query.trim()) { renderFullEmojiGrid(); return; }
  grid.innerHTML = '';
  var q = query.toLowerCase();
  Object.keys(EMOJI_DATA).forEach(function(cat) {
    if (cat.toLowerCase().includes(q)) {
      EMOJI_DATA[cat].forEach(function(e) { grid.appendChild(makeEmojiButton(e)); });
    }
  });
  // If nothing matched by category, just show all and let user scroll
  if (grid.children.length === 0) {
    Object.keys(EMOJI_DATA).forEach(function(cat) {
      EMOJI_DATA[cat].forEach(function(e) {
        grid.appendChild(makeEmojiButton(e));
      });
    });
  }
}

function scrollToCategory(cat) {
  var el = document.getElementById('emoji-section-' + cat);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setActiveCat(btn) {
  document.querySelectorAll('.emoji-cat-btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
}

// ===== GIF SEARCH (Tenor) =====
var TENOR_KEY = 'AIzaSyDDADRJFjJy3PknIp9gGqH-cLxpRJqG7p0';

function loadTrendingGifs() {
  var grid = document.getElementById('gifGrid');
  var loading = document.getElementById('gifLoading');
  grid.innerHTML = '';
  loading.style.display = 'block';
  fetch('https://tenor.googleapis.com/v2/featured?key=' + TENOR_KEY + '&limit=20&media_filter=tinygif,gif')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      loading.style.display = 'none';
      renderGifs(data.results || []);
    })
    .catch(function() { loading.style.display = 'none'; grid.innerHTML = '<p style="color:var(--text-muted);padding:20px;text-align:center;">Could not load GIFs</p>'; });
}

function searchGifs(q) {
  if (!q.trim()) { loadTrendingGifs(); return; }
  var grid = document.getElementById('gifGrid');
  var loading = document.getElementById('gifLoading');
  grid.innerHTML = '';
  loading.style.display = 'block';
  fetch('https://tenor.googleapis.com/v2/search?q=' + encodeURIComponent(q) + '&key=' + TENOR_KEY + '&limit=20&media_filter=tinygif,gif')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      loading.style.display = 'none';
      renderGifs(data.results || []);
    })
    .catch(function() { loading.style.display = 'none'; });
}

function renderGifs(results) {
  var grid = document.getElementById('gifGrid');
  grid.innerHTML = '';
  results.forEach(function(gif) {
    var tiny = gif.media_formats && gif.media_formats.tinygif ? gif.media_formats.tinygif.url : null;
    var full = gif.media_formats && gif.media_formats.gif ? gif.media_formats.gif.url : tiny;
    if (!tiny) return;
    var img = document.createElement('img');
    img.src = tiny;
    img.alt = 'GIF';
    img.loading = 'lazy';
    img.addEventListener('click', function() { sendGif(full || tiny); });
    grid.appendChild(img);
  });
}

function sendGif(url) {
  if (!currentConversation) return;
  socket.emit('send_message', {
    conversation_id: currentConversation.id,
    content: url,
    type: 'gif'
  });
  closeExpressionPanel();
}

// ===== STICKERS =====
function buildStickerGrid() {
  var grid = document.getElementById('stickerGrid');
  if (!grid) return;
  grid.innerHTML = '';
  STICKER_PACKS.forEach(function(pack) {
    pack.forEach(function(sticker) {
      var div = document.createElement('div');
      div.className = 'sticker-item';
      div.textContent = sticker;
      div.addEventListener('click', function() { sendSticker(sticker); });
      grid.appendChild(div);
    });
  });
}

function sendSticker(sticker) {
  if (!currentConversation) return;
  socket.emit('send_message', {
    conversation_id: currentConversation.id,
    content: sticker,
    type: 'sticker'
  });
  closeExpressionPanel();
}

// ===== WALLPAPER =====
function showWallpaperPicker() {
  var grid = document.getElementById('wallpaperGrid');
  grid.innerHTML = '';

  // Solid colors
  WALLPAPER_PRESETS.forEach(function(color) {
    var swatch = document.createElement('div');
    swatch.className = 'wallpaper-swatch';
    swatch.style.background = color;
    swatch.addEventListener('click', function() { setWallpaper(color); });
    grid.appendChild(swatch);
  });

  // Gradients
  WALLPAPER_GRADIENTS.forEach(function(grad) {
    var swatch = document.createElement('div');
    swatch.className = 'wallpaper-swatch';
    swatch.style.background = grad;
    swatch.addEventListener('click', function() { setWallpaper(grad); });
    grid.appendChild(swatch);
  });

  showModal('wallpaperModal');
}

async function setWallpaper(value) {
  if (!currentConversation) return;
  try {
    await fetch('/api/chat/conversations/' + currentConversation.id + '/wallpaper', {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallpaper: value })
    });
    applyWallpaper(value);
    currentConversation.wallpaper = value;
    hideModal('wallpaperModal');
  } catch(e) { console.error(e); }
}

async function resetWallpaper() {
  if (!currentConversation) return;
  try {
    await fetch('/api/chat/conversations/' + currentConversation.id + '/wallpaper', {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallpaper: 'default' })
    });
    applyWallpaper(null);
    currentConversation.wallpaper = null;
    hideModal('wallpaperModal');
  } catch(e) { console.error(e); }
}

function applyWallpaper(value) {
  var container = document.getElementById('messagesContainer');
  if (!container) return;
  if (!value) {
    container.style.background = '';
  } else if (value.startsWith('linear-gradient')) {
    container.style.background = value;
  } else {
    container.style.background = value;
  }
}

// Load wallpaper when opening a conversation
async function loadWallpaper(convId) {
  try {
    var res = await fetch('/api/chat/conversations/' + convId + '/wallpaper', { headers: { 'Authorization': 'Bearer ' + token } });
    var data = await res.json();
    applyWallpaper(data.wallpaper);
  } catch(e) { applyWallpaper(null); }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
  setTimeout(initExpressionPanel, 100);
});

// Also init if DOM already ready
if (document.readyState !== 'loading') {
  setTimeout(initExpressionPanel, 100);
}

// ===== PHASE 3: IN-CHAT SEARCH =====
var chatSearchTimeout = null;

function initChatSearch() {
  var btn = document.getElementById('chatSearchBtn');
  var bar = document.getElementById('chatSearchBar');
  var input = document.getElementById('chatSearchInput');
  var closeBtn = document.getElementById('chatSearchClose');
  var results = document.getElementById('chatSearchResults');

  if (btn) btn.addEventListener('click', function() {
    bar.style.display = 'flex';
    input.focus();
  });

  if (closeBtn) closeBtn.addEventListener('click', function() {
    bar.style.display = 'none';
    results.style.display = 'none';
    input.value = '';
    document.getElementById('chatSearchCount').textContent = '';
  });

  if (input) input.addEventListener('input', function() {
    clearTimeout(chatSearchTimeout);
    var q = input.value.trim();
    if (!q || !currentConversation) {
      results.style.display = 'none';
      document.getElementById('chatSearchCount').textContent = '';
      return;
    }
    chatSearchTimeout = setTimeout(function() { searchInChat(q); }, 300);
  });
}

async function searchInChat(q) {
  if (!currentConversation) return;
  try {
    var res = await fetch('/api/chat/conversations/' + currentConversation.id + '/search?q=' + encodeURIComponent(q), {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var data = await res.json();
    var results = document.getElementById('chatSearchResults');
    var countEl = document.getElementById('chatSearchCount');

    countEl.textContent = data.count + ' found';

    if (data.messages.length === 0) {
      results.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:13px;">No results found</div>';
      results.style.display = 'block';
      return;
    }

    results.innerHTML = data.messages.map(function(m) {
      var time = new Date(m.created_at).toLocaleString();
      var text = m.content || '[media]';
      if (text.length > 80) text = text.substring(0, 80) + '...';
      return '<div class="chat-search-result-item" data-msg-id="' + m.id + '">' +
        '<span class="result-sender">' + escapeHtml(m.sender_name) + '</span>' +
        '<span class="result-text">' + escapeHtml(text) + '</span>' +
        '<span class="result-time">' + time + '</span></div>';
    }).join('');
    results.style.display = 'block';

    results.querySelectorAll('.chat-search-result-item').forEach(function(item) {
      item.addEventListener('click', function() {
        var msgId = item.dataset.msgId;
        scrollToMessage(msgId);
        results.style.display = 'none';
      });
    });
  } catch(e) { console.error('Search error:', e); }
}

function scrollToMessage(msgId) {
  var msgEl = document.querySelector('[data-msg-id="' + msgId + '"]');
  if (msgEl) {
    msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    msgEl.classList.add('msg-highlight');
    setTimeout(function() { msgEl.classList.remove('msg-highlight'); }, 2500);
  }
}

// ===== PHASE 3: GROUP INVITE LINKS =====

async function showInviteLink(convId) {
  try {
    var res = await fetch('/api/chat/conversations/' + convId + '/invite-link', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var data = await res.json();
    if (data.invite_code) {
      var link = window.location.origin + '/join/' + data.invite_code;
      var html = '<div style="margin:16px 0;padding:12px;background:var(--surface);border-radius:8px;">' +
        '<label style="font-size:11px;color:var(--text-muted);text-transform:uppercase;display:block;margin-bottom:6px;">Invite Link</label>' +
        '<div style="display:flex;gap:8px;align-items:center;">' +
        '<input type="text" value="' + link + '" readonly style="flex:1;padding:8px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:12px;outline:none;" id="inviteLinkInput">' +
        '<button onclick="copyInviteLink()" style="padding:8px 12px;background:var(--accent);border:none;border-radius:6px;color:#fff;font-size:12px;cursor:pointer;">Copy</button>' +
        '</div>' +
        '<button onclick="resetInviteLink(' + convId + ')" style="margin-top:8px;background:none;border:none;color:var(--text-muted);font-size:11px;cursor:pointer;">Reset link</button>' +
        '</div>';
      return html;
    }
  } catch(e) {}
  return '';
}

function copyInviteLink() {
  var input = document.getElementById('inviteLinkInput');
  if (input) {
    input.select();
    document.execCommand('copy');
    input.style.borderColor = 'var(--accent)';
    setTimeout(function() { input.style.borderColor = 'var(--border)'; }, 1000);
  }
}

async function resetInviteLink(convId) {
  try {
    var res = await fetch('/api/chat/conversations/' + convId + '/reset-invite', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var data = await res.json();
    if (data.invite_code) {
      var input = document.getElementById('inviteLinkInput');
      if (input) input.value = window.location.origin + '/join/' + data.invite_code;
    }
  } catch(e) {}
}

// ===== PHASE 3: GROUP DESCRIPTION =====

async function updateGroupDescription(convId, description) {
  try {
    var res = await fetch('/api/chat/conversations/' + convId + '/description', {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ description })
    });
    if (res.ok) {
      socket.emit('group_updated', { conversation_id: convId, description, updated_by: currentUser.username });
    }
  } catch(e) {}
}

// ===== PHASE 3: BROADCASTS =====
var broadcasts = [];
var broadcastSelectedIds = [];

async function loadBroadcasts() {
  try {
    var res = await fetch('/api/chat/broadcasts', { headers: { 'Authorization': 'Bearer ' + token } });
    var data = await res.json();
    broadcasts = data.broadcasts || [];
    renderBroadcastsInSidebar();
  } catch(e) {}
}

function renderBroadcastsInSidebar() {
  var existing = document.getElementById('broadcastSection');
  if (existing) existing.remove();
  if (broadcasts.length === 0) return;

  var section = document.createElement('div');
  section.id = 'broadcastSection';
  section.className = 'broadcast-section';
  section.innerHTML = '<div class="broadcast-section-title">&#128226; Broadcasts</div>' +
    broadcasts.map(function(b) {
      return '<div class="broadcast-item" data-id="' + b.id + '">' +
        '<span style="font-size:18px;">&#128226;</span>' +
        '<span class="bi-name">' + escapeHtml(b.name) + '</span>' +
        '<span class="bi-count">' + b.member_count + ' recipients</span></div>';
    }).join('');

  var convList = document.querySelector('.conversations-list');
  if (convList) convList.parentNode.insertBefore(section, convList);

  section.querySelectorAll('.broadcast-item').forEach(function(item) {
    item.addEventListener('click', function() {
      openBroadcastSend(parseInt(item.dataset.id));
    });
  });
}

function openBroadcastSend(broadcastId) {
  var b = broadcasts.find(function(br) { return br.id === broadcastId; });
  if (!b) return;
  document.getElementById('broadcastSendInfo').textContent = 'Sending to "' + b.name + '" (' + b.member_count + ' recipients)';
  document.getElementById('broadcastMsgInput').value = '';
  document.getElementById('broadcastSendModal').style.display = 'flex';
  document.getElementById('sendBroadcastBtn').onclick = function() { sendBroadcast(broadcastId); };
}

async function sendBroadcast(broadcastId) {
  var content = document.getElementById('broadcastMsgInput').value.trim();
  if (!content) return;
  var btn = document.getElementById('sendBroadcastBtn');
  btn.textContent = 'Sending...';
  btn.disabled = true;
  try {
    var res = await fetch('/api/chat/broadcasts/' + broadcastId + '/send', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    var data = await res.json();
    btn.textContent = 'Sent to ' + data.sent + '!';
    setTimeout(function() {
      document.getElementById('broadcastSendModal').style.display = 'none';
      btn.textContent = 'Send to All';
      btn.disabled = false;
    }, 1500);
  } catch(e) {
    btn.textContent = 'Send to All';
    btn.disabled = false;
  }
}

function initBroadcastCreate() {
  var searchInput = document.getElementById('broadcastMemberSearch');
  var memberList = document.getElementById('broadcastMemberList');
  var selectedDiv = document.getElementById('broadcastSelectedMembers');
  broadcastSelectedIds = [];

  if (searchInput) searchInput.addEventListener('input', async function() {
    var q = searchInput.value.trim();
    if (!q) { memberList.innerHTML = ''; return; }
    var res = await fetch('/api/chat/users/search?q=' + encodeURIComponent(q), {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var data = await res.json();
    memberList.innerHTML = data.users.map(function(u) {
      var sel = broadcastSelectedIds.includes(u.id) ? ' selected' : '';
      return '<div class="broadcast-member-item' + sel + '" data-id="' + u.id + '" data-name="' + escapeHtml(u.username) + '">' +
        '<span class="bm-name">' + escapeHtml(u.username) + ' <small style="color:var(--text-muted);">#' + u.chat_number + '</small></span>' +
        '<span class="bm-check">&#10003;</span></div>';
    }).join('');

    memberList.querySelectorAll('.broadcast-member-item').forEach(function(item) {
      item.addEventListener('click', function() {
        var id = parseInt(item.dataset.id);
        var name = item.dataset.name;
        if (broadcastSelectedIds.includes(id)) {
          broadcastSelectedIds = broadcastSelectedIds.filter(function(x) { return x !== id; });
          item.classList.remove('selected');
        } else {
          broadcastSelectedIds.push(id);
          item.classList.add('selected');
        }
        renderBroadcastSelected();
      });
    });
  });

  var createBtn = document.getElementById('createBroadcastBtn');
  if (createBtn) createBtn.addEventListener('click', createBroadcast);

  var closeBtn = document.getElementById('closeBroadcastSend');
  if (closeBtn) closeBtn.addEventListener('click', function() {
    document.getElementById('broadcastSendModal').style.display = 'none';
  });
}

function renderBroadcastSelected() {
  var div = document.getElementById('broadcastSelectedMembers');
  div.innerHTML = broadcastSelectedIds.length > 0 ? '<small style="color:var(--text-muted);">' + broadcastSelectedIds.length + ' selected</small>' : '';
}

async function createBroadcast() {
  var name = document.getElementById('broadcastName').value.trim();
  if (!name || broadcastSelectedIds.length === 0) return;
  try {
    var res = await fetch('/api/chat/broadcasts', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, member_ids: broadcastSelectedIds })
    });
    if (res.ok) {
      document.getElementById('newChatModal').style.display = 'none';
      document.getElementById('broadcastName').value = '';
      broadcastSelectedIds = [];
      renderBroadcastSelected();
      loadBroadcasts();
    }
  } catch(e) {}
}

// ===== PHASE 3 INIT =====
document.addEventListener('DOMContentLoaded', function() {
  initChatSearch();
  initBroadcastCreate();
  loadBroadcasts();
});

if (document.readyState !== 'loading') {
  initChatSearch();
  initBroadcastCreate();
  loadBroadcasts();
}

// ===== CHAT EXPORT =====

function exportChat() {
  if (!currentConversation) return;
  var withMedia = confirm('Include media links?\n\nOK = With media links\nCancel = Text only');
  var url = '/api/chat/conversations/' + currentConversation.id + '/export?format=txt' + (withMedia ? '&media=true' : '');

  fetch(url, { headers: { 'Authorization': 'Bearer ' + token } })
    .then(function(res) { return res.blob(); })
    .then(function(blob) {
      var blobUrl = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = blobUrl;
      a.download = 'ChatWave_export.txt';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    });
}

// ===== TWO-STEP VERIFICATION =====

function loadTwoStepStatus() {
  fetch('/api/auth/two-step/status', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var section = document.getElementById('twoStepSection');
      if (!section) return;

      if (data.enabled) {
        section.innerHTML = '<p style="color:var(--accent);font-size:13px;margin-bottom:12px;">✅ Two-step verification is enabled</p>' +
          (data.email ? '<p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">Backup: ' + data.email + '</p>' : '') +
          '<button class="btn-danger" onclick="disableTwoStep()">Disable</button>';
      } else {
        section.innerHTML = '<p style="color:var(--text-muted);font-size:13px;margin-bottom:12px;">Add a 6-digit PIN for extra security</p>' +
          '<div class="input-group"><label>6-Digit PIN</label><input type="tel" id="twoStepPinInput" maxlength="6" placeholder="000000" style="letter-spacing:8px;text-align:center;font-size:20px;"></div>' +
          '<div class="input-group"><label>Backup Email (optional)</label><input type="email" id="twoStepEmailInput" placeholder="your@email.com"></div>' +
          '<button class="btn-primary" onclick="enableTwoStep()">Enable</button>';
      }
    }).catch(function() {});
}

function enableTwoStep() {
  var pinInput = document.getElementById('twoStepPinInput');
  var emailInput = document.getElementById('twoStepEmailInput');
  var pin = pinInput ? pinInput.value : '';

  if (!/^\d{6}$/.test(pin)) { alert('PIN must be exactly 6 digits'); return; }

  fetch('/api/auth/two-step/enable', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ pin: pin, email: emailInput ? emailInput.value : '' })
  }).then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.enabled) {
        alert('Two-step verification enabled!');
        loadTwoStepStatus();
      } else {
        alert(data.error || 'Failed');
      }
    });
}

function disableTwoStep() {
  var pin = prompt('Enter your current 6-digit PIN to disable:');
  if (!pin) return;

  fetch('/api/auth/two-step/disable', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ pin: pin })
  }).then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.message) {
        alert('Two-step verification disabled');
        loadTwoStepStatus();
      } else {
        alert(data.error || 'Failed');
      }
    });
}

// ===== CHANNELS =====

async function createChannel() {
  var nameInput = document.getElementById('channelNameInput');
  var descInput = document.getElementById('channelDescInput');
  if (!nameInput || !nameInput.value.trim()) return;

  try {
    var res = await fetch('/api/chat/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ name: nameInput.value.trim(), description: descInput ? descInput.value.trim() : '', is_public: true })
    });
    var data = await res.json();
    if (res.ok) {
      nameInput.value = '';
      if (descInput) descInput.value = '';
      hideModal('newChatModal');
      loadConversations();
    } else {
      alert(data.error || 'Failed to create channel');
    }
  } catch(e) { console.error(e); }
}

async function discoverChannels() {
  try {
    var res = await fetch('/api/chat/channels', { headers: { 'Authorization': 'Bearer ' + token } });
    var data = await res.json();
    var list = document.getElementById('channelsDiscoverList');
    if (!list) return;
    if (!data.channels || data.channels.length === 0) {
      list.innerHTML = '<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:20px;">No channels available</p>';
    } else {
      list.innerHTML = data.channels.map(function(ch) {
        return '<div class="conversation-item" onclick="subscribeChannel(' + ch.id + ')" style="border-radius:8px;margin-bottom:4px;">' +
          '<div class="conv-avatar" style="background:var(--accent);font-size:20px;">&#128226;</div>' +
          '<div class="conv-info"><span class="conv-name">' + escapeHtml(ch.name) + '</span>' +
          '<span class="conv-last-msg">' + (ch.subscriber_count || 0) + ' subscribers</span></div></div>';
      }).join('');
    }
    showModal('channelsDiscoverModal');
  } catch(e) { console.error(e); }
}

async function subscribeChannel(channelId) {
  try {
    await fetch('/api/chat/channels/' + channelId + '/subscribe', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    hideModal('channelsDiscoverModal');
    loadConversations();
  } catch(e) { console.error(e); }
}

// ===== COMMUNITIES =====

async function createCommunity() {
  var nameInput = document.getElementById('communityNameInput');
  var descInput = document.getElementById('communityDescInput');
  if (!nameInput || !nameInput.value.trim()) return;

  try {
    var res = await fetch('/api/communities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ name: nameInput.value.trim(), description: descInput ? descInput.value.trim() : '' })
    });
    var data = await res.json();
    if (res.ok) {
      nameInput.value = '';
      if (descInput) descInput.value = '';
      hideModal('createCommunityModal');
      loadCommunities();
    } else {
      alert(data.error || 'Failed to create community');
    }
  } catch(e) { console.error(e); }
}

async function loadCommunities() {
  try {
    var res = await fetch('/api/communities', { headers: { 'Authorization': 'Bearer ' + token } });
    var data = await res.json();
    var list = document.getElementById('communitiesList');
    if (!list) return;
    if (!data.communities || data.communities.length === 0) {
      list.innerHTML = '<p style="color:var(--text-muted);font-size:12px;text-align:center;padding:16px;">No communities yet</p>';
      return;
    }
    list.innerHTML = data.communities.map(function(c) {
      return '<div class="conversation-item" onclick="openCommunityDetail(' + c.id + ')" style="border-radius:8px;margin-bottom:4px;">' +
        '<div class="conv-avatar" style="background:var(--accent);font-size:20px;">&#127983;</div>' +
        '<div class="conv-info"><span class="conv-name">' + escapeHtml(c.name) + '</span>' +
        '<span class="conv-last-msg">' + (c.group_count || 0) + ' groups &middot; ' + (c.member_count || 0) + ' members</span></div></div>';
    }).join('');
  } catch(e) { console.error(e); }
}

async function openCommunityDetail(communityId) {
  try {
    var res = await fetch('/api/communities/' + communityId, { headers: { 'Authorization': 'Bearer ' + token } });
    var data = await res.json();
    if (!res.ok) return;

    document.getElementById('communityDetailName').textContent = data.community.name;
    var descEl = document.getElementById('communityDetailDesc');
    if (descEl) descEl.textContent = data.community.description || '';
    var invCodeEl = document.getElementById('communityInviteCode');
    if (invCodeEl) invCodeEl.textContent = window.location.origin + '/api/communities/join/' + (data.community.invite_code || '');
    var memberCountEl = document.getElementById('communityMemberCount');
    if (memberCountEl) memberCountEl.textContent = data.members.length;

    var groupsList = document.getElementById('communityGroupsList');
    if (groupsList) {
      groupsList.innerHTML = data.groups.map(function(g) {
        return '<div class="conversation-item" onclick="openConversation(' + g.id + ');hideModal(\'communityDetailModal\')" style="border-radius:8px;margin-bottom:4px;padding:8px 12px;">' +
          '<div class="conv-avatar" style="width:36px;height:36px;font-size:14px;background:var(--surface);">' + (g.locked ? '&#128226;' : '&#128101;') + '</div>' +
          '<div class="conv-info"><span class="conv-name" style="font-size:13px;">' + escapeHtml(g.name) + '</span>' +
          '<span class="conv-last-msg">' + (g.member_count || 0) + ' members</span></div></div>';
      }).join('');
    }

    var membersList = document.getElementById('communityMembersList');
    if (membersList) {
      membersList.innerHTML = data.members.map(function(m) {
        return '<div class="member-item"><span class="member-name">' + escapeHtml(m.username) + '</span>' +
          (m.role === 'admin' ? '<span class="member-role">Admin</span>' : '') + '</div>';
      }).join('');
    }

    // Copy invite button
    var copyBtn = document.getElementById('copyCommunityInvite');
    if (copyBtn) {
      copyBtn.onclick = function() {
        var url = window.location.origin + '/api/communities/join/' + (data.community.invite_code || '');
        if (navigator.clipboard) { navigator.clipboard.writeText(url); }
        else { var t = document.createElement('textarea'); t.value = url; document.body.appendChild(t); t.select(); document.execCommand('copy'); document.body.removeChild(t); }
        alert('Invite link copied!');
      };
    }

    // Store community ID for add group
    var addBtn = document.getElementById('addCommunityGroupBtn');
    if (addBtn) addBtn.dataset.communityId = communityId;

    showModal('communityDetailModal');
  } catch(e) { console.error(e); }
}

async function addCommunityGroup() {
  var nameInput = document.getElementById('newCommunityGroupName');
  var addBtn = document.getElementById('addCommunityGroupBtn');
  var communityId = addBtn ? addBtn.dataset.communityId : null;
  if (!nameInput || !nameInput.value.trim() || !communityId) return;

  try {
    await fetch('/api/communities/' + communityId + '/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ name: nameInput.value.trim() })
    });
    nameInput.value = '';
    openCommunityDetail(parseInt(communityId));
    loadConversations();
  } catch(e) { console.error(e); }
}

// ===== PHASE 4 EVENT LISTENERS =====

(function initPhase4() {
  var createChannelBtn = document.getElementById('createChannelBtn');
  if (createChannelBtn) createChannelBtn.addEventListener('click', createChannel);

  var discoverBtn = document.getElementById('discoverChannelsBtn');
  if (discoverBtn) discoverBtn.addEventListener('click', discoverChannels);

  var closeChDiscover = document.getElementById('closeChannelsDiscover');
  if (closeChDiscover) closeChDiscover.addEventListener('click', function() { hideModal('channelsDiscoverModal'); });

  var createCommunityBtn = document.getElementById('createCommunityBtn');
  if (createCommunityBtn) createCommunityBtn.addEventListener('click', createCommunity);

  var communitiesBtn = document.getElementById('communitiesBtn');
  if (communitiesBtn) communitiesBtn.addEventListener('click', function() { loadCommunities(); showModal('communitiesModal'); });

  var closeCommunityDetail = document.getElementById('closeCommunityDetail');
  if (closeCommunityDetail) closeCommunityDetail.addEventListener('click', function() { hideModal('communityDetailModal'); });

  var addGroupBtn = document.getElementById('addCommunityGroupBtn');
  if (addGroupBtn) addGroupBtn.addEventListener('click', addCommunityGroup);
})();

// ===== NAV BAR SWITCHING =====

(function initNavBar() {
  var navItems = document.querySelectorAll('.nav-item[data-nav]');
  navItems.forEach(function(item) {
    item.addEventListener('click', function() {
      var view = item.dataset.nav;
      switchNavView(view);
    });
  });
})();

function switchNavView(view) {
  // Update nav active state
  var navItems = document.querySelectorAll('.nav-item[data-nav]');
  navItems.forEach(function(item) {
    item.classList.toggle('active', item.dataset.nav === view);
  });

  // Hide all sidebar views
  var views = document.querySelectorAll('.sidebar-view');
  views.forEach(function(v) { v.classList.remove('active'); v.style.display = 'none'; });

  // Show selected view
  var viewMap = {
    'chats': 'chatsView',
    'status': 'statusView',
    'channels': 'channelsView',
    'communities': 'communitiesView',
    'settings': 'settingsView'
  };

  var targetId = viewMap[view];
  var target = document.getElementById(targetId);
  if (target) { target.classList.add('active'); target.style.display = 'flex'; }

  // Load content for the view
  if (view === 'status') { if (typeof loadStatuses === 'function') loadStatuses(); }
  if (view === 'channels') { loadSubscribedChannels(); }
  if (view === 'communities') { if (typeof loadCommunities === 'function') loadCommunities(); }
}

function loadSubscribedChannels() {
  // Channels the user is subscribed to are already in the conversations list
  // This is a placeholder — channels show in the channelsList div
}

// ===== VOICE & VIDEO CALLS (WebRTC) =====

var callState = {
  active: false,
  callId: null,
  type: null, // 'voice' or 'video'
  isCaller: false,
  remoteUserId: null,
  remoteName: '',
  remoteAvatar: null,
  peerConnection: null,
  localStream: null,
  remoteStream: null,
  timerInterval: null,
  timerSeconds: 0,
  ringTimeout: null,
  audioCtx: null,
  ringOscillator: null
};

var iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

// Start a call
async function initiateCall(type) {
  if (!currentConversation || currentConversation.type !== 'private') return;
  if (callState.active) return;

  // Find the other user in the conversation
  try {
    var res = await fetch('/api/chat/conversations/' + currentConversation.id + '/members', { headers: { 'Authorization': 'Bearer ' + token } });
    var data = await res.json();
    var otherMember = data.members.find(function(m) { return m.id !== currentUser.id; });
    if (!otherMember) return;

    callState.active = true;
    callState.type = type;
    callState.isCaller = true;
    callState.remoteUserId = otherMember.id;
    callState.remoteName = otherMember.username;
    callState.remoteAvatar = otherMember.avatar;

    // Get local media
    var constraints = { audio: true, video: type === 'video' };
    callState.localStream = await navigator.mediaDevices.getUserMedia(constraints);

    // Send initiate event
    socket.emit('call:initiate', {
      to_user_id: otherMember.id,
      type: type,
      conversation_id: currentConversation.id
    });

    // Show active call screen
    showActiveCallUI('Calling...');

  } catch(e) {
    console.error('Call initiate error:', e);
    if (e.name === 'NotAllowedError') alert('Microphone/camera access denied. Please allow permissions.');
    resetCallState();
  }
}

function showActiveCallUI(status) {
  var overlay = document.getElementById('activeCallOverlay');
  var avatar = document.getElementById('activeCallAvatar');
  var nameEl = document.getElementById('activeCallName');
  var statusEl = document.getElementById('callStatus');
  var voiceView = document.getElementById('callVoiceView');
  var camBtn = document.getElementById('toggleCamBtn');

  avatar.textContent = callState.remoteName.charAt(0).toUpperCase();
  avatar.style.backgroundImage = callState.remoteAvatar ? 'url(' + callState.remoteAvatar + ')' : '';
  if (callState.remoteAvatar) avatar.textContent = '';
  nameEl.textContent = callState.remoteName;
  statusEl.textContent = status;
  document.getElementById('callTimer').style.display = 'none';

  // Show/hide video elements
  if (callState.type === 'video') {
    camBtn.style.display = 'flex';
    document.getElementById('localVideo').style.display = 'block';
    document.getElementById('localVideo').srcObject = callState.localStream;
  } else {
    camBtn.style.display = 'none';
    voiceView.style.display = 'flex';
  }

  overlay.style.display = 'flex';
}

function showIncomingCallUI(data) {
  var overlay = document.getElementById('incomingCallOverlay');
  var avatar = document.getElementById('incomingCallAvatar');
  var nameEl = document.getElementById('incomingCallName');
  var typeEl = document.getElementById('incomingCallType');

  avatar.textContent = data.caller_name.charAt(0).toUpperCase();
  avatar.style.backgroundImage = data.caller_avatar ? 'url(' + data.caller_avatar + ')' : '';
  if (data.caller_avatar) avatar.textContent = '';
  nameEl.textContent = data.caller_name;
  typeEl.textContent = 'Incoming ' + data.type + ' call...';

  overlay.style.display = 'flex';
  startRingTone();

  // Auto reject after 30s
  callState.ringTimeout = setTimeout(function() {
    rejectCall();
  }, 30000);
}

// Ring tone using Web Audio API
function startRingTone() {
  try {
    callState.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    var osc = callState.audioCtx.createOscillator();
    var gain = callState.audioCtx.createGain();
    osc.connect(gain);
    gain.connect(callState.audioCtx.destination);
    osc.frequency.value = 440;
    gain.gain.value = 0.15;
    osc.start();
    callState.ringOscillator = osc;
    // Pulse on/off
    var ringPulse = setInterval(function() {
      if (!callState.ringOscillator) { clearInterval(ringPulse); return; }
      gain.gain.value = gain.gain.value > 0 ? 0 : 0.15;
    }, 500);
    callState.ringPulseInterval = ringPulse;
  } catch(e) {}
}

function stopRingTone() {
  if (callState.ringOscillator) { try { callState.ringOscillator.stop(); } catch(e) {} callState.ringOscillator = null; }
  if (callState.audioCtx) { try { callState.audioCtx.close(); } catch(e) {} callState.audioCtx = null; }
  if (callState.ringPulseInterval) clearInterval(callState.ringPulseInterval);
}

async function acceptCall() {
  stopRingTone();
  clearTimeout(callState.ringTimeout);
  document.getElementById('incomingCallOverlay').style.display = 'none';

  // Get local media
  var constraints = { audio: true, video: callState.type === 'video' };
  try {
    callState.localStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch(e) {
    alert('Cannot access microphone/camera');
    rejectCall();
    return;
  }

  callState.active = true;
  socket.emit('call:accept', { call_id: callState.callId });
  showActiveCallUI('Connecting...');
}

function rejectCall() {
  stopRingTone();
  clearTimeout(callState.ringTimeout);
  document.getElementById('incomingCallOverlay').style.display = 'none';
  socket.emit('call:reject', { call_id: callState.callId });
  resetCallState();
}

function endCall() {
  var duration = callState.timerSeconds;
  socket.emit('call:end', { call_id: callState.callId, duration: duration });
  cleanupCall();
}

function cleanupCall() {
  stopRingTone();
  clearTimeout(callState.ringTimeout);
  if (callState.timerInterval) clearInterval(callState.timerInterval);

  // Stop media tracks
  if (callState.localStream) { callState.localStream.getTracks().forEach(function(t) { t.stop(); }); }
  if (callState.peerConnection) { callState.peerConnection.close(); }

  // Hide UI
  document.getElementById('activeCallOverlay').style.display = 'none';
  document.getElementById('incomingCallOverlay').style.display = 'none';
  document.getElementById('remoteVideo').style.display = 'none';
  document.getElementById('localVideo').style.display = 'none';
  document.getElementById('remoteVideo').srcObject = null;
  document.getElementById('localVideo').srcObject = null;

  resetCallState();
}

function resetCallState() {
  callState.active = false;
  callState.callId = null;
  callState.type = null;
  callState.isCaller = false;
  callState.remoteUserId = null;
  callState.peerConnection = null;
  callState.localStream = null;
  callState.remoteStream = null;
  callState.timerInterval = null;
  callState.timerSeconds = 0;
}

function startCallTimer() {
  var timerEl = document.getElementById('callTimer');
  var statusEl = document.getElementById('callStatus');
  statusEl.style.display = 'none';
  timerEl.style.display = 'block';
  callState.timerSeconds = 0;
  callState.timerInterval = setInterval(function() {
    callState.timerSeconds++;
    var m = Math.floor(callState.timerSeconds / 60).toString().padStart(2, '0');
    var s = (callState.timerSeconds % 60).toString().padStart(2, '0');
    timerEl.textContent = m + ':' + s;
  }, 1000);
}

// Setup WebRTC peer connection
function createPeerConnection() {
  var pc = new RTCPeerConnection({ iceServers: iceServers });

  // Add local tracks
  if (callState.localStream) {
    callState.localStream.getTracks().forEach(function(track) {
      pc.addTrack(track, callState.localStream);
    });
  }

  // ICE candidates
  pc.onicecandidate = function(e) {
    if (e.candidate) {
      socket.emit('call:ice-candidate', { call_id: callState.callId, candidate: e.candidate });
    }
  };

  // Remote stream
  pc.ontrack = function(e) {
    if (callState.type === 'video') {
      var remoteVideo = document.getElementById('remoteVideo');
      remoteVideo.srcObject = e.streams[0];
      remoteVideo.style.display = 'block';
      document.getElementById('callVoiceView').style.display = 'none';
    }
    callState.remoteStream = e.streams[0];
    // Connected — start timer
    startCallTimer();
  };

  pc.onconnectionstatechange = function() {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      endCall();
    }
  };

  callState.peerConnection = pc;
  return pc;
}

// Socket call event listeners
socket.on('call:ringing', function(data) {
  callState.callId = data.call_id;
});

socket.on('call:incoming', function(data) {
  if (callState.active) {
    socket.emit('call:reject', { call_id: data.call_id });
    return;
  }
  callState.callId = data.call_id;
  callState.type = data.type;
  callState.isCaller = false;
  callState.remoteUserId = data.caller_id;
  callState.remoteName = data.caller_name;
  callState.remoteAvatar = data.caller_avatar;
  showIncomingCallUI(data);
});

socket.on('call:accepted', async function(data) {
  // Caller: create offer
  var pc = createPeerConnection();
  var offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('call:offer', { call_id: callState.callId, offer: offer });
  document.getElementById('callStatus').textContent = 'Connecting...';
});

socket.on('call:offer', async function(data) {
  // Callee: receive offer, create answer
  var pc = createPeerConnection();
  await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
  var answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('call:answer', { call_id: callState.callId, answer: answer });
});

socket.on('call:answer', async function(data) {
  // Caller: set remote description
  if (callState.peerConnection) {
    await callState.peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
  }
});

socket.on('call:ice-candidate', function(data) {
  if (callState.peerConnection) {
    callState.peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
  }
});

socket.on('call:rejected', function() { cleanupCall(); });
socket.on('call:ended', function() { cleanupCall(); });

// UI event listeners
document.getElementById('acceptCallBtn').addEventListener('click', acceptCall);
document.getElementById('rejectCallBtn').addEventListener('click', rejectCall);
document.getElementById('endCallBtn').addEventListener('click', endCall);

document.getElementById('toggleMicBtn').addEventListener('click', function() {
  if (!callState.localStream) return;
  var audioTrack = callState.localStream.getAudioTracks()[0];
  if (audioTrack) {
    audioTrack.enabled = !audioTrack.enabled;
    this.classList.toggle('muted', !audioTrack.enabled);
  }
});

document.getElementById('toggleCamBtn').addEventListener('click', function() {
  if (!callState.localStream) return;
  var videoTrack = callState.localStream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.enabled = !videoTrack.enabled;
    this.classList.toggle('muted', !videoTrack.enabled);
    document.getElementById('localVideo').style.display = videoTrack.enabled ? 'block' : 'none';
  }
});

// Cleanup on page unload
window.addEventListener('beforeunload', function() {
  if (callState.active) { endCall(); }
});
