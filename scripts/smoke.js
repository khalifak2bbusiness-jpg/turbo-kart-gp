// End-to-end check against a throwaway server: accounts, leaderboard, a friends
// race (relay + results), and a 4-human ranked race (MMR + leaderboard).
const http = require('http');
const { start } = require('../server/server');
const { labelFor, placementDelta } = require('../server/ranks');
const WebSocket = require('ws');

const failures = [];
function assert(cond, msg) {
  if (!cond) failures.push(msg);
}

function request(port, method, path, { token, body, origin, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    if (origin) headers.Origin = origin;
    const req = http.request({
      hostname: '127.0.0.1', port, path, method, headers: { ...headers, Host: host || `127.0.0.1:${port}` },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function connect(port, token, { origin } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (origin) headers.Origin = origin;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`, { headers });
    const inbox = [];
    const waiters = [];
    let cursor = 0;
    function take(pred) {
      for (let i = cursor; i < inbox.length; i++) {
        if (pred(inbox[i])) {
          cursor = i + 1;
          return inbox[i];
        }
      }
      return null;
    }
    ws.on('message', (buf) => {
      inbox.push(JSON.parse(buf.toString()));
      const waiter = waiters[0];
      if (!waiter) return;
      const msg = take(waiter.pred);
      if (!msg) return;
      waiters.shift();
      waiter.resolve(msg);
    });
    ws.on('error', (err) => {
      if (waiters.length) waiters.shift().reject(err);
      else reject(err);
    });
    ws.on('open', () => {
      resolve({
        ws,
        inbox,
        send(obj) { ws.send(JSON.stringify(obj)); },
        // Only matches a message that arrived after the previous waitFor hit,
        // so an older lobby snapshot can't satisfy a later assertion.
        waitFor(pred, ms = 3000) {
          const existing = take(pred);
          if (existing) return Promise.resolve(existing);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('timeout waiting for message; saw ' + JSON.stringify(inbox.slice(cursor).map((m) => m.t)))), ms);
            waiters.push({
              pred,
              resolve: (msg) => { clearTimeout(timer); res(msg); },
              reject: (err) => { clearTimeout(timer); rej(err); },
            });
          });
        },
        close() { ws.close(); },
      });
    });
  });
}

async function register(port, username, password = 'secret-pass') {
  const res = await request(port, 'POST', '/api/register', { body: { username, password } });
  assert(res.status === 200 && res.json && res.json.token && res.json.user.name === username, `register ${username}: ${res.status} ${res.text}`);
  assert(!('password' in (res.json.user || {})) && !('passwordHash' in (res.json.user || {})), 'password leaked');
  return res.json;
}

async function main() {
  assert(labelFor(0) === 'BRONZE III', 'bronze floor');
  assert(labelFor(2599) === 'DIAMOND I', 'diamond top');
  assert(labelFor(2600) === 'CHAMPION', 'champion');
  assert(placementDelta(1, 0, [0, 0, 0]) >= 8, 'win gains');
  assert(placementDelta(4, 1000, [1000, 1000, 1000]) <= -4, 'last loses');

  const server = await start(0);
  const port = server.address().port;
  try {
    const health = await request(port, 'GET', '/health');
    assert(health.status === 200 && health.text === 'ok', 'health');

    const board0 = await request(port, 'GET', '/api/leaderboard');
    assert(board0.status === 200 && Array.isArray(board0.json.top) && board0.json.top.length === 0 && board0.json.online === 0, 'empty board');

    const bad = await request(port, 'POST', '/api/register', { body: { username: '', password: '' } });
    assert(bad.status === 400 && bad.json.error, 'reject empty register');

    const ada = await register(port, 'Ada');
    assert(ada.user.mmr === 0 && ada.user.rank.label === 'BRONZE III' && ada.user.wins === 0 && ada.user.races === 0, 'new user shape');

    const dup = await request(port, 'POST', '/api/register', { body: { username: 'ada', password: 'whatever1' } });
    assert(dup.status === 409 && dup.json.error, 'duplicate name');

    const me = await request(port, 'GET', '/api/me', { token: ada.token });
    assert(me.status === 200 && me.json.user && me.json.user.name === 'Ada', '/api/me');

    const anon = await request(port, 'GET', '/api/me');
    assert(anon.status === 200 && anon.json.user === null, 'me without token');

    const wrong = await request(port, 'POST', '/api/login', { body: { username: 'Ada', password: 'nope' } });
    assert(wrong.status === 401 && wrong.json.error, 'bad password');

    const login = await request(port, 'POST', '/api/login', { body: { username: 'ada', password: 'secret-pass' } });
    assert(login.status === 200 && login.json.user.name === 'Ada', 'login case-insensitive');

    const page = await request(port, 'GET', '/');
    assert(page.status === 200 && page.text.includes('id="game"') && page.text.includes('TURBO') && page.text.includes('/api/leaderboard'), 'game page');

    const preflight = await request(port, 'OPTIONS', '/api/login', { origin: 'https://turbokartgp.netlify.app' });
    assert(preflight.status === 204, 'preflight status');
    assert(preflight.headers['access-control-allow-origin'] === 'https://turbokartgp.netlify.app', 'cors origin');
    assert(/authorization/i.test(preflight.headers['access-control-allow-headers'] || ''), 'cors auth header');

    const evil = await new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/ws?token=nope', method: 'GET',
        headers: {
          Connection: 'Upgrade', Upgrade: 'websocket', Origin: 'https://evil.example',
          'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          Host: `127.0.0.1:${port}`,
        },
      });
      req.on('upgrade', () => resolve('upgraded'));
      req.on('response', (res) => resolve(res.statusCode));
      req.on('error', () => resolve('error'));
      req.end();
    });
    assert(evil === 403, `bad origin should be 403, got ${evil}`);

    // Friends race: two humans, bots off, one lap. Relay st/ev, reject a spoofed fin, then finish.
    const grace = await register(port, 'Grace');
    const a = await connect(port, login.json.token);
    const b = await connect(port, grace.token);
    const helloA = await a.waitFor((m) => m.t === 'hello');
    const helloB = await b.waitFor((m) => m.t === 'hello');
    assert(helloA.user.name === 'Ada' && helloA.user.rank.label === 'BRONZE III', 'hello user');
    assert(Array.isArray(helloA.lan), 'hello lan');
    assert(helloB.user.name === 'Grace', 'hello grace');

    const online = await request(port, 'GET', '/api/leaderboard');
    assert(online.json.online === 2 && online.json.top.length === 0, 'online count before ranked');

    a.send({ t: 'createRoom' });
    const roomA = await a.waitFor((m) => m.t === 'room');
    assert(roomA.code && roomA.code.length === 4 && roomA.host === 'Ada' && roomA.laps === 3 && roomA.bots === true, 'create room');
    assert(roomA.members.length === 1 && roomA.members[0].rank === 'BRONZE III', 'member rank string');

    b.send({ t: 'joinRoom', code: roomA.code.toLowerCase() });
    const joined = await b.waitFor((m) => m.t === 'room' && m.members.length === 2);
    const joinedHost = await a.waitFor((m) => m.t === 'room' && m.members.length === 2);
    assert(joined.host === 'Ada' && joinedHost.members.some((m) => m.name === 'Grace'), 'join room');

    a.send({ t: 'roomSettings', laps: 1 });
    a.send({ t: 'roomSettings', bots: false });
    const configured = await b.waitFor((m) => m.t === 'room' && m.laps === 1 && m.bots === false);
    assert(configured.inMatch === false, 'settings applied');

    b.send({ t: 'startRoom' });
    const notHost = await b.waitFor((m) => m.t === 'error');
    assert(/host/i.test(notHost.msg), 'non-host cannot start');

    a.send({ t: 'startRoom' });
    const startA = await a.waitFor((m) => m.t === 'start');
    const startB = await b.waitFor((m) => m.t === 'start');
    assert(startA.ranked === false && startA.laps === 1 && startA.you !== startB.you, 'friends start slots');
    assert(startA.players.length === 2 && startA.players.every((p, i) => p.slot === i), 'dense slots');
    assert(startA.host === startA.you || startA.host === startB.you, 'host is a human slot');
    assert(startB.players[startB.you].name === 'Grace', 'you slot name');

    const pose = { x: 10.5, y: 20, a: 1.2, vx: 3, vy: 4, z: 0, sp: 80, d: 0, dt: 0, b: 0, sn: 0, vw: 0, l: 0, c: 1, pr: 0.4 };
    a.send({ t: 'st', slot: startA.you, s: pose });
    const relayed = await b.waitFor((m) => m.t === 'st');
    assert(relayed.slot === startA.you && relayed.s.pr === 0.4 && relayed.s.x === 10.5, 'st relay');
    assert(!a.inbox.some((m) => m.t === 'st'), 'st not echoed to sender');

    a.send({ t: 'ev', e: { k: 'coin', i: 2 } });
    const ev = await b.waitFor((m) => m.t === 'ev');
    assert(ev.e.k === 'coin' && ev.e.i === 2, 'ev relay');
    assert(!a.inbox.some((m) => m.t === 'ev'), 'ev not echoed');

    // Grace must not be able to file Ada's finish.
    b.send({ t: 'fin', slot: startA.you, time: 1 });
    a.send({ t: 'fin', slot: startA.you, time: 12.34 });
    b.send({ t: 'fin', slot: startB.you, time: 15.5 });
    const resA = await a.waitFor((m) => m.t === 'results', 4000);
    const resB = await b.waitFor((m) => m.t === 'results', 4000);
    assert(resA.mmr === null && resB.mmr === null, 'friends race is unranked');
    assert(resA.you === startA.you && resB.you === startB.you, 'results you');
    assert(resA.standings.length === 2, 'two standings');
    assert(resA.standings[0].slot === startA.you && resA.standings[0].time === 12.34, 'faster racer first');
    assert(resA.standings[1].time === 15.5 && resA.standings[0].dnf === false, 'second place time');
    const finAck = a.inbox.find((m) => m.t === 'fin' && m.slot === startA.you);
    assert(finAck && finAck.time === 12.34, 'fin ack echoed');

    const stillEmpty = await request(port, 'GET', '/api/leaderboard');
    assert(stillEmpty.json.top.length === 0, 'friends race stays off the board');

    // Host migration: a new room, host leaves mid-race, other human becomes bot host.
    a.send({ t: 'roomSettings', bots: true, laps: 2 });
    const reopened = await b.waitFor((m) => m.t === 'room' && m.inMatch === false && m.bots === true && m.laps === 2);
    assert(reopened.code === roomA.code, 'back to the same room');
    a.send({ t: 'startRoom' });
    const start2A = await a.waitFor((m) => m.t === 'start' && m.laps === 2);
    const start2B = await b.waitFor((m) => m.t === 'start' && m.laps === 2);
    assert(start2A.players.length === 4 && start2A.players.filter((p) => p.isBot).length === 2, 'bots fill the grid');
    assert(start2A.players.filter((p) => p.isBot).every((p) => p.elite === false), 'friend bots are not elite');
    assert(start2A.host === start2A.you, 'room host runs bots');
    a.send({ t: 'leaveMatch' });
    const left = await b.waitFor((m) => m.t === 'left');
    const hosted = await b.waitFor((m) => m.t === 'host');
    assert(left.slot === start2A.you, 'left slot');
    assert(hosted.slot === start2B.you, 'host migrated');
    b.send({ t: 'leaveMatch' });
    const roomAfter = await b.waitFor((m) => m.t === 'room' && m.inMatch === false, 4000);
    assert(roomAfter.bots === true, 'room survives an aborted race');

    a.send({ t: 'leaveRoom' });
    b.send({ t: 'leaveRoom' });
    await a.waitFor((m) => m.t === 'roomLeft');
    await b.waitFor((m) => m.t === 'roomLeft');
    a.close();
    b.close();

    // Ranked: 4 humans start immediately, no bots. Places follow finish times.
    const names = ['Ann', 'Bea', 'Cy', 'Dez'];
    const accounts = [];
    for (const name of names) accounts.push(await register(port, name));
    const sockets = [];
    for (const account of accounts) sockets.push(await connect(port, account.token));
    await Promise.all(sockets.map((sock) => sock.waitFor((m) => m.t === 'hello')));
    for (const sock of sockets) sock.send({ t: 'queue' });
    const statuses = await Promise.all(sockets.map((sock) => sock.waitFor((m) => m.t === 'queueStatus' || m.t === 'start')));
    // A full lobby may start before a status frame; either shape is valid as long as a start follows.
    assert(statuses.every((m) => m.t === 'queueStatus' || m.t === 'start'), 'queue or instant start');
    const starts = await Promise.all(sockets.map((sock) => sock.waitFor((m) => m.t === 'start', 4000)));
    assert(starts.every((m) => m.ranked === true && m.laps === 3 && m.players.length === 4), 'ranked grid');
    assert(starts[0].players.every((p) => p.isBot === false), 'no bots when the lobby is full');
    const times = [40, 30, 20, 10];
    sockets.forEach((sock, i) => {
      const you = starts[i].you;
      sock.send({ t: 'fin', slot: you, time: times[i] });
    });
    const rankedResults = await Promise.all(sockets.map((sock) => sock.waitFor((m) => m.t === 'results', 4000)));
    const dez = rankedResults[3];
    assert(dez.you === starts[3].you, 'dez slot');
    assert(dez.standings[0].name === 'Dez' && dez.standings[0].time === 10, 'fastest wins');
    assert(dez.standings.map((row) => row.name).join(',') === 'Dez,Cy,Bea,Ann', 'order by time');
    assert(dez.mmr && dez.mmr.delta > 0 && dez.mmr.after === dez.mmr.before + dez.mmr.delta, 'winner mmr');
    assert(dez.mmr.rankBefore === 'BRONZE III' && dez.user.mmr === dez.mmr.after && dez.user.wins === 1 && dez.user.races === 1, 'winner user');
    const ann = rankedResults[0];
    assert(ann.mmr.delta <= 0 && ann.mmr.after === 0 && ann.user.wins === 0 && ann.user.races === 1, 'last place floored at 0');

    const board = await request(port, 'GET', '/api/leaderboard', { token: accounts[3].token });
    assert(board.json.top[0].name === 'Dez' && board.json.top[0].rank.label === dez.user.rank.label, 'leaderboard winner');
    assert(board.json.top.length === 4, 'all four ranked');
    assert(board.json.top.every((row) => row.races === 1 && typeof row.mmr === 'number'), 'board columns');

    // Logout kills the session.
    const out = await request(port, 'POST', '/api/logout', { token: accounts[3].token, body: {} });
    assert(out.status === 200 && out.json.ok === true, 'logout');
    const meAfter = await request(port, 'GET', '/api/me', { token: accounts[3].token });
    assert(meAfter.json.user === null, 'token revoked');

    const missing = await request(port, 'POST', '/api/join-nope', {});
    // unknown path is not under a JSON 404 unless /api. This one is /api-less POST... use /api/nope
    const missingApi = await request(port, 'GET', '/api/nope');
    assert(missingApi.status === 404 && missingApi.json.error, 'unknown api');
    assert(missing.status === 404, 'unknown page');

    for (const sock of sockets) sock.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  if (failures.length) {
    console.error('SMOKE FAILED');
    for (const failure of failures) console.error(' - ' + failure);
    process.exit(1);
  }
  console.log('smoke ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
