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
      appendMessage(message);
      scrollToBottom();
      if (message.sender_id !== currentUser.id) {
        socket.emit('mark_read', { conversation_id: message.conversation_id, message_ids: [message.id] });
      }
    }
    if (message.sender_id !== currentUser.id) {
      // Check for mention
      if (message.content && message.content.includes('@' + currentUser.username)) {
        playSound('mention');
      } else {
        playSound('message');
      }
      showNotification(message.sender_name, message.content || 'Sent a file');
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
  let filtered = conversations;
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

    item.innerHTML = '<div class="conv-avatar" style="' + avatarStyle + '">' + avatarText +
      (isOnline ? '<span class="online-dot"></span>' : '') + '</div>' +
      '<div class="conv-info"><div class="conv-name">' + escapeHtml(conv.display_name || 'Unknown') +
      (conv.type === 'group' ? ' <span style="font-size:11px;color:var(--text-muted);">(' + conv.member_count + ')</span>' : '') +
      '</div><div class="conv-last-msg">' + escapeHtml(lastMsg) + '</div></div>' +
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
  } else {
    groupMembers = [];
  }
  if (window.innerWidth <= 768) sidebar.classList.add('hidden');
  socket.emit('join_conversation', { conversation_id: conv.id });
}

async function loadMessages(convId) {
  try {
    const res = await fetch('/api/chat/conversations/' + convId + '/messages', { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json();
    messagesContainer.innerHTML = '';
    data.messages.forEach(msg => appendMessage(msg, data.reactions, data.receipts));
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
function appendMessage(msg, allReactions, allReceipts) {
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

  div.innerHTML = avatarHtml + '<div class="msg-bubble">' + forwardedHtml + senderHtml + replyHtml + '<div class="msg-content">' + contentHtml + '</div>' + metaHtml + reactionsHtml + '</div>';

  // Context menu
  div.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e, msg.id, msg.conversation_id, isMine, msg.type);
  });

  messagesContainer.appendChild(div);
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
  document.getElementById('themeToggleApp').addEventListener('click', () => {
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
  document.getElementById('chatUserInfoBtn').addEventListener('click', viewChatUserProfile);

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
  document.getElementById('confirmForward').addEventListener('click', confirmForward);

  // Edit modal
  document.getElementById('closeEdit').addEventListener('click', () => hideModal('editModal'));
  document.getElementById('confirmEdit').addEventListener('click', confirmEdit);

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
  document.getElementById('editMsgInput').value = content;
  showModal('editModal');
}

function confirmEdit() {
  const content = document.getElementById('editMsgInput').value.trim();
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
  const list = document.getElementById('forwardList');
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
  const av = document.getElementById('viewAvatar');
  av.textContent = user.username.charAt(0).toUpperCase();
  if (user.avatar) {
    av.style.backgroundImage = 'url(' + user.avatar + ')';
    av.style.backgroundSize = 'cover';
    av.textContent = '';
  } else {
    av.style.backgroundImage = '';
  }
  document.getElementById('viewUsername').textContent = user.username;
  document.getElementById('viewChatNum').textContent = '#' + user.chat_number;
  document.getElementById('viewBio').textContent = user.bio || '';
  document.getElementById('viewStatusMsg').textContent = user.status_message || '';
  document.getElementById('viewStatus').textContent = user.status === 'online' ? 'Online' : 'Last seen ' + formatLastSeen(user.last_seen);
  document.getElementById('viewJoined').textContent = 'Joined ' + new Date(user.created_at).toLocaleDateString();
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
  
  if (currentConversation.type === 'group') {
    try {
      const res = await fetch('/api/chat/conversations/' + currentConversation.id + '/members', { headers: { 'Authorization': 'Bearer ' + token } });
      const data = await res.json();
      const isAdmin = data.members.some(m => m.id === currentUser.id && m.role === 'admin');
      
      let html = '<div style="text-align:center;margin-bottom:20px;">';
      html += '<h3>' + escapeHtml(currentConversation.name || 'Group') + '</h3>';
      html += '<p style="font-size:13px;color:var(--text-muted);">' + data.members.length + ' members</p>';
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
      body.innerHTML = html;
    } catch(e) { body.innerHTML = '<p>Error loading info</p>'; }
  } else {
    body.innerHTML = '<p style="text-align:center;color:var(--text-muted);">Private conversation</p>';
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
init();
