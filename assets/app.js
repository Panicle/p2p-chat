'use strict';

const CHUNK_SIZE = 16 * 1024;
const MAX_BUFFERED = 4 * 1024 * 1024;

// 免费公共信令服务（PeerJS Cloud）：只转发 SDP / ICE，不接触聊天内容
const PEER_OPTS = {
  host: '0.peerjs.com',
  port: 443,
  secure: true,
  key: 'peerjs',
  config: {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
    ]
  }
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const $ = (sel, root = document) => root.querySelector(sel);

const el = {
  landing: $('#landing'),
  chat: $('#chat'),
  btnCreate: $('#btn-create'),
  joinForm: $('#join-form'),
  codeInput: $('#code-input'),
  roomCode: $('#room-code'),
  statusText: $('#status-text'),
  statusDot: $('#status-dot'),
  messages: $('#messages'),
  msgInput: $('#msg-input'),
  btnSend: $('#btn-send'),
  fileInput: $('#file-input'),
  btnCopy: $('#btn-copy'),
  btnLeave: $('#btn-leave'),
  dropHint: $('#drop-hint'),
  emptyState: $('#empty-state'),
  emptyCode: $('#empty-code')
};

const state = {
  role: null,
  room: null,
  peer: null,
  conn: null,
  connected: false,
  announced: false,
  incoming: null,
  guestTries: 0,
  retryTimer: null,
  leaving: false
};

const SESSION_KEY = 'p2p-chat-session';
let sessionToken = null;

// 打开 ?debug=1 时在控制台输出信令与连接事件，便于排查网络问题
const DEBUG = /[?&]debug=1/.test(location.search);
function dlog(...args) {
  if (DEBUG) console.log('[p2p]', ...args);
}

function loadSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; }
}

function saveSession() {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      room: state.room,
      role: state.role,
      token: sessionToken
    }));
  } catch (e) { /* noop */ }
}

function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* noop */ }
}

/* ---------------- 基础工具 ---------------- */

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function randomId(len = 12) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[buf[i] % chars.length];
  return out;
}

function genCode() {
  const buf = new Uint32Array(6);
  crypto.getRandomValues(buf);
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  return code;
}

// 会话码 -> 固定的信令 ID，双方无需交换 ID
function hostIdFor(code) {
  return 'p2pchat' + code.toLowerCase() + 'h';
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function fmtTime(ts) {
  const d = new Date(ts || Date.now());
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setStatus(kind, text) {
  el.statusDot.className = 'dot ' + kind;
  el.statusText.textContent = text;
}

function append(node) {
  el.messages.appendChild(node);
  el.messages.scrollTop = el.messages.scrollHeight;
}

function systemMsg(text) {
  const d = document.createElement('div');
  d.className = 'sys';
  d.textContent = text;
  append(d);
}

/* ---------------- 信令与连接 ---------------- */

function ensureToken() {
  if (!sessionToken) sessionToken = randomId(16);
  return sessionToken;
}

function toSignalError(err) {
  const map = {
    'unavailable-id': '会话码已被占用',
    network: '无法连接信令服务',
    'server-error': '信令服务异常',
    'invalid-key': '信令服务密钥无效',
    'browser-incompatible': '当前浏览器不支持 WebRTC'
  };
  const e = new Error(map[err && err.type] || (err && err.message) || '信令服务异常');
  e.code = err && err.type;
  return e;
}

function openHost(code) {
  return new Promise((resolve, reject) => {
    const peer = new Peer(hostIdFor(code), Object.assign({}, PEER_OPTS, { token: ensureToken() }));
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { peer.destroy(); } catch (e) { /* noop */ }
      reject(new Error('信令服务连接超时'));
    }, 12000);

    peer.on('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.peer = peer;
      wirePeer(peer);
      dlog('host open', hostIdFor(code));
      resolve();
    });

    peer.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        try { peer.destroy(); } catch (e) { /* noop */ }
        reject(toSignalError(err));
        return;
      }
      handlePeerError(err);
    });
  });
}

function openGuest() {
  return new Promise((resolve, reject) => {
    const peer = new Peer('p2pchatg' + randomId(), Object.assign({}, PEER_OPTS, { token: ensureToken() }));
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { peer.destroy(); } catch (e) { /* noop */ }
      reject(new Error('信令服务连接超时'));
    }, 12000);

    peer.on('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.peer = peer;
      wirePeer(peer);
      dlog('guest open', peer.id);
      resolve();
    });

    peer.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        try { peer.destroy(); } catch (e) { /* noop */ }
        reject(toSignalError(err));
        return;
      }
      handlePeerError(err);
    });
  });
}

function wirePeer(peer) {
  peer.on('connection', (conn) => {
    dlog('incoming connection, role=', state.role);
    if (state.role !== 'host') return;
    if (state.conn && state.conn.open) {
      try { conn.close(); } catch (e) { /* noop */ }
      return;
    }
    attach(conn);
  });

  peer.on('disconnected', () => {
    dlog('signaling disconnected');
    if (state.leaving) return;
    setStatus('warn', '信令断开，正在重连…');
    try { peer.reconnect(); } catch (e) { /* noop */ }
  });
}

function handlePeerError(err) {
  if (state.leaving) return;
  const type = err && err.type;
  if (type === 'peer-unavailable') return; // 对方不在线，由重试逻辑处理
  if (type === 'webrtc' || type === 'negotiation-failed') {
    setStatus('warn', '直连协商失败');
    return;
  }
  if (type === 'network' || type === 'server-error' || type === 'socket-error') {
    setStatus('warn', '信令网络异常');
    return;
  }
  if (type === 'unavailable-id') {
    setStatus('warn', '会话码已被占用');
  }
}

function onConnError() {
  setStatus('warn', '连接异常');
}

function attach(conn) {
  if (state.conn === conn) return;
  state.conn = conn;
  conn.on('open', () => onConnOpen(conn));
  conn.on('data', (data) => { if (state.conn === conn) onData(data); });
  conn.on('close', () => onConnClose(conn));
  conn.on('error', (e) => { dlog('conn error', e && (e.type || e.message)); if (state.conn === conn) onConnError(); });
  if (conn.open) onConnOpen(conn);
  dlog('attach conn, open=', conn.open, 'peer=', conn.peer);
}

function onConnOpen(conn) {
  if (state.conn !== conn) return;
  dlog('conn open');
  state.connected = true;
  state.guestTries = 0;
  clearTimeout(state.retryTimer);
  state.retryTimer = null;
  setStatus('online', '已直连');
  el.emptyState.classList.add('hidden');
  if (!state.announced) {
    state.announced = true;
    systemMsg('已建立端到端直连，消息与文件不再经过服务器');
  }
  el.msgInput.focus();
}

function onConnClose(conn) {
  if (state.conn !== conn) return;
  state.connected = false;
  state.conn = null;
  if (state.leaving) return;
  setStatus('warn', '连接已断开');
  systemMsg('直连已断开');
  // 对方刷新或短暂掉线时，发起方自动重连
  if (state.role === 'guest' && !state.retryTimer) {
    state.guestTries = 0;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      guestConnect();
    }, 2000);
  }
}

function closeConn() {
  clearTimeout(state.retryTimer);
  state.retryTimer = null;
  const conn = state.conn;
  state.conn = null;
  state.connected = false;
  state.announced = false;
  if (conn) {
    try { conn.close(); } catch (e) { /* noop */ }
  }
}

function guestConnect() {
  if (state.connected || state.leaving) return;
  if (state.guestTries >= 3) {
    setStatus('warn', '未找到对方');
    systemMsg('连接超时：请确认会话码正确，且对方页面保持打开');
    return;
  }
  state.guestTries++;

  closeConn();
  if (!state.peer || state.peer.destroyed) return;

  const conn = state.peer.connect(hostIdFor(state.room), {
    reliable: true,
    serialization: 'raw'
  });
  attach(conn);
  dlog('guest connect try', state.guestTries, '->', hostIdFor(state.room));

  clearTimeout(state.retryTimer);
  state.retryTimer = setTimeout(() => {
    if (!state.connected && !state.leaving) guestConnect();
  }, 6000);
}

/* ---------------- 入口 ---------------- */

async function createRoom() {
  el.btnCreate.disabled = true;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = genCode();
      try {
        await openHost(code);
        state.room = code;
        state.role = 'host';
        enterChat();
        setStatus('idle', '等待对方加入');
        return;
      } catch (e) {
        if (e.code === 'unavailable-id') continue;
        throw e;
      }
    }
    throw new Error('会话码连续冲突，请重试');
  } catch (e) {
    alert(e.message);
  } finally {
    el.btnCreate.disabled = false;
  }
}

async function joinRoom(code) {
  if (!/^[A-Z2-9]{6}$/.test(code)) {
    alert('请输入 6 位会话码');
    return;
  }
  try {
    await openGuest();
    state.room = code;
    state.role = 'guest';
    enterChat();
    setStatus('wait', '正在连接对方…');
    guestConnect();
  } catch (e) {
    alert(e.message);
  }
}

function enterChat() {
  el.landing.classList.add('hidden');
  el.chat.classList.remove('hidden');
  el.roomCode.textContent = state.room;
  el.emptyCode.textContent = state.room;
  if (state.role !== 'host') el.emptyState.classList.add('hidden');
  saveSession();
  el.msgInput.focus();
}

/* ---------------- 文字消息 ---------------- */

function isOpen() {
  return !!(state.conn && state.conn.open);
}

function sendText() {
  const text = el.msgInput.value.trim();
  if (!text) return;
  if (!isOpen()) {
    systemMsg('尚未建立直连，消息未发送');
    return;
  }
  const msg = { t: 'text', id: uid(), text, ts: Date.now() };
  state.conn.send(JSON.stringify(msg));
  addText('me', msg.text, msg.ts);
  el.msgInput.value = '';
  autosize();
}

function addText(who, text, ts) {
  const row = document.createElement('div');
  row.className = 'msg ' + (who === 'me' ? 'me' : 'peer');

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = fmtTime(ts);
  bubble.appendChild(time);

  row.appendChild(bubble);
  append(row);
}

function onData(data) {
  if (typeof data === 'string') {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    onControl(msg);
    return;
  }
  if (data instanceof ArrayBuffer) {
    onChunk(data);
    return;
  }
  if (data instanceof Blob) {
    data.arrayBuffer().then(onChunk).catch(() => { /* noop */ });
    return;
  }
  if (ArrayBuffer.isView(data)) {
    onChunk(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
}

function onControl(msg) {
  if (msg.t === 'text') {
    addText('peer', msg.text, msg.ts);
  } else if (msg.t === 'file-start') {
    if (state.incoming) state.incoming = null;
    const meta = {
      name: msg.name || '未命名文件',
      size: Number(msg.size) || 0,
      mime: msg.mime || 'application/octet-stream'
    };
    state.incoming = {
      id: msg.id,
      meta,
      chunks: [],
      received: 0,
      lastP: 0,
      node: createFileBubble('peer', meta, false)
    };
  } else if (msg.t === 'file-end') {
    finishIncoming();
  } else if (msg.t === 'bye') {
    setStatus('warn', '对方已离开');
    systemMsg('对方已离开会话');
  }
}

/* ---------------- 文件传输 ---------------- */

function createFileBubble(who, meta, outgoing) {
  const row = document.createElement('div');
  row.className = 'msg ' + (who === 'me' ? 'me' : 'peer');

  const bubble = document.createElement('div');
  bubble.className = 'bubble file';

  const head = document.createElement('div');
  head.className = 'file-head';

  const name = document.createElement('div');
  name.className = 'file-name';
  name.textContent = meta.name;

  const size = document.createElement('div');
  size.className = 'file-size';
  size.textContent = fmtSize(meta.size);

  head.append(name, size);

  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('i');
  bar.appendChild(fill);

  const status = document.createElement('div');
  status.className = 'file-status';
  status.textContent = outgoing ? '发送中 0%' : '接收中 0%';

  bubble.append(head, bar, status);
  row.appendChild(bubble);
  append(row);

  return {
    row,
    bubble,
    fill,
    bar,
    status,
    meta,
    mode: outgoing ? '发送中' : '接收中'
  };
}

function setProgress(node, p) {
  const pct = Math.max(0, Math.min(1, p));
  node.fill.style.width = (pct * 100).toFixed(1) + '%';
  node.status.textContent = node.mode + ' ' + Math.round(pct * 100) + '%';
}

function finishFile(node, url, outgoing) {
  if (node.bar && node.bar.parentNode) node.bar.remove();
  node.status.textContent = outgoing ? '已发送' : '已接收';

  const link = document.createElement('a');
  link.className = 'file-open';
  link.href = url;
  link.download = node.meta.name;
  link.textContent = '保存';

  if ((node.meta.mime || '').startsWith('image/')) {
    const img = document.createElement('img');
    img.className = 'thumb';
    img.src = url;
    img.alt = node.meta.name;
    img.addEventListener('click', () => window.open(url, '_blank'));
    node.bubble.insertBefore(img, node.bubble.firstChild);
  }

  node.bubble.appendChild(link);
}

async function drain() {
  const dc = state.conn && state.conn.dataChannel;
  if (!dc) return;
  while (dc.bufferedAmount > MAX_BUFFERED && isOpen()) {
    await sleep(30);
  }
}

async function sendOneFile(file) {
  const id = uid();
  const meta = {
    name: file.name || ('粘贴图片-' + Date.now() + '.png'),
    size: file.size,
    mime: file.type || 'application/octet-stream'
  };

  state.conn.send(JSON.stringify({
    t: 'file-start',
    id,
    name: meta.name,
    size: meta.size,
    mime: meta.mime
  }));

  const node = createFileBubble('me', meta, true);
  let sent = 0;

  while (sent < file.size) {
    if (!isOpen()) break;
    await drain();
    const buf = await file.slice(sent, sent + CHUNK_SIZE).arrayBuffer();
    try {
      state.conn.send(buf);
    } catch (e) {
      break;
    }
    sent += buf.byteLength;
    setProgress(node, sent / file.size);
  }

  if (isOpen()) {
    state.conn.send(JSON.stringify({ t: 'file-end', id }));
  }
  finishFile(node, URL.createObjectURL(file), true);
}

async function sendFiles(files) {
  for (const file of files) {
    if (!file || file.size === 0) continue;
    if (!isOpen()) {
      systemMsg('尚未建立直连，文件未发送');
      return;
    }
    await sendOneFile(file);
  }
}

function onChunk(buf) {
  const inc = state.incoming;
  if (!inc) return;
  inc.chunks.push(buf);
  inc.received += buf.byteLength;
  const p = inc.meta.size ? Math.min(1, inc.received / inc.meta.size) : 1;
  if (p - inc.lastP > 0.02 || p === 1) {
    inc.lastP = p;
    setProgress(inc.node, p);
  }
}

function finishIncoming() {
  const inc = state.incoming;
  if (!inc) return;
  state.incoming = null;
  const blob = new Blob(inc.chunks, { type: inc.meta.mime });
  finishFile(inc.node, URL.createObjectURL(blob), false);
}

/* ---------------- 交互绑定 ---------------- */

function autosize() {
  el.msgInput.style.height = 'auto';
  el.msgInput.style.height = Math.min(el.msgInput.scrollHeight, 120) + 'px';
}

async function copyInvite() {
  const link = location.origin + location.pathname + '#r=' + state.room;
  try {
    await navigator.clipboard.writeText(link);
    el.btnCopy.title = '已复制';
    systemMsg('邀请链接已复制，发给对方即可加入');
    setTimeout(() => { el.btnCopy.title = '复制邀请链接'; }, 1500);
  } catch (e) {
    systemMsg('复制失败，请手动分享会话码 ' + state.room);
  }
}

function leave() {
  state.leaving = true;
  if (isOpen()) {
    try { state.conn.send(JSON.stringify({ t: 'bye' })); } catch (e) { /* noop */ }
  }
  closeConn();
  if (state.peer && !state.peer.destroyed) {
    try { state.peer.destroy(); } catch (e) { /* noop */ }
  }
  clearSession();
  location.hash = '';
  location.reload();
}

el.btnCreate.addEventListener('click', createRoom);

el.joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  joinRoom(el.codeInput.value.trim().toUpperCase());
});

el.codeInput.addEventListener('input', () => {
  el.codeInput.value = el.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

el.btnSend.addEventListener('click', sendText);

el.msgInput.addEventListener('input', autosize);

el.msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendText();
  }
});

el.fileInput.addEventListener('change', () => {
  const files = Array.from(el.fileInput.files || []);
  el.fileInput.value = '';
  sendFiles(files);
});

el.btnCopy.addEventListener('click', copyInvite);
el.btnLeave.addEventListener('click', leave);

// 拖拽发送
let dragDepth = 0;

el.chat.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  el.dropHint.classList.remove('hidden');
});

el.chat.addEventListener('dragover', (e) => {
  e.preventDefault();
});

el.chat.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) el.dropHint.classList.add('hidden');
});

el.chat.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  el.dropHint.classList.add('hidden');
  const files = Array.from(e.dataTransfer.files || []);
  sendFiles(files);
});

// 粘贴图片
el.msgInput.addEventListener('paste', (e) => {
  const items = Array.from(e.clipboardData?.items || []);
  const files = items
    .filter((i) => i.kind === 'file')
    .map((i) => i.getAsFile())
    .filter(Boolean);
  if (files.length) {
    e.preventDefault();
    sendFiles(files);
  }
});

// 恢复会话：刷新页面后仍停留在原会话（sessionStorage 按标签页隔离）
(async function init() {
  const saved = loadSession();

  if (saved && /^[A-Z2-9]{6}$/.test(saved.room || '') &&
      (saved.role === 'host' || saved.role === 'guest')) {
    state.room = saved.room;
    state.role = saved.role;
    sessionToken = saved.token || null;
    enterChat();
    try {
      if (state.role === 'host') {
        await openHost(state.room);
        setStatus('idle', '等待对方加入');
      } else {
        await openGuest();
        setStatus('wait', '正在重新连接…');
        guestConnect();
      }
    } catch (e) {
      clearSession();
      state.room = null;
      state.role = null;
      el.chat.classList.add('hidden');
      el.landing.classList.remove('hidden');
      alert('会话已失效，请重新创建');
    }
    return;
  }

  const m = location.hash.match(/#r=([A-Z0-9]{6})/i);
  if (m) {
    el.codeInput.value = m[1].toUpperCase();
    el.codeInput.focus();
  }
})();
