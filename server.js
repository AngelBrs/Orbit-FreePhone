const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { rateLimit } = require('express-rate-limit');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// FIX: Use /tmp instead of /var/task/data on serverless deployments.
// For persistent hosting, set DATA_FILE to a path on persistent storage.
const FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join('/tmp', 'orbit-data', 'network.json');

fs.mkdirSync(path.dirname(FILE), { recursive: true });

let db = fs.existsSync(FILE)
  ? JSON.parse(fs.readFileSync(FILE, 'utf8'))
  : {
      users: [],
      sessions: [],
      numbers: [],
      messages: [],
      contacts: [],
      calls: [],
      keys: [],
      reads: {}
    };

const save = () => {
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(db, null, 2), {
    mode: 0o600
  });
  fs.renameSync(FILE + '.tmp', FILE);
};

const id = () => crypto.randomUUID();
const hash = s => crypto.createHash('sha256').update(s).digest('hex');

async function passwordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + (await scrypt(password, salt, 64)).toString('hex');
}

async function passwordOK(password, stored) {
  const [salt, key] = stored.split(':');
  const check = await scrypt(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(key, 'hex'), check);
}

const prefixes = ['+12', '+67', '+30'];

function makeNumber(prefix) {
  let number;

  do {
    number = prefix + String(crypto.randomInt(1000000, 10000000));
  } while (db.numbers.some(n => n.number === number));

  const row = {
    id: id(),
    number,
    prefix,
    userId: null,
    createdAt: Date.now()
  };

  db.numbers.push(row);
  return row;
}

function replenish() {
  for (const p of prefixes) {
    while (db.numbers.filter(n => n.prefix === p && !n.userId).length < 12) {
      makeNumber(p);
    }
  }
}

const pub = u => ({
  id: u.id,
  username: u.username,
  number: u.number,
  role: u.role,
  createdAt: u.createdAt,
  suspended: !!u.suspended,
  avatar: u.avatar || 'violet'
});

const userByNumber = n => db.users.find(u => u.number === n && !u.suspended);
const sockets = new Map();

function sendTo(uid, data) {
  for (const ws of sockets.get(uid) || []) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }
}

function broadcast(data) {
  for (const uid of sockets.keys()) sendTo(uid, data);
}

function notifyUsers(data, ids) {
  for (const uid of new Set(ids)) sendTo(uid, data);
}

function cookie(req) {
  const m = (req.headers.cookie || '').match(/(?:^|; )orbit_session=([^;]+)/);
  return m && m[1];
}

function sessionUser(req) {
  const token = cookie(req);
  if (!token) return null;

  const session = db.sessions.find(
    s => s.hash === hash(token) && s.expires > Date.now()
  );

  if (!session) return null;

  return db.users.find(
    u => u.id === session.userId && !u.suspended
  );
}

function error(res, status, message) {
  return res.status(status).json({ error: message });
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');

  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, PATCH, DELETE, OPTIONS'
    );

    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }

  next();
});

app.use('/api', rateLimit({
  windowMs: 60000,
  limit: 240,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a minute.' }
}));

const authLimit = rateLimit({
  windowMs: 15 * 60000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many sign-in attempts. Please try again later.'
  }
});

app.use('/api', (req, res, next) => {
  if (req.headers.authorization?.startsWith('Bearer ')) {
    const key = db.keys.find(
      k => !k.revoked &&
        k.hash === hash(req.headers.authorization.slice(7))
    );

    if (key) {
      req.user = db.users.find(
        u => u.id === key.userId && !u.suspended
      );
      req.apiKey = key;
    }
  } else {
    req.user = sessionUser(req);
  }

  if (
    !req.apiKey &&
    !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
    req.headers.origin
  ) {
    try {
      if (new URL(req.headers.origin).host !== req.headers.host) {
        return error(res, 403, 'Cross-site request blocked.');
      }
    } catch {
      return error(res, 403, 'Invalid origin.');
    }
  }

  next();
});

function auth(req, res, next) {
  if (!req.user) {
    return error(res, 401, 'Sign in or provide a valid API key.');
  }
  next();
}

function webOnly(req, res, next) {
  if (req.apiKey) {
    return error(res, 403, 'This action requires a browser session.');
  }
  next();
}

function scope(scopeName) {
  return (req, res, next) => {
    if (req.apiKey && !req.apiKey.scopes.includes(scopeName)) {
      return error(res, 403, `API key requires ${scopeName} permission.`);
    }
    next();
  };
}

function admin(req, res, next) {
  if (req.user.role !== 'admin' || req.apiKey) {
    return error(res, 403, 'Administrator browser session required.');
  }
  next();
}

function newSession(req, res, u) {
  const token = crypto.randomBytes(32).toString('hex');

  db.sessions.push({
    hash: hash(token),
    userId: u.id,
    expires: Date.now() + 30 * 86400000
  });

  db.sessions = db.sessions.filter(s => s.expires > Date.now());
  save();

  const secure = req.secure ? '; Secure; Partitioned' : '';
  const sameSite = req.secure ? 'None' : 'Lax';

  res.setHeader(
    'Set-Cookie',
    `orbit_session=${token}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=2592000${secure}`
  );
}

app.get('/api/numbers', (req, res) => {
  res.json({
    numbers: db.numbers
      .filter(n => !n.userId)
      .map(({ number, prefix }) => ({ number, prefix }))
  });
});

app.post('/api/auth/register', authLimit, async (req, res) => {
  const { username, password, number } = req.body;

  if (
    typeof username !== 'string' ||
    !/^[a-zA-Z0-9_]{3,24}$/.test(username)
  ) {
    return error(
      res,
      400,
      'Username must be 3–24 letters, numbers, or underscores.'
    );
  }

  if (
    typeof password !== 'string' ||
    password.length < 8 ||
    password.length > 128
  ) {
    return error(res, 400, 'Use a password with 8–128 characters.');
  }

  if (!db.numbers.some(n => n.number === number && !n.userId)) {
    return error(
      res,
      409,
      'This number is no longer available. Choose another.'
    );
  }

  const pass = await passwordHash(password);

  // Recheck after asynchronous hashing to prevent duplicate claims.
  if (
    db.users.some(
      u => u.username.toLowerCase() === username.toLowerCase()
    )
  ) {
    return error(res, 409, 'That username is already taken.');
  }

  const row = db.numbers.find(n => n.number === number && !n.userId);

  if (!row) {
    return error(res, 409, 'This number is no longer available.');
  }

  const u = {
    id: id(),
    username,
    number,
    password: pass,
    role: 'member',
    createdAt: Date.now(),
    suspended: false,
    avatar: ['violet', 'green', 'blue', 'pink'][crypto.randomInt(4)]
  };

  db.users.push(u);
  row.userId = u.id;
  replenish();
  newSession(req, res, u);

  res.status(201).json({ user: pub(u) });
});

app.post('/api/auth/login', authLimit, async (req, res) => {
  const { identity, password } = req.body;

  if (
    typeof identity !== 'string' ||
    typeof password !== 'string' ||
    password.length > 128
  ) {
    return error(
      res,
      400,
      'Enter your username or number and password.'
    );
  }

  const u = db.users.find(
    u =>
      u.username.toLowerCase() === identity.trim().toLowerCase() ||
      u.number === identity.replace(/[\s()-]/g, '')
  );

  if (!u || !(await passwordOK(password, u.password))) {
    return error(res, 401, 'Incorrect username, number, or password.');
  }

  if (u.suspended) {
    return error(
      res,
      403,
      'This account is suspended. Contact the network administrator.'
    );
  }

  newSession(req, res, u);
  res.json({ user: pub(u) });
});

app.post('/api/auth/logout', auth, webOnly, (req, res) => {
  const token = cookie(req);

  db.sessions = db.sessions.filter(s => s.hash !== hash(token));

  for (const ws of sockets.get(req.user.id) || []) {
    if (ws.tokenHash === hash(token)) ws.close(4001, 'Signed out');
  }

  save();

  res.setHeader(
    'Set-Cookie',
    `orbit_session=; HttpOnly; SameSite=${req.secure ? 'None' : 'Lax'}; Path=/; Max-Age=0${req.secure ? '; Secure; Partitioned' : ''}`
  );

  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ user: pub(req.user) });
});

app.get('/api/bootstrap', auth, webOnly, (req, res) => {
  const uid = req.user.id;

  const peerIds = new Set(
    db.messages
      .filter(m => m.from === uid || m.to === uid)
      .flatMap(m => [m.from, m.to])
  );

  db.contacts
    .filter(c => c.owner === uid)
    .forEach(c => peerIds.add(c.userId));

  db.calls
    .filter(c => c.from === uid || c.to === uid)
    .forEach(c => {
      peerIds.add(c.from);
      peerIds.add(c.to);
    });

  peerIds.delete(uid);

  const active = db.calls.find(
    c =>
      ['ringing', 'connected'].includes(c.status) &&
      (c.from === uid || c.to === uid)
  );

  res.json({
    user: pub(req.user),
    peers: db.users.filter(u => peerIds.has(u.id)).map(pub),
    messages: db.messages
      .filter(m => m.from === uid || m.to === uid)
      .slice(-2000),
    contacts: db.contacts.filter(c => c.owner === uid),
    calls: db.calls
      .filter(c => c.from === uid || c.to === uid)
      .slice(-200)
      .reverse(),
    reads: db.reads[uid] || {},
    online: [...sockets.keys()],
    activeCall: active || null,
    keys: db.keys
      .filter(k => k.userId === uid && !k.revoked)
      .map(({ hash, ...k }) => k)
  });
});

app.patch('/api/profile', auth, webOnly, async (req, res) => {
  const { username, currentPassword, newPassword } = req.body;

  if (username !== undefined) {
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
      return error(
        res,
        400,
        'Username must be 3–24 letters, numbers, or underscores.'
      );
    }

    if (
      db.users.some(
        u =>
          u.id !== req.user.id &&
          u.username.toLowerCase() === username.toLowerCase()
      )
    ) {
      return error(res, 409, 'Username already taken.');
    }
  }

  if (newPassword) {
    if (
      typeof newPassword !== 'string' ||
      newPassword.length < 8 ||
      newPassword.length > 128
    ) {
      return error(
        res,
        400,
        'New password must be 8–128 characters.'
      );
    }

    if (
      typeof currentPassword !== 'string' ||
      !(await passwordOK(currentPassword, req.user.password))
    ) {
      return error(res, 403, 'Current password is incorrect.');
    }

    req.user.password = await passwordHash(newPassword);

    const currentHash = hash(cookie(req));

    db.sessions = db.sessions.filter(
      s => s.userId !== req.user.id || s.hash === currentHash
    );

    for (const ws of sockets.get(req.user.id) || []) {
      if (ws.tokenHash !== currentHash) {
        ws.close(4001, 'Password changed');
      }
    }
  }

  if (username) req.user.username = username;

  save();
  broadcast({ type: 'profile', user: pub(req.user) });
  res.json({ user: pub(req.user) });
});

app.get('/api/users/lookup', auth, (req, res) => {
  const number = String(req.query.number || '').replace(/[\s()-]/g, '');
  const u = userByNumber(number);

  if (!u) return error(res, 404, 'No account uses that number.');

  res.json({ user: pub(u), online: sockets.has(u.id) });
});

app.get('/api/messages', auth, scope('messages:read'), (req, res) => {
  let messages = db.messages.filter(
    m => m.from === req.user.id || m.to === req.user.id
  );

  if (req.query.number) {
    const u = db.users.find(u => u.number === req.query.number);
    messages = u
      ? messages.filter(m => m.from === u.id || m.to === u.id)
      : [];
  }

  if (req.query.before) {
    messages = messages.filter(
      m => m.createdAt < Number(req.query.before)
    );
  }

  const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 500));

  res.json({
    messages: messages.slice(-limit).map(m => ({
      ...m,
      fromNumber: db.users.find(u => u.id === m.from)?.number,
      toNumber: db.users.find(u => u.id === m.to)?.number
    }))
  });
});

app.post('/api/messages', auth, scope('messages:write'), (req, res) => {
  const { to, text } = req.body;
  const u = userByNumber(to);

  if (!u) return error(res, 404, 'Recipient number not found.');
  if (u.id === req.user.id) {
    return error(res, 400, 'Choose someone else’s number.');
  }

  if (typeof text !== 'string' || !text.trim() || text.length > 4000) {
    return error(
      res,
      400,
      'Messages must contain 1–4,000 characters.'
    );
  }

  const message = {
    id: id(),
    from: req.user.id,
    to: u.id,
    text: text.trim(),
    createdAt: Date.now()
  };

  db.messages.push(message);
  save();

  notifyUsers(
    { type: 'message', message, sender: pub(req.user), recipient: pub(u) },
    [u.id, req.user.id]
  );

  res.status(201).json({ message });
});

app.post('/api/read', auth, webOnly, (req, res) => {
  const uid = req.body.userId;

  if (!db.users.some(u => u.id === uid)) {
    return error(res, 404, 'User not found.');
  }

  db.reads[req.user.id] ||= {};
  db.reads[req.user.id][uid] = Date.now();
  save();

  sendTo(req.user.id, {
    type: 'read',
    userId: uid,
    at: db.reads[req.user.id][uid]
  });

  res.json({ ok: true });
});

app.get('/api/contacts', auth, (req, res) => {
  res.json({
    contacts: db.contacts
      .filter(c => c.owner === req.user.id)
      .map(c => ({
        ...c,
        user: pub(db.users.find(u => u.id === c.userId))
      }))
  });
});

app.post('/api/contacts', auth, webOnly, (req, res) => {
  const u = userByNumber(req.body.number);

  if (!u) return error(res, 404, 'No account uses that number.');
  if (u.id === req.user.id) {
    return error(res, 400, 'You cannot add yourself as a contact.');
  }

  const name = String(req.body.name || u.username).trim().slice(0, 60);

  let contact = db.contacts.find(
    c => c.owner === req.user.id && c.userId === u.id
  );

  if (contact) {
    contact.name = name;
  } else {
    contact = {
      id: id(),
      owner: req.user.id,
      userId: u.id,
      name
    };
    db.contacts.push(contact);
  }

  save();
  sendTo(req.user.id, { type: 'contacts' });

  res.status(201).json({ contact, user: pub(u) });
});

app.delete('/api/contacts/:id', auth, webOnly, (req, res) => {
  db.contacts = db.contacts.filter(
    c => !(c.id === req.params.id && c.owner === req.user.id)
  );

  save();
  sendTo(req.user.id, { type: 'contacts' });

  res.json({ ok: true });
});

const timers = new Map();

function finishCall(c, status = 'ended') {
  if (!['ringing', 'connected'].includes(c.status)) return;

  clearTimeout(timers.get(c.id));
  timers.delete(c.id);

  c.status = status;
  c.endedAt = Date.now();
  save();

  notifyUsers({ type: 'call:update', call: c }, [c.from, c.to]);
}

app.get('/api/calls', auth, scope('calls:write'), (req, res) => {
  res.json({
    calls: db.calls
      .filter(c => c.from === req.user.id || c.to === req.user.id)
      .slice(-100)
      .reverse()
  });
});

app.get('/api/rtc-config', auth, webOnly, (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' }
  ];

  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_PASSWORD || ''
    });
  }

  res.json({
    iceServers,
    turnConfigured: !!process.env.TURN_URL
  });
});

app.post('/api/calls', auth, scope('calls:write'), (req, res) => {
  const u = userByNumber(req.body.to);

  if (!u) return error(res, 404, 'Recipient number not found.');
  if (u.id === req.user.id) {
    return error(res, 400, 'You cannot call your own number.');
  }
  if (!sockets.has(u.id)) {
    return error(
      res,
      409,
      'That person is offline. They need to open Orbit to receive calls.'
    );
  }
  if (!sockets.has(req.user.id)) {
    return error(
      res,
      409,
      'Open Orbit in a browser for this account to place an API-triggered call.'
    );
  }

  if (
    db.calls.some(
      c =>
        ['ringing', 'connected'].includes(c.status) &&
        [c.from, c.to].some(uid => uid === u.id || uid === req.user.id)
    )
  ) {
    return error(res, 409, 'One of these accounts is already in a call.');
  }

  const call = {
    id: id(),
    from: req.user.id,
    to: u.id,
    kind: req.body.kind === 'video' ? 'video' : 'voice',
    status: 'ringing',
    createdAt: Date.now(),
    source: req.apiKey ? 'api' : 'browser'
  };

  db.calls.push(call);
  save();

  notifyUsers(
    {
      type: 'call:incoming',
      call,
      caller: pub(req.user),
      recipient: pub(u)
    },
    [u.id, req.user.id]
  );

  timers.set(
    call.id,
    setTimeout(() => finishCall(call, 'missed'), 45000)
  );

  res.status(201).json({
    call,
    note: 'Both participants need Orbit open. Audio/video flows through browser WebRTC, not this REST response.'
  });
});

app.post('/api/calls/:id/:action', auth, scope('calls:write'), (req, res) => {
  const c = db.calls.find(
    c =>
      c.id === req.params.id &&
      (c.from === req.user.id || c.to === req.user.id)
  );

  if (!c) return error(res, 404, 'Call not found.');

  const action = req.params.action;

  if (action === 'accept') {
    if (req.apiKey) {
      return error(
        res,
        403,
        'Accept calls from a browser with microphone permission.'
      );
    }

    if (c.to !== req.user.id || c.status !== 'ringing') {
      return error(res, 409, 'Call is no longer available.');
    }

    clearTimeout(timers.get(c.id));
    timers.delete(c.id);

    c.status = 'connected';
    c.answeredAt = Date.now();
    save();

    notifyUsers({ type: 'call:update', call: c }, [c.from, c.to]);
  } else if (action === 'decline' || action === 'end') {
    finishCall(
      c,
      action === 'decline'
        ? 'declined'
        : c.status === 'ringing'
          ? 'cancelled'
          : 'ended'
    );
  } else {
    return error(res, 400, 'Use accept, decline, or end.');
  }

  res.json({ call: c });
});

app.post('/api/keys', auth, webOnly, (req, res) => {
  if (db.keys.filter(k => k.userId === req.user.id && !k.revoked).length >= 10) {
    return error(res, 400, 'Limit of 10 active keys. Revoke a key first.');
  }

  const name = String(req.body.name || '').trim().slice(0, 60);

  if (!name) return error(res, 400, 'Give this key a name.');

  const scopes = Array.isArray(req.body.scopes)
    ? req.body.scopes.filter(
        s => ['messages:read', 'messages:write', 'calls:write'].includes(s)
      )
    : [];

  if (!scopes.length) {
    return error(res, 400, 'Select at least one permission.');
  }

  const token = 'orb_live_' + crypto.randomBytes(28).toString('hex');

  const key = {
    id: id(),
    userId: req.user.id,
    name,
    prefix: token.slice(0, 16),
    hash: hash(token),
    scopes,
    createdAt: Date.now(),
    revoked: false
  };

  db.keys.push(key);
  save();

  const { hash: _, ...safe } = key;

  res.status(201).json({ key: safe, token });
});

app.delete('/api/keys/:id', auth, webOnly, (req, res) => {
  const key = db.keys.find(
    k => k.id === req.params.id && k.userId === req.user.id
  );

  if (!key) return error(res, 404, 'Key not found.');

  key.revoked = true;
  save();

  res.json({ ok: true });
});

app.get('/api/admin', auth, admin, (req, res) => {
  res.json({
    users: db.users.map(pub),
    numbers: db.numbers,
    messageCount: db.messages.length,
    callCount: db.calls.length,
    online: [...sockets.keys()]
  });
});

app.post('/api/admin/numbers', auth, admin, (req, res) => {
  if (!prefixes.includes(req.body.prefix)) {
    return error(res, 400, 'Allowed prefixes: +12, +67, +30.');
  }

  const count = Math.min(30, Math.max(1, parseInt(req.body.count) || 1));

  if (db.numbers.length > 3000) {
    return error(res, 400, 'Number pool is full.');
  }

  const numbers = Array.from(
    { length: count },
    () => makeNumber(req.body.prefix)
  );

  save();
  res.status(201).json({ numbers });
});

app.delete('/api/admin/numbers/:id', auth, admin, (req, res) => {
  const n = db.numbers.find(n => n.id === req.params.id);

  if (!n) return error(res, 404, 'Number not found.');
  if (n.userId) return error(res, 409, 'Assigned numbers cannot be deleted.');

  db.numbers = db.numbers.filter(n => n.id !== req.params.id);
  save();

  res.json({ ok: true });
});

app.patch('/api/admin/users/:id', auth, admin, (req, res) => {
  const u = db.users.find(u => u.id === req.params.id);

  if (!u) return error(res, 404, 'User not found.');

  if (u.role === 'admin') {
    return error(
      res,
      400,
      'The administrator account cannot be suspended or reassigned.'
    );
  }

  if (typeof req.body.suspended === 'boolean') {
    u.suspended = req.body.suspended;

    if (u.suspended) {
      db.sessions = db.sessions.filter(s => s.userId !== u.id);

      for (const ws of sockets.get(u.id) || []) {
        ws.close(4001, 'Account suspended');
      }

      db.calls
        .filter(c => c.from === u.id || c.to === u.id)
        .forEach(c => finishCall(c));
    }
  }

  if (req.body.number) {
    const n = db.numbers.find(
      n => n.number === req.body.number && !n.userId
    );

    if (!n) return error(res, 409, 'Choose an available number.');

    const old = db.numbers.find(n => n.userId === u.id);

    if (old) old.userId = null;

    n.userId = u.id;
    u.number = n.number;
  }

  save();
  broadcast({ type: 'profile', user: pub(u) });

  res.json({ user: pub(u) });
});

app.use('/api', (req, res) => {
  error(res, 404, 'API endpoint not found.');
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err.message);

  error(
    res,
    err.status || 500,
    err.status === 400
      ? 'Invalid JSON request.'
      : 'An unexpected error occurred.'
  );
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 64000
});

server.on('upgrade', (req, socket, head) => {
  let originOK = false;

  try {
    originOK = new URL(req.headers.origin).host === req.headers.host;
  } catch {}

  const user = sessionUser(req);

  if (req.url !== '/ws' || !user || !originOK) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, ws => {
    ws.user = user;
    ws.tokenHash = hash(cookie(req));
    wss.emit('connection', ws);
  });
});

wss.on('connection', ws => {
  const uid = ws.user.id;

  if (!sockets.has(uid)) sockets.set(uid, new Set());

  sockets.get(uid).add(ws);

  broadcast({ type: 'presence', userId: uid, online: true });

  ws.alive = true;

  ws.on('pong', () => {
    ws.alive = true;
  });

  ws.on('message', raw => {
    try {
      if (
        !db.sessions.some(
          s => s.hash === ws.tokenHash && s.expires > Date.now()
        ) ||
        ws.user.suspended
      ) {
        return ws.close(4001, 'Session expired');
      }

      const d = JSON.parse(raw);

      if (d.type === 'signal') {
        const c = db.calls.find(
          c =>
            c.id === d.callId &&
            c.status === 'connected' &&
            (c.from === uid || c.to === uid)
        );

        if (!c || !['offer', 'answer', 'ice'].includes(d.signal?.type)) {
          return;
        }

        sendTo(
          c.from === uid ? c.to : c.from,
          {
            type: 'signal',
            callId: c.id,
            signal: d.signal
          }
        );
      }

      if (d.type === 'typing') {
        const to = db.users.find(
          u => u.id === d.to && !u.suspended
        );

        if (to && to.id !== uid) {
          sendTo(to.id, { type: 'typing', from: uid });
        }
      }
    } catch {}
  });

  ws.on('close', () => {
    sockets.get(uid)?.delete(ws);

    if (!sockets.get(uid)?.size) {
      sockets.delete(uid);

      broadcast({
        type: 'presence',
        userId: uid,
        online: false
      });

      setTimeout(() => {
        if (!sockets.has(uid)) {
          db.calls
            .filter(c => c.from === uid || c.to === uid)
            .forEach(c =>
              finishCall(c, c.status === 'ringing' ? 'missed' : 'ended')
            );
        }
      }, 7000);
    }
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }

    ws.alive = false;
    ws.ping();
  }
}, 30000).unref();

(async () => {
  if (!db.users.length) {
    const number = makeNumber('+30');

    const u = {
      id: id(),
      username: 'Angelbrs12',
      password: await passwordHash(
        process.env.ADMIN_INITIAL_PASSWORD || '5121'
      ),
      number: number.number,
      role: 'admin',
      createdAt: Date.now(),
      suspended: false,
      avatar: 'violet'
    };

    db.users.push(u);
    number.userId = u.id;
  }

  db.calls.forEach(c => {
    if (['ringing', 'connected'].includes(c.status)) {
      c.status = 'ended';
      c.endedAt = Date.now();
    }
  });

  replenish();
  save();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Orbit network listening on 0.0.0.0:${PORT}`);
  });
})();
