'use strict';

const CHUNK_SIZE = 16 * 1024;
const MAX_BUFFERED = 4 * 1024 * 1024;

// 法国教育部孵化器共享的 WebRTC 基础设施（公开共享账号，无需自建服务器）
// 信令：peer.incubateur.education.gouv.fr （PeerJS）
// TURN：turn.incubateur.education.gouv.fr （UDP + TLS/TCP，用于跨 NAT 中继）
const TURN_FR = { username: 'prof', credential: 'Q!TzBTIeKY1W51bn2WnajpO1' };
const TURN_OR = { username: 'openrelayproject', credential: 'openrelayproject' };

const PEER_OPTS = {
  host: 'peer.incubateur.education.gouv.fr',
  port: 443,
  path: '/peerjs',
  secure: true,
  key: 'd9352f15a0286310f438a4985fcd6fcf',
  config: {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      {
        urls: [
          'turn:turn.incubateur.education.gouv.fr:443?transport=udp',
          'turns:turn.incubateur.education.gouv.fr:443?transport=tcp'
        ],
        username: TURN_FR.username,
        credential: TURN_FR.credential
      },
      // 备用 TURN（Open Relay 静态账号，可能被限流，仅作兜底）
      { urls: 'turn:openrelay.metered.ca:80', username: TURN_OR.username, credential: TURN_OR.credential },
      { urls: 'turn:openrelay.metered.ca:443', username: TURN_OR.username, credential: TURN_OR.credential },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: TURN_OR.username, credential: TURN_OR.credential }
    ]
  }
};

// 自检时逐个测试的服务器，方便看出到底哪条路不通
const PROBE_TARGETS = [
  { label: 'STUN · Google', servers: [{ urls: 'stun:stun.l.google.com:19302' }] },
  {
    label: 'TURN · 教育网 UDP 443',
    servers: [{ urls: 'turn:turn.incubateur.education.gouv.fr:443?transport=udp', username: TURN_FR.username, credential: TURN_FR.credential }]
  },
  {
    label: 'TURN · 教育网 TLS 443',
    servers: [{ urls: 'turns:turn.incubateur.education.gouv.fr:443?transport=tcp', username: TURN_FR.username, credential: TURN_FR.credential }]
  },
  {
    label: 'TURN · Open Relay UDP 80',
    servers: [{ urls: 'turn:openrelay.metered.ca:80', username: TURN_OR.username, credential: TURN_OR.credential }]
  },
  {
    label: 'TURN · Open Relay TCP 443',
    servers: [{ urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: TURN_OR.username, credential: TURN_OR.credential }]
  }
];

// 进入密码：双方必须输入正确密码才能创建或加入会话
// 注意：这是纯前端校验，密码写在源码里，查看网页源码即可看到。
// 它的作用是防止误入，以及让不知道密码的人无法推算出房间 ID。
const ROOM_PASS = 'XT8A2M';

// 撤回时限：发出后 2 分钟内可撤回
const RECALL_WINDOW = 2 * 60 * 1000;

// 两个固定头像（内联 SVG，离线可用，不依赖外部图片）
// 0 = 发起方，1 = 加入方
const AVATARS = [
  {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
      '<defs><linearGradient id="av0" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#5b8cff"/><stop offset="1" stop-color="#8a5bff"/>' +
      '</linearGradient></defs>' +
      '<rect width="64" height="64" rx="32" fill="url(#av0)"/>' +
      '<circle cx="32" cy="25" r="10" fill="#fff" opacity="0.95"/>' +
      '<path d="M13 55c2.7-10 9.6-15.5 19-15.5S48.3 45 51 55" fill="#fff" opacity="0.95"/>' +
      '</svg>'
  },
  {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
      '<defs><linearGradient id="av1" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#3ddc97"/><stop offset="1" stop-color="#2b9cff"/>' +
      '</linearGradient></defs>' +
      '<rect width="64" height="64" rx="32" fill="url(#av1)"/>' +
      '<circle cx="32" cy="24" r="9.5" fill="#fff" opacity="0.95"/>' +
      '<rect x="15" y="38" width="34" height="15" rx="7.5" fill="#fff" opacity="0.95"/>' +
      '</svg>'
  }
];

const $ = (sel, root = document) => root.querySelector(sel);

const el = {
  landing: $('#landing'),
  chat: $('#chat'),
  topbar: $('#topbar'),
  passInput: $('#pass-input'),
  passError: $('#pass-error'),
  peerAvatar: $('#peer-avatar'),
  statusText: $('#status-text'),
  statusDot: $('#status-dot'),
  messages: $('#messages'),
  msgInput: $('#msg-input'),
  btnSend: $('#btn-send'),
  fileInput: $('#file-input'),
  btnLeave: $('#btn-leave'),
  dropHint: $('#drop-hint'),
  emptyState: $('#empty-state'),
  btnDiag: $('#btn-diag'),
  diagPanel: $('#diag-panel'),
  diagBody: $('#diag-body'),
  diagClose: $('#diag-close'),
  btnCall: $('#btn-call'),
  btnVoice: $('#btn-voice'),
  btnHangup: $('#btn-hangup'),
  callBar: $('#call-bar'),
  callTime: $('#call-bar .call-time')
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
  leaving: false,
  promoting: false,
  promoteCount: 0,
  call: null,
  localStream: null,
  remoteAudio: null,
  inCall: false,
  calling: false,
  recording: false
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

// 标准 SHA-256（纯 JS 实现）
// 之所以不用 crypto.subtle：它在非安全上下文（http、file://）下不可用，
// 会导致本地打开或某些受限环境直接失效。
function sha256Hex(str) {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

  // UTF-8 编码
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    } else if (c < 0xd800 || c >= 0xe000) {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else {
      i++;
      c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
      bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }

  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  bytes.push(0, 0, 0, 0,
    (bitLen >>> 24) & 255, (bitLen >>> 16) & 255, (bitLen >>> 8) & 255, bitLen & 255);

  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  const W = new Array(64);

  for (let off = 0; off < bytes.length; off += 64) {
    for (let t = 0; t < 16; t++) {
      const p = off + t * 4;
      W[t] = (bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
    }

    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];

    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t] + W[t]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;

      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }

    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0;
    H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0;
    H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }

  return H.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

// 由密码派生房间 ID：不知道密码就无法推算出信令 ID，也就连不进这个房间
function roomIdFor(pass) {
  const hex = sha256Hex('p2p-chat-room-v1|' + pass.trim().toUpperCase());
  return 'p2pchat' + hex.slice(0, 20) + 'h';
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

/* ---------------- 头像 ---------------- */

// 发起方固定用头像 0，加入方固定用头像 1
function myAvatarIndex() {
  return state.role === 'guest' ? 1 : 0;
}

function peerAvatarIndex() {
  return state.role === 'guest' ? 0 : 1;
}

function makeAvatar(who) {
  const span = document.createElement('span');
  span.className = 'avatar';
  const idx = who === 'me' ? myAvatarIndex() : peerAvatarIndex();
  span.dataset.avatar = String(idx);
  span.innerHTML = AVATARS[idx].svg;
  return span;
}

function renderAvatars() {
  el.peerAvatar.innerHTML = AVATARS[peerAvatarIndex()].svg;
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

function openHost(roomId) {
  return new Promise((resolve, reject) => {
    const peer = new Peer(roomId, Object.assign({}, PEER_OPTS, { token: ensureToken() }));
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
      dlog('host open', roomId);
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
    if (state.leaving || state.promoting) return;
    setStatus('warn', '信令断开，正在重连…');
    try { peer.reconnect(); } catch (e) { /* noop */ }
  });

  // 收到实时语音来电：自动接听（双方已通过密码建立信任）
  peer.on('call', (call) => {
    dlog('incoming call');
    if (state.inCall || state.calling) {
      try { call.close(); } catch (e) { /* noop */ }
      return;
    }
    answerCall(call);
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
  el.topbar.classList.add('connected');
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
  el.topbar.classList.remove('connected');
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

const MAX_TRIES = 4;
const RETRY_MS = 6000;
const MAX_PROMOTE = 6;

function guestConnect() {
  if (state.connected || state.leaving || state.promoting) return;
  if (state.guestTries >= MAX_TRIES) {
    // 一直找不到对方：可能两端都退成了接入方（房间 ID 还没释放），
    // 尝试反转成发起方，把死锁解开
    attemptPromote();
    return;
  }
  state.guestTries++;

  closeConn();
  if (!state.peer || state.peer.destroyed) {
    attemptPromote();
    return;
  }

  const conn = state.peer.connect(state.room, {
    reliable: true,
    serialization: 'raw'
  });
  attach(conn);
  dlog('guest connect try', state.guestTries, '->', state.room);

  clearTimeout(state.retryTimer);
  state.retryTimer = setTimeout(() => {
    if (!state.connected && !state.leaving) guestConnect();
  }, RETRY_MS);
}

// 接入方长时间连不上时，反过来抢占房间当发起方；抢不到就恢复接入继续试
async function attemptPromote() {
  if (state.promoting || state.leaving || state.connected) return;
  if (state.role !== 'guest') return;
  if (state.promoteCount >= MAX_PROMOTE) {
    setStatus('warn', '未找到对方');
    systemMsg('连接超时：请确认对方也在同一页面并输入了相同密码；可点右上角「离开会话」后重新进入');
    return;
  }
  state.promoteCount++;
  state.promoting = true;
  dlog('promote attempt', state.promoteCount);
  setStatus('wait', '正在尝试重新建立连接…');

  const roomId = state.room;
  closeConn();
  clearTimeout(state.retryTimer);
  state.retryTimer = null;
  if (state.peer && !state.peer.destroyed) {
    try { state.peer.destroy(); } catch (e) { /* noop */ }
  }
  state.peer = null;

  state.role = 'host';
  try {
    await openHost(roomId);
    saveSession();
    state.guestTries = 0;
    setStatus('idle', '等待对方进入');
    systemMsg('已切换为发起方，等待对方接入');
    state.promoting = false;
    return;
  } catch (e) {
    dlog('promote failed', e.code || e.message);
  }

  // 抢不到（房间确实被对方占着），回到接入方继续尝试
  state.role = 'guest';
  try {
    await openGuest();
    state.guestTries = 0;
    state.promoting = false;
    setStatus('wait', '正在连接对方…');
    guestConnect();
  } catch (e) {
    state.promoting = false;
    setStatus('warn', '连接失败');
  }
}

/* ---------------- 入口 ---------------- */

let entering = false;

function showPassError(focus) {
  el.passError.classList.remove('hidden');
  el.passInput.classList.add('invalid');
  if (focus) {
    el.passInput.focus();
    el.passInput.select();
  }
}

// 输对密码即进入：先尝试作为发起方注册，若房间已被占用则自动转为接入
async function enterSession(roomId) {
  state.room = roomId;
  state.role = 'host';
  try {
    await openHost(roomId);
    enterChat();
    setStatus('idle', '等待对方进入');
  } catch (e) {
    if (e.code === 'unavailable-id') {
      // 对方已经占了这个房间，自动改为接入
      state.role = null;
      await joinRoom(roomId);
      return;
    }
    state.role = null;
    state.room = null;
    alert(e.message);
  }
}

async function joinRoom(roomId) {
  try {
    await openGuest();
    state.room = roomId;
    state.role = 'guest';
    state.guestTries = 0;
    state.promoteCount = 0;
    enterChat();
    setStatus('wait', '正在连接对方…');
    guestConnect();
  } catch (e) {
    state.role = null;
    state.room = null;
    alert(e.message);
  }
}

// 校验密码，正确则自动进入
async function tryEnter(focusOnError) {
  if (entering || state.role) return;
  const pass = el.passInput.value.trim().toUpperCase();
  if (pass !== ROOM_PASS) {
    showPassError(focusOnError);
    return;
  }
  entering = true;
  el.passError.classList.add('hidden');
  el.passInput.classList.remove('invalid');
  el.passInput.blur();
  try {
    await enterSession(roomIdFor(pass));
  } finally {
    entering = false;
  }
}

function enterChat() {
  el.landing.classList.add('hidden');
  el.chat.classList.remove('hidden');
  if (state.role !== 'host') el.emptyState.classList.add('hidden');
  renderAvatars();
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
  addText('me', msg.text, msg.ts, msg.id);
  el.msgInput.value = '';
  autosize();
}

function addText(who, text, ts, id) {
  const mine = who === 'me';

  const row = document.createElement('div');
  row.className = 'msg ' + (mine ? 'me' : 'peer');
  if (id) row.dataset.id = id;

  if (!mine) row.appendChild(makeAvatar('peer'));

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const textSpan = document.createElement('span');
  textSpan.className = 'text';
  textSpan.textContent = text;
  bubble.appendChild(textSpan);

  const meta = document.createElement('span');
  meta.className = 'meta';

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = fmtTime(ts);
  meta.appendChild(time);

  if (mine && id) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'recall';
    btn.textContent = '撤回';
    btn.addEventListener('click', () => recallMessage(id));
    meta.appendChild(btn);
    scheduleRecallExpiry(btn, ts);
  }

  bubble.appendChild(meta);
  row.appendChild(bubble);

  if (mine) row.appendChild(makeAvatar('me'));

  append(row);
}

// 2 分钟一到，撤回按钮自动消失
function scheduleRecallExpiry(btn, ts) {
  const left = RECALL_WINDOW - (Date.now() - (ts || Date.now()));
  if (left <= 0) {
    btn.remove();
    return;
  }
  setTimeout(() => {
    if (btn.isConnected) btn.remove();
  }, left);
}

function findMessageRow(id) {
  return el.messages.querySelector('.msg[data-id="' + id + '"]');
}

function recallMessage(id) {
  if (!id) return;
  const row = findMessageRow(id);
  if (!row) return;
  if (isOpen()) {
    try {
      state.conn.send(JSON.stringify({ t: 'recall', id }));
    } catch (e) { /* noop */ }
  }
  markRecalled(row, true);
}

function markRecalled(row, mine) {
  const bubble = row.querySelector('.bubble');
  if (!bubble) return;
  bubble.innerHTML = '';
  bubble.className = 'bubble recalled';
  const tip = document.createElement('span');
  tip.className = 'recall-tip';
  tip.textContent = mine ? '你撤回了一条消息' : '对方撤回了一条消息';
  bubble.appendChild(tip);
  row.classList.add('recalled');
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
    addText('peer', msg.text, msg.ts, msg.id);
  } else if (msg.t === 'recall') {
    const row = findMessageRow(msg.id);
    if (row) markRecalled(row, false);
  } else if (msg.t === 'file-start') {
    if (state.incoming) state.incoming = null;
    const meta = {
      name: msg.name || '未命名文件',
      size: Number(msg.size) || 0,
      mime: msg.mime || 'application/octet-stream',
      voice: !!msg.voice,
      duration: Number(msg.duration) || 0
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
  const mine = who === 'me';

  const row = document.createElement('div');
  row.className = 'msg ' + (mine ? 'me' : 'peer');

  if (!mine) row.appendChild(makeAvatar('peer'));

  const bubble = document.createElement('div');
  bubble.className = 'bubble file' + (meta.voice ? ' voice' : '');

  const head = document.createElement('div');
  head.className = 'file-head';

  const name = document.createElement('div');
  name.className = 'file-name';
  name.textContent = meta.voice ? '语音消息' : meta.name;

  const size = document.createElement('div');
  size.className = 'file-size';
  size.textContent = meta.voice ? fmtDuration(meta.duration || 0) : fmtSize(meta.size);

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
  if (mine) row.appendChild(makeAvatar('me'));
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
  } else if ((node.meta.mime || '').startsWith('audio/')) {
    const audio = document.createElement('audio');
    audio.className = 'voice-player';
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = url;
    node.bubble.insertBefore(audio, node.bubble.firstChild);
  }

  node.bubble.appendChild(link);
}

// mm:ss 格式化，用于语音消息时长与通话计时
function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
}

async function drain() {
  const dc = state.conn && state.conn.dataChannel;
  if (!dc) return;
  while (dc.bufferedAmount > MAX_BUFFERED && isOpen()) {
    await sleep(30);
  }
}

async function sendOneFile(file, opts = {}) {
  const id = uid();
  const meta = {
    name: file.name || ('粘贴图片-' + Date.now() + '.png'),
    size: file.size,
    mime: file.type || 'application/octet-stream',
    voice: !!opts.voice,
    duration: opts.duration || 0
  };

  state.conn.send(JSON.stringify({
    t: 'file-start',
    id,
    name: meta.name,
    size: meta.size,
    mime: meta.mime,
    voice: meta.voice,
    duration: meta.duration
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

/* ---------------- 实时语音通话 ---------------- */

function remotePeerId() {
  return state.conn ? state.conn.peer : null;
}

// 发起通话：拿麦克风 → peer.call 对方 → 等远端流
async function startCall() {
  if (state.inCall || state.calling) return;
  if (!isOpen()) { systemMsg('尚未建立直连'); return; }
  const remoteId = remotePeerId();
  if (!remoteId) { systemMsg('对方尚未就绪'); return; }

  state.calling = true;
  el.btnCall.classList.add('calling');
  el.btnCall.title = '呼叫中…';

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    state.calling = false;
    el.btnCall.classList.remove('calling');
    el.btnCall.title = '语音通话';
    if (e && e.name === 'NotAllowedError') systemMsg('麦克风权限被拒绝，请在浏览器设置中允许');
    else if (e && e.name === 'NotFoundError') systemMsg('未检测到麦克风');
    else systemMsg('无法访问麦克风：' + (e && e.message));
    return;
  }

  state.localStream = stream;
  const call = state.peer.call(remoteId, stream);
  state.call = call;
  wireCall(call);
}

// 接听来电（自动）：拿麦克风 → answer
async function answerCall(call) {
  state.calling = true;
  el.btnCall.classList.add('calling');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    try { call.close(); } catch (err) { /* noop */ }
    state.calling = false;
    el.btnCall.classList.remove('calling');
    systemMsg('无法接听：麦克风不可用');
    return;
  }
  state.localStream = stream;
  state.call = call;
  call.answer(stream);
  wireCall(call);
}

function wireCall(call) {
  call.on('stream', (remoteStream) => {
    if (!state.remoteAudio) {
      state.remoteAudio = new Audio();
      state.remoteAudio.autoplay = true;
    }
    state.remoteAudio.srcObject = remoteStream;
    onCallEstablished();
  });
  call.on('close', () => onCallClosed());
  call.on('error', () => onCallClosed());
}

function onCallEstablished() {
  state.inCall = true;
  state.calling = false;
  el.btnCall.classList.remove('calling');
  el.btnCall.classList.add('in-call');
  el.btnCall.title = '挂断';
  showCallBar();
}

function endCall() {
  if (state.call) { try { state.call.close(); } catch (e) { /* noop */ } }
  onCallClosed();
}

function onCallClosed() {
  state.inCall = false;
  state.calling = false;
  state.call = null;
  el.btnCall.classList.remove('calling', 'in-call');
  el.btnCall.title = '语音通话';
  hideCallBar();
  stopLocalStream();
  if (state.remoteAudio) {
    try { state.remoteAudio.srcObject = null; } catch (e) { /* noop */ }
  }
}

function stopLocalStream() {
  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => { try { t.stop(); } catch (e) { /* noop */ } });
    state.localStream = null;
  }
}

let callTimer = null;

function showCallBar() {
  clearInterval(callTimer);
  el.callBar.classList.remove('hidden');
  const t0 = Date.now();
  el.callTime.textContent = '00:00';
  callTimer = setInterval(() => {
    el.callTime.textContent = fmtDuration((Date.now() - t0) / 1000);
  }, 1000);
}

function hideCallBar() {
  clearInterval(callTimer);
  callTimer = null;
  el.callBar.classList.add('hidden');
}

/* ---------------- 语音消息 ---------------- */

let recorder = null;
let recChunks = [];
let recStart = 0;
let recTimer = null;

async function startRecording() {
  if (state.recording) return;
  if (!isOpen()) { systemMsg('尚未建立直连'); return; }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    if (e && e.name === 'NotAllowedError') systemMsg('麦克风权限被拒绝，请在浏览器设置中允许');
    else if (e && e.name === 'NotFoundError') systemMsg('未检测到麦克风');
    else systemMsg('无法访问麦克风');
    return;
  }

  recChunks = [];
  const mime = MediaRecorder.isTypeSupported('audio/webm')
    ? 'audio/webm'
    : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '');

  recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) recChunks.push(e.data); };
  recorder.onstop = () => {
    stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) { /* noop */ } });
    finalizeRecording(mime || 'audio/webm');
  };
  recorder.start();
  recStart = Date.now();
  state.recording = true;
  el.btnVoice.classList.add('recording');
  el.btnVoice.title = '录音中，点击停止';

  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - recStart) / 1000);
    el.btnVoice.title = '录音中 ' + s + 's，点击停止';
  }, 500);
}

function stopRecording() {
  if (!state.recording || !recorder) return;
  clearInterval(recTimer);
  recorder.stop();
  state.recording = false;
  el.btnVoice.classList.remove('recording');
  el.btnVoice.title = '按住录音';
}

function finalizeRecording(mime) {
  const duration = Math.max(1, Math.round((Date.now() - recStart) / 1000));
  const blob = new Blob(recChunks, { type: mime });
  if (blob.size < 300) {
    systemMsg('录音太短，未发送');
    return;
  }
  const ext = mime === 'audio/mp4' ? 'm4a' : 'webm';
  const file = new File([blob], '语音消息.' + ext, { type: mime });
  sendOneFile(file, { voice: true, duration });
}

/* ---------------- 网络自检 ---------------- */

// 单独开一个 Peer 测信令服务器是否可达
function testSignalServer() {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    let peer;

    const finish = (ok, err) => {
      if (done) return;
      done = true;
      try { peer && peer.destroy(); } catch (e) { /* noop */ }
      resolve({ ok, ms: Date.now() - t0, err: err || null });
    };

    const timer = setTimeout(() => finish(false, '超时'), 10000);

    try {
      peer = new Peer('diag' + randomId(10), Object.assign({}, PEER_OPTS, { token: randomId(16) }));
    } catch (e) {
      clearTimeout(timer);
      finish(false, e.message);
      return;
    }

    peer.on('open', () => {
      clearTimeout(timer);
      finish(true);
    });

    peer.on('error', (e) => {
      clearTimeout(timer);
      finish(false, (e && (e.type || e.message)) || 'unknown');
    });
  });
}

// 用指定的 ICE 服务器收集候选，看能不能拿到中继
function probeIceWith(servers, timeout) {
  return new Promise((resolve) => {
    const counts = { host: 0, srflx: 0, relay: 0, prflx: 0 };
    const seen = new Set();

    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: servers });
    } catch (e) {
      resolve({ counts, error: e.message });
      return;
    }

    pc.onicecandidate = (e) => {
      const c = e.candidate;
      if (!c || !c.candidate || seen.has(c.candidate)) return;
      seen.add(c.candidate);
      const t = c.type || 'host';
      counts[t] = (counts[t] || 0) + 1;
    };

    try {
      pc.createDataChannel('probe');
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(() => { /* noop */ });
    } catch (e) { /* noop */ }

    setTimeout(() => {
      try { pc.close(); } catch (e) { /* noop */ }
      resolve({ counts, error: null });
    }, timeout);
  });
}

function renderDiagResult(sig, results) {
  const anyRelay = results.some((r) => r.counts.relay > 0);

  const rows = results.map((r) => {
    const c = r.counts;
    const tag = c.relay > 0
      ? '<b class="diag-ok">中继 ' + c.relay + ' 可用</b>'
      : (c.srflx > 0 ? '仅公网映射，无中继' : '不可用');
    return '<p class="diag-line">' + r.label + '：' + tag + '</p>';
  }).join('');

  let verdict;
  let kind;

  if (!sig.ok) {
    kind = 'bad';
    verdict = '信令服务器连不上（' + (sig.err || '未知') + '）。两端无法互相找到，其他配置再好也没用。' +
      '请确认网络没有拦截 wss://peer.incubateur.education.gouv.fr。';
  } else if (anyRelay) {
    kind = 'ok';
    verdict = '信令与至少一条中继可用。如果仍连不上，可能是路由器开了「AP 隔离」' +
      '（同一 WiFi 下设备互不相通），可尝试用手机流量与电脑互连。';
  } else {
    kind = 'bad';
    verdict = '信令通，但所有中继都失败（中继全部为 0）。这意味着跨网络无法建立连接。' +
      '需要换一个在你网络中可用的 TURN 服务器。';
  }

  el.diagBody.innerHTML =
    '<p class="diag-line">信令服务器：<b>' +
    (sig.ok ? '连通 ' + sig.ms + ' ms' : '失败（' + (sig.err || '未知') + '）') +
    '</b></p>' + rows +
    '<p class="diag-verdict ' + kind + '">' + verdict + '</p>';
}

async function runDiagnostics() {
  el.diagPanel.classList.remove('hidden');
  el.diagBody.textContent = '正在测试信令服务器（最多 10 秒）…';

  const sig = await testSignalServer();

  el.diagBody.textContent = '正在逐个测试中继服务器（约 8 秒）…';
  const results = await Promise.all(
    PROBE_TARGETS.map((t) =>
      probeIceWith(t.servers, 8000).then((r) => ({ label: t.label, counts: r.counts }))
    )
  );

  renderDiagResult(sig, results);
}

/* ---------------- 交互绑定 ---------------- */

function autosize() {
  el.msgInput.style.height = 'auto';
  el.msgInput.style.height = Math.min(el.msgInput.scrollHeight, 120) + 'px';
}

function leave() {
  state.leaving = true;
  if (state.recording) { try { stopRecording(); } catch (e) { /* noop */ } }
  if (state.inCall || state.calling) { try { endCall(); } catch (e) { /* noop */ } }
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

el.passInput.addEventListener('input', () => {
  const pass = el.passInput.value.trim().toUpperCase();
  el.passError.classList.add('hidden');
  el.passInput.classList.remove('invalid');

  if (pass === ROOM_PASS) {
    tryEnter(false);
  } else if (pass.length >= ROOM_PASS.length) {
    showPassError(false);
  }
});

el.passInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    tryEnter(true);
  }
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

el.btnLeave.addEventListener('click', leave);

// 语音通话
el.btnCall.addEventListener('click', () => {
  if (state.inCall || state.calling) endCall();
  else startCall();
});
el.btnHangup.addEventListener('click', endCall);

// 语音消息（点击开始 / 点击停止）
el.btnVoice.addEventListener('click', () => {
  if (state.recording) stopRecording();
  else startRecording();
});

el.btnDiag.addEventListener('click', runDiagnostics);
el.diagClose.addEventListener('click', () => el.diagPanel.classList.add('hidden'));

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

  if (saved && /^[a-z0-9]{8,64}$/.test(saved.room || '') &&
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

  // 入口页的头像预览
  document.querySelectorAll('[data-avatar]').forEach((node) => {
    node.innerHTML = AVATARS[Number(node.dataset.avatar) || 0].svg;
  });
})();
