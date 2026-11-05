// Turbo Kart GP game server.
// HTTP accounts + leaderboard, WebSocket lobbies and race sync, and the
// single-file client at GET /.
//
// Local default port is 4747 because that is the address the game page tells
// you to open. Render injects PORT.

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { createStore } = require('./store');
const { createGame } = require('./game');
const { presentUser } = require('./ranks');

const ROOT = path.join(__dirname, '..');
const CLIENT = path.join(ROOT, 'turbo-kart-gp.html');
const NETLIFY_ORIGIN = 'https://turbokartgp.netlify.app';

const store = createStore();
const game = createGame(store);

function originAllowed(origin, hostHeader) {
  if (!origin) return true;
  let url;
  try { url = new URL(origin); } catch { return false; }
  if (url.origin === NETLIFY_ORIGIN) return true;
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return true;
  const host = String(hostHeader || '').split(',')[0].trim();
  // Same host the browser loaded (Render's public hostname, or local).
  if (host && url.host === host) return true;
  return false;
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !originAllowed(origin, req.headers.host)) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

const attempts = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'local';
  const bucket = attempts.get(ip) || [];
  const recent = bucket.filter((at) => now - at < 10 * 60 * 1000);
  if (recent.length >= 100) {
    res.status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
    return;
  }
  recent.push(now);
  attempts.set(ip, recent);
  next();
}

function bearer(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(\S+)/i.exec(header);
  return match ? match[1] : '';
}

function validName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 14) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

function validPassword(password) {
  return typeof password === 'string' && password.length >= 1 && password.length <= 100;
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    applyCors(req, res);
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));

  app.get('/health', (req, res) => {
    res.status(200).type('text/plain').send('ok');
  });

  app.get('/api/leaderboard', wrap(async (req, res) => {
    const rows = await store.rankedLeaderboard(20);
    res.json({
      top: rows.map(presentUser),
      online: game.onlineCount(),
    });
  }));

  app.get('/api/me', wrap(async (req, res) => {
    const user = await store.userForToken(bearer(req));
    res.json({ user: user ? presentUser(user) : null });
  }));

  app.post('/api/register', rateLimit, wrap(async (req, res) => {
    const body = req.body || {};
    const username = validName(body.username);
    if (!username || !validPassword(body.password)) {
      res.status(400).json({ error: 'Enter a username (1–14 characters) and a password' });
      return;
    }
    const user = await store.createUser({ name: username, password: body.password });
    if (!user) {
      res.status(409).json({ error: 'That username is taken' });
      return;
    }
    const token = await store.createSession(user.id);
    res.json({ token, user: presentUser(user) });
  }));

  app.post('/api/login', rateLimit, wrap(async (req, res) => {
    const body = req.body || {};
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    if (!username || !validPassword(body.password)) {
      res.status(400).json({ error: 'Enter a username and password' });
      return;
    }
    const user = await store.verifyLogin(username, body.password);
    if (!user) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }
    const token = await store.createSession(user.id);
    res.json({ token, user: presentUser(user) });
  }));

  app.post('/api/logout', wrap(async (req, res) => {
    const user = await store.userForToken(bearer(req));
    if (user) {
      await store.deleteSessionsForUser(user.id);
      game.kick(user.id);
    }
    res.json({ ok: true });
  }));

  app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(CLIENT);
  });

  app.get('/turbo-kart-gp.html', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(CLIENT);
  });

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) res.status(404).json({ error: 'Not found' });
    else res.status(404).type('text/plain').send('Not found');
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  });

  return app;
}

function attachWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { /* leave */ }
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    if (!originAllowed(req.headers.origin, req.headers.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    let token = '';
    try { token = new URL(req.url, 'http://localhost').searchParams.get('token') || ''; } catch { /* empty */ }
    const ping = setInterval(() => {
      if (ws.readyState === 1) ws.ping();
    }, 25000);
    if (ping.unref) ping.unref();

    store.userForToken(token).then((user) => {
      if (ws.readyState !== 1) return;
      if (!user) {
        sendJson(ws, { t: 'error', msg: 'Please log in again' });
        ws.close(4001, 'unauthorized');
        return;
      }
      ws.userId = user.id;
      game.attach(ws, user).catch((err) => console.error('attach', err));
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        game.onMessage(user.id, typeof data === 'string' ? data : data.toString());
      });
    }).catch((err) => {
      console.error('ws auth', err);
      ws.close(1011, 'error');
    });

    ws.on('close', () => {
      clearInterval(ping);
      if (ws.userId) game.detach(ws, ws.userId);
    });
    ws.on('error', () => { /* close follows */ });
  });

  return wss;
}

function sendJson(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function start(port = process.env.PORT || 4747) {
  const app = createApp();
  const server = http.createServer(app);
  attachWebSocket(server);
  const numeric = Number(port) || 4747;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(numeric, '0.0.0.0', () => {
      const bound = server.address().port;
      game.setPublicPort(bound);
      resolve(server);
    });
  });
}

if (require.main === module) {
  start().then((server) => {
    const { port } = server.address();
    console.log(`Turbo Kart GP listening on http://localhost:${port}`);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { start, createApp };
