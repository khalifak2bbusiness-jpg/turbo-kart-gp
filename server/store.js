// Storage boundary. Everything account-shaped goes through this module so a
// hosted Postgres (or any other database) can replace the Maps below without
// touching HTTP or the race loop. Every method is async on purpose.
//
// Data in these Maps is wiped when the process exits. That matches a free
// dyno that restarts and sleeps: accounts and ranks do not survive a restart.

const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function scryptBuf(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, SCRYPT, (err, buf) => (err ? reject(err) : resolve(buf)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptBuf(password, salt);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = await scryptBuf(password, salt);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function tokenKey(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createStore() {
  const users = new Map(); // id -> user record
  const byName = new Map(); // lowercase name -> user id
  const sessions = new Map(); // sha256(token) -> user id

  return {
    async createUser({ name, password }) {
      const nameKey = name.toLowerCase();
      if (byName.has(nameKey)) return null;
      // Reserve the name before the async hash so two signups can't both win.
      byName.set(nameKey, 'pending');
      try {
        const passwordHash = await hashPassword(password);
        const user = {
          id: crypto.randomBytes(12).toString('hex'),
          name,
          nameKey,
          passwordHash,
          mmr: 0,
          wins: 0,
          races: 0,
          createdAt: Date.now(),
        };
        users.set(user.id, user);
        byName.set(nameKey, user.id);
        return user;
      } catch (err) {
        if (byName.get(nameKey) === 'pending') byName.delete(nameKey);
        throw err;
      }
    },

    async findUserByName(name) {
      if (typeof name !== 'string') return null;
      const id = byName.get(name.trim().toLowerCase());
      if (!id || id === 'pending') return null;
      return users.get(id) || null;
    },

    async findUserById(id) {
      return users.get(id) || null;
    },

    async verifyLogin(name, password) {
      const user = await this.findUserByName(name);
      if (!user) return null;
      const ok = await verifyPassword(password, user.passwordHash);
      return ok ? user : null;
    },

    async updateUser(id, patch) {
      const user = users.get(id);
      if (!user) return null;
      if (patch.mmr != null) user.mmr = patch.mmr;
      if (patch.wins != null) user.wins = patch.wins;
      if (patch.races != null) user.races = patch.races;
      return user;
    },

    async createSession(userId) {
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(tokenKey(token), userId);
      return token;
    },

    async userForToken(token) {
      if (!token) return null;
      const userId = sessions.get(tokenKey(token));
      if (!userId) return null;
      return users.get(userId) || null;
    },

    async deleteSessionsForUser(userId) {
      for (const [key, id] of sessions) if (id === userId) sessions.delete(key);
    },

    /** Players who have finished at least one ranked race, best MMR first. */
    async rankedLeaderboard(limit = 20) {
      return [...users.values()]
        .filter((user) => user.races > 0)
        .sort((a, b) => b.mmr - a.mmr || b.wins - a.wins || a.name.localeCompare(b.name))
        .slice(0, limit);
    },
  };
}

module.exports = { createStore, hashPassword, verifyPassword };
