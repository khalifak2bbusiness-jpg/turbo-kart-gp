// Lobbies, ranked queue, and race relay. The browser is authoritative for kart
// physics: this process matches people, relays `st` / `ev` / `fin`, decides
// when a race is over, and writes ranked MMR.
//
// Client contract (see turbo-kart-gp.html, onNet / Net.send):
//   hello, queueStatus, unqueued, room, roomLeft, error,
//   start, st, ev, fin, host, left, results

const crypto = require('crypto');
const { labelFor, presentUser, placementDelta, BOT_MMR } = require('./ranks');

const BACKFILL_MS = 15_000; // client copy says elite bots fill empty spots in 15s
const RANKED_LAPS = 3;
const MAX_RACERS = 4;
const RACE_CAP_MS = 12 * 60 * 1000;
const BOT_GRACE_MS = 20_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const BOT_NAMES = ['BOLT', 'VIPER', 'NOVA', 'AXEL', 'RILEY', 'MINT', 'DASH', 'KOI'];

function send(ws, msg) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(msg)); } catch { /* socket closing */ }
  }
}

function makeCode() {
  let code = '';
  for (let i = 0; i < 4; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function createGame(store, options = {}) {
  const clients = new Map(); // userId -> Set<WebSocket>
  const queue = []; // { userId, joinedAt }
  const rooms = new Map(); // code -> room
  const userRoom = new Map(); // userId -> code
  const matches = new Map(); // id -> match
  const userMatch = new Map(); // userId -> match id
  const reserving = new Set(); // user ids committed to a match that hasn't started
  let backfillAt = null;
  let publicPort = options.port || 4747;
  let statusAccum = 0;

  function lanUrls() {
    if (process.env.RENDER) return [];
    const os = require('os');
    const found = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const net of list || []) {
        if (!net || net.internal) continue;
        const v4 = net.family === 'IPv4' || net.family === 4;
        if (v4) found.push(net.address);
      }
    }
    const score = (ip) => (ip.startsWith('192.168.') ? 3 : ip.startsWith('10.') ? 2 : ip.startsWith('172.') ? 1 : 0);
    found.sort((a, b) => score(b) - score(a));
    return found.map((ip) => `http://${ip}:${publicPort}`);
  }

  function sendUser(userId, msg) {
    const set = clients.get(userId);
    if (!set) return;
    for (const ws of set) send(ws, msg);
  }

  function error(userId, msg) {
    sendUser(userId, { t: 'error', msg });
  }

  function onlineCount() {
    return clients.size;
  }

  function matchOf(userId) {
    const id = userMatch.get(userId);
    if (!id) return null;
    const match = matches.get(id);
    if (!match || match.ended) return null;
    return match;
  }

  function inRace(userId) {
    return reserving.has(userId) || !!matchOf(userId);
  }

  function roomOf(userId) {
    const code = userRoom.get(userId);
    if (!code) return null;
    return rooms.get(code) || null;
  }

  async function roomMessage(room) {
    const members = [];
    for (const member of room.members) {
      const user = await store.findUserById(member.userId);
      if (!user) continue;
      members.push({ name: user.name, rank: labelFor(user.mmr) });
    }
    return {
      t: 'room',
      code: room.code,
      host: members[0] ? members[0].name : '',
      laps: room.laps,
      bots: !!room.bots,
      inMatch: !!room.inMatch,
      members,
    };
  }

  async function broadcastRoom(room) {
    const msg = await roomMessage(room);
    // Host string must equal that member's account name; rebuild from the
    // current member list so a promoted host isn't stuck with the old name.
    const ids = room.members.map((member) => member.userId);
    for (const userId of ids) sendUser(userId, msg);
  }

  function pushQueueStatus() {
    const searching = queue.length;
    const backfillIn = !backfillAt
      ? 0
      : Math.max(0, Math.ceil((backfillAt - Date.now()) / 1000));
    for (const entry of queue) {
      sendUser(entry.userId, {
        t: 'queueStatus',
        wait: Math.max(0, Math.floor((Date.now() - entry.joinedAt) / 1000)),
        searching,
        backfillIn,
      });
    }
  }

  function pullQueue(userId) {
    const index = queue.findIndex((entry) => entry.userId === userId);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) backfillAt = null;
  }

  function cancelQueue(userId, { notify = true } = {}) {
    const was = queue.some((entry) => entry.userId === userId);
    pullQueue(userId);
    if (was && notify) sendUser(userId, { t: 'unqueued' });
    return was;
  }

  function controls(match, userId, player) {
    if (!player || player.left) return false;
    if (player.userId === userId) return true;
    return !!(player.isBot && match.hostUserId === userId);
  }

  function broadcast(match, msg, exceptUserId = null) {
    for (const player of match.players) {
      if (!player.userId || player.left) continue;
      if (player.userId === exceptUserId) continue;
      sendUser(player.userId, msg);
    }
  }

  function rosterOf(players) {
    // Slots are 0..n-1 in order. The client indexes `karts[slot]`, so the
    // roster has to be dense from slot 0 or remote updates land on the wrong kart.
    return players.map((player) => ({
      slot: player.slot,
      name: player.name,
      isBot: !!player.isBot,
      elite: !!player.elite,
    }));
  }

  function buildPlayers(humans, fillBots, ranked) {
    const players = humans.map((human, index) => ({
      slot: index,
      name: human.name,
      isBot: false,
      elite: false,
      userId: human.userId,
      mmr: human.mmr,
      finished: false,
      time: null,
      dnf: false,
      est: false,
      left: false,
      progress: 0,
    }));
    if (fillBots) {
      const used = new Set(players.map((player) => player.name.toLowerCase()));
      let cursor = 0;
      while (players.length < MAX_RACERS && cursor < 20) {
        let name = BOT_NAMES[cursor % BOT_NAMES.length];
        if (used.has(name.toLowerCase())) name = `${name} ${cursor + 1}`;
        while (used.has(name.toLowerCase())) name += '!';
        used.add(name.toLowerCase());
        players.push({
          slot: players.length,
          name,
          isBot: true,
          elite: !!ranked,
          userId: null,
          mmr: ranked ? BOT_MMR.elite : BOT_MMR.friend,
          finished: false,
          time: null,
          dnf: false,
          est: false,
          left: false,
          progress: 0,
        });
        cursor++;
      }
    }
    return players;
  }

  function beginMatch({ ranked, laps, humans, roomCode, fillBots }) {
    const players = buildPlayers(humans, fillBots, ranked);
    const host = players.find((player) => !player.isBot);
    const match = {
      id: crypto.randomBytes(4).toString('hex'),
      ranked: !!ranked,
      laps,
      roomCode: roomCode || null,
      hostUserId: host.userId,
      hostSlot: host.slot,
      players,
      startedAt: Date.now(),
      lastHumanFinish: 0,
      ended: false,
      finishing: false,
      endTimer: null,
    };
    matches.set(match.id, match);
    for (const player of players) if (player.userId) userMatch.set(player.userId, match.id);
    if (roomCode && rooms.has(roomCode)) rooms.get(roomCode).matchId = match.id;
    const roster = rosterOf(players);
    for (const player of players) {
      if (!player.userId) continue;
      sendUser(player.userId, {
        t: 'start',
        id: match.id,
        ranked: match.ranked,
        laps,
        host: host.slot,
        you: player.slot,
        startIn: 800,
        players: roster,
      });
    }
    return match;
  }

  function reassignHost(match) {
    const next = match.players.find((player) => !player.isBot && !player.left);
    if (!next) return;
    match.hostUserId = next.userId;
    match.hostSlot = next.slot;
    broadcast(match, { t: 'host', slot: next.slot });
  }

  function armEnd(match, delay) {
    if (match.ended || match.finishing) return;
    clearTimeout(match.endTimer);
    match.endTimer = setTimeout(() => {
      finishMatch(match).catch((err) => console.error('finish match', err));
    }, delay);
    if (match.endTimer.unref) match.endTimer.unref();
  }

  function noteFinish(match) {
    if (match.ended || match.finishing) return;
    const stillOut = match.players.filter((player) => !player.left);
    if (stillOut.length > 0 && stillOut.every((player) => player.finished)) armEnd(match, 350);
  }

  function releaseRoom(match) {
    if (!match.roomCode) return null;
    const room = rooms.get(match.roomCode);
    if (!room || room.matchId !== match.id) return null;
    room.inMatch = false;
    room.matchId = null;
    return room;
  }

  function abortMatch(match) {
    if (match.ended || match.finishing) return;
    match.ended = true;
    clearTimeout(match.endTimer);
    matches.delete(match.id);
    for (const player of match.players) if (player.userId) userMatch.delete(player.userId);
    const room = releaseRoom(match);
    if (room) broadcastRoom(room).catch((err) => console.error('room', err));
  }

  function closeTimes(match) {
    const real = match.players.filter((player) => player.finished && !player.dnf && !player.est);
    const pace = real.length ? Math.min(...real.map((player) => player.time)) : match.laps * 45;
    for (const player of match.players) {
      if (player.finished) continue;
      const progress = Math.max(0, Math.min(0.999, Number(player.progress) || 0));
      if (!player.left && progress >= 0.25) {
        player.est = true;
        player.dnf = false;
        player.finished = true;
        player.time = round2(pace / progress);
      } else {
        player.dnf = true;
        player.est = false;
        player.time = 0;
      }
    }
  }

  function sortStandings(players) {
    const key = (player) => {
      if (player.dnf || !player.finished) return 2;
      if (player.est) return 1;
      return 0;
    };
    return [...players].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      if (ka !== kb) return ka - kb;
      if (ka < 2) return (a.time || 0) - (b.time || 0);
      return (b.progress || 0) - (a.progress || 0);
    });
  }

  async function finishMatch(match) {
    if (match.ended || match.finishing) return;
    match.finishing = true;
    match.ended = true;
    clearTimeout(match.endTimer);
    closeTimes(match);
    const standings = sortStandings(match.players);
    const placeOf = new Map(standings.map((player, index) => [player.slot, index + 1]));
    const rewards = new Map();

    if (match.ranked) {
      for (const player of standings) {
        if (!player.userId) continue;
        const place = placeOf.get(player.slot);
        const opponents = standings.filter((other) => other.slot !== player.slot).map((other) => other.mmr);
        const after = Math.max(0, player.mmr + placementDelta(place, player.mmr, opponents));
        const user = await store.findUserById(player.userId);
        if (!user) continue;
        const win = place === 1 && !player.dnf && !player.est;
        const updated = await store.updateUser(player.userId, {
          mmr: after,
          races: user.races + 1,
          wins: user.wins + (win ? 1 : 0),
        });
        rewards.set(player.userId, {
          user: presentUser(updated),
          mmr: {
            before: player.mmr,
            after,
            delta: after - player.mmr,
            rankBefore: labelFor(player.mmr),
            rankAfter: labelFor(after),
          },
        });
      }
    }

    const payload = standings.map((player) => ({
      slot: player.slot,
      name: player.name,
      isBot: !!player.isBot,
      dnf: !!player.dnf,
      est: !!player.est && !player.dnf,
      time: player.dnf ? 0 : round2(player.time || 0),
    }));

    const room = releaseRoom(match);
    if (room) await broadcastRoom(room);

    for (const player of match.players) {
      if (!player.userId) continue;
      userMatch.delete(player.userId);
      if (player.left) continue;
      let user = null;
      let mmr = null;
      const reward = rewards.get(player.userId);
      if (reward) {
        user = reward.user;
        mmr = reward.mmr;
      } else {
        const record = await store.findUserById(player.userId);
        if (record) user = presentUser(record);
      }
      sendUser(player.userId, {
        t: 'results',
        you: player.slot,
        standings: payload,
        user,
        mmr,
      });
    }
    matches.delete(match.id);
  }

  function leaveMatch(userId) {
    const id = userMatch.get(userId);
    userMatch.delete(userId);
    if (!id) return;
    const match = matches.get(id);
    if (!match || match.ended || match.finishing) return;
    const player = match.players.find((entry) => entry.userId === userId);
    if (!player || player.left) return;
    player.left = true;
    broadcast(match, { t: 'left', slot: player.slot });
    const humans = match.players.filter((entry) => !entry.isBot);
    if (humans.every((entry) => entry.left)) {
      if (match.players.some((entry) => entry.finished)) armEnd(match, 400);
      else abortMatch(match);
      return;
    }
    if (match.hostUserId === userId) reassignHost(match);
    noteFinish(match);
  }

  async function leaveRoom(userId, { tellSelf = true } = {}) {
    const code = userRoom.get(userId);
    if (!code) return;
    userRoom.delete(userId);
    const room = rooms.get(code);
    if (!room) return;
    room.members = room.members.filter((member) => member.userId !== userId);
    if (tellSelf) sendUser(userId, { t: 'roomLeft' });
    if (room.members.length === 0) {
      rooms.delete(code);
      return;
    }
    await broadcastRoom(room);
  }

  async function onLeaveRoom(userId) {
    leaveMatch(userId);
    await leaveRoom(userId);
  }

  function launchRanked(entries) {
    const ids = new Set(entries.map((entry) => entry.userId));
    for (let i = queue.length - 1; i >= 0; i--) if (ids.has(queue[i].userId)) queue.splice(i, 1);
    if (queue.length === 0) backfillAt = null;
    for (const userId of ids) {
      reserving.add(userId);
      sendUser(userId, { t: 'unqueued' });
    }
    Promise.all([...ids].map(async (userId) => {
      const user = await store.findUserById(userId);
      // Drop anyone who disconnected or ducked into another race while we loaded.
      if (!user || !clients.has(userId) || userMatch.has(userId)) return null;
      return { userId: user.id, name: user.name, mmr: user.mmr };
    })).then((loaded) => {
      for (const userId of ids) reserving.delete(userId);
      const humans = loaded.filter(Boolean);
      if (humans.length === 0) return;
      beginMatch({
        ranked: true,
        laps: RANKED_LAPS,
        humans,
        roomCode: null,
        fillBots: humans.length < MAX_RACERS,
      });
    }).catch((err) => {
      for (const userId of ids) reserving.delete(userId);
      console.error('ranked start', err);
    });
  }

  function maybeStartRanked() {
    if (queue.length >= MAX_RACERS) launchRanked(queue.slice(0, MAX_RACERS));
    else if (queue.length > 0 && backfillAt && Date.now() >= backfillAt) launchRanked(queue.slice());
  }

  function onQueue(userId) {
    if (inRace(userId)) return error(userId, 'Leave your current race first');
    if (userRoom.has(userId)) return error(userId, 'Leave your room before queueing for ranked');
    if (!queue.some((entry) => entry.userId === userId)) queue.push({ userId, joinedAt: Date.now() });
    if (!backfillAt) backfillAt = Date.now() + BACKFILL_MS;
    pushQueueStatus();
    maybeStartRanked();
  }

  async function createRoom(userId) {
    if (inRace(userId)) return error(userId, 'Leave your current race first');
    if (userRoom.has(userId)) return error(userId, "You're already in a room");
    cancelQueue(userId);
    let code = makeCode();
    for (let i = 0; i < 8 && rooms.has(code); i++) code = makeCode();
    const room = { code, laps: 3, bots: true, inMatch: false, matchId: null, members: [{ userId }] };
    rooms.set(code, room);
    userRoom.set(userId, code);
    await broadcastRoom(room);
  }

  async function joinRoom(userId, codeRaw) {
    if (inRace(userId)) return error(userId, 'Leave your current race first');
    const code = String(codeRaw || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
    if (code.length !== 4) return error(userId, 'Room codes are 4 letters');
    const current = userRoom.get(userId);
    if (current === code) {
      const room = rooms.get(code);
      if (room) await broadcastRoom(room);
      return;
    }
    if (current) return error(userId, 'Leave your current room first');
    const room = rooms.get(code);
    if (!room) return error(userId, 'No room with that code');
    if (room.inMatch) return error(userId, 'That race already started');
    if (room.members.length >= MAX_RACERS) return error(userId, 'That room is full');
    cancelQueue(userId);
    room.members.push({ userId });
    userRoom.set(userId, code);
    await broadcastRoom(room);
  }

  async function roomSettings(userId, msg) {
    const room = roomOf(userId);
    if (!room) return;
    if (room.members[0].userId !== userId) return error(userId, 'Only the host can change settings');
    if (room.inMatch) return error(userId, 'Wait for the race to finish');
    if (typeof msg.laps === 'number' && Number.isFinite(msg.laps)) {
      room.laps = Math.max(1, Math.min(5, Math.round(msg.laps)));
    }
    if (typeof msg.bots === 'boolean') room.bots = msg.bots;
    await broadcastRoom(room);
  }

  async function startRoom(userId) {
    const room = roomOf(userId);
    if (!room) return error(userId, 'You are not in a room');
    if (room.members[0].userId !== userId) return error(userId, 'Only the host can start the race');
    if (room.inMatch) return error(userId, 'A race is already in progress');
    const humans = [];
    for (const member of room.members) {
      const user = await store.findUserById(member.userId);
      if (!user || userMatch.has(user.id)) continue;
      humans.push({ userId: user.id, name: user.name, mmr: user.mmr });
    }
    if (humans.length === 0) return error(userId, 'Nobody is ready to race');
    room.inMatch = true;
    await broadcastRoom(room);
    beginMatch({
      ranked: false,
      laps: room.laps,
      humans,
      roomCode: room.code,
      fillBots: !!room.bots,
    });
  }

  function onState(userId, msg) {
    const match = matchOf(userId);
    if (!match) return;
    const player = match.players.find((entry) => entry.slot === msg.slot);
    if (!controls(match, userId, player)) return;
    if (!msg.s || typeof msg.s !== 'object' || Array.isArray(msg.s)) return;
    if (typeof msg.s.pr === 'number' && Number.isFinite(msg.s.pr)) player.progress = msg.s.pr;
    broadcast(match, { t: 'st', slot: player.slot, s: msg.s }, userId);
  }

  function onEvent(userId, msg) {
    const match = matchOf(userId);
    if (!match) return;
    const me = match.players.find((entry) => entry.userId === userId && !entry.left);
    if (!me) return;
    if (!msg.e || typeof msg.e !== 'object' || Array.isArray(msg.e)) return;
    broadcast(match, { t: 'ev', e: msg.e }, userId);
  }

  function onFinish(userId, msg) {
    const match = matchOf(userId);
    if (!match) return;
    const player = match.players.find((entry) => entry.slot === msg.slot);
    if (!controls(match, userId, player)) return;
    if (player.finished) {
      sendUser(userId, { t: 'fin', slot: player.slot, time: player.time });
      return;
    }
    const time = Number(msg.time);
    if (!Number.isFinite(time) || time < 0 || time > 60 * 30) return;
    player.finished = true;
    player.dnf = false;
    player.est = false;
    player.time = round2(time);
    if (!player.isBot) match.lastHumanFinish = Date.now();
    // Echo to the sender too. The client repeats `fin` until it sees this ack.
    broadcast(match, { t: 'fin', slot: player.slot, time: player.time });
    noteFinish(match);
  }

  function sweep() {
    const now = Date.now();
    for (const match of matches.values()) {
      if (match.ended || match.finishing) continue;
      const humans = match.players.filter((player) => !player.isBot);
      const humansDone = humans.length > 0 && humans.every((player) => player.finished || player.left);
      const age = now - match.startedAt;
      if (age > RACE_CAP_MS) armEnd(match, 0);
      else if (humansDone && humans.some((player) => player.finished) && match.lastHumanFinish && now - match.lastHumanFinish > BOT_GRACE_MS) {
        armEnd(match, 0);
      } else noteFinish(match);
    }
  }

  const tickTimer = setInterval(() => {
    maybeStartRanked();
    sweep();
    statusAccum += 500;
    if (statusAccum >= 1000) {
      statusAccum = 0;
      if (queue.length) pushQueueStatus();
    }
  }, 500);
  if (tickTimer.unref) tickTimer.unref();

  async function helloFor(userId) {
    const user = await store.findUserById(userId);
    if (!user) return null;
    return { t: 'hello', user: presentUser(user), lan: lanUrls() };
  }

  return {
    onlineCount,
    setPublicPort(port) { publicPort = port; },

    async attach(ws, user) {
      let set = clients.get(user.id);
      if (!set) {
        set = new Set();
        clients.set(user.id, set);
      }
      set.add(ws);
      const hello = await helloFor(user.id);
      if (hello) send(ws, hello);
      const room = roomOf(user.id);
      if (room) send(ws, await roomMessage(room));
    },

    detach(ws, userId) {
      const set = clients.get(userId);
      if (!set || !set.has(ws)) return;
      set.delete(ws);
      if (set.size > 0) return;
      clients.delete(userId);
      cancelQueue(userId, { notify: false });
      // Last socket closed: drop them from the live race and the lobby.
      leaveMatch(userId);
      leaveRoom(userId, { tellSelf: false }).catch((err) => console.error('leave room', err));
    },

    kick(userId) {
      const set = clients.get(userId);
      if (!set) return;
      for (const ws of [...set]) {
        try { ws.close(4000, 'logged out'); } catch { /* already gone */ }
      }
    },

    onMessage(userId, raw) {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
      const run = () => {
        switch (msg.t) {
          case 'queue': return onQueue(userId);
          case 'cancelQueue': return cancelQueue(userId);
          case 'createRoom': return createRoom(userId);
          case 'joinRoom': return joinRoom(userId, msg.code);
          case 'leaveRoom': return onLeaveRoom(userId);
          case 'roomSettings': return roomSettings(userId, msg);
          case 'startRoom': return startRoom(userId);
          case 'leaveMatch': return leaveMatch(userId);
          case 'st': return onState(userId, msg);
          case 'ev': return onEvent(userId, msg);
          case 'fin': return onFinish(userId, msg);
          default: return undefined;
        }
      };
      try {
        const pending = run();
        if (pending && typeof pending.then === 'function') {
          pending.catch((err) => console.error('game message', err));
        }
      } catch (err) {
        console.error('game message', err);
      }
    },

    stop() { clearInterval(tickTimer); },
  };
}

module.exports = { createGame, BACKFILL_MS, RANKED_LAPS };
