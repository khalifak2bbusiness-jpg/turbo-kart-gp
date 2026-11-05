# Turbo Kart GP

A browser kart racer (Mode-7 canvas, single HTML file) and the Node game server it talks to. Open the server and the game is on `/`. Ranked matchmaking, private rooms, and the leaderboard go through `/api/*` and a WebSocket at `/ws`.

Accounts, sessions, and MMR are stored in memory behind `server/store.js`. A restart clears them. Swap that module for a database later without changing the routes or the race loop. Passwords are hashed with scrypt.

## Run locally

Requires Node.js 22.

```bash
npm install
npm start
```

Open http://localhost:4747 . The game page itself mentions that port. Create an account from **LOG IN TO PLAY ONLINE**, then use **RANKED ONLINE**, **PLAY WITH FRIENDS**, or **LEADERBOARD**.

`npm run smoke` boots the server on a random port and runs through register, login, `/api/me`, the leaderboard, a friends race, and a four-player ranked race.

## Deploy on Render (Blueprint)

1. Push this repository to GitHub.
2. In the [Render dashboard](https://dashboard.render.com), choose **New +** → **Blueprint**.
3. Connect the repository. Render reads `render.yaml` from the repo root.
4. Apply the Blueprint. It creates one **free** web service named `turbo-kart-gp`:
   - build: `npm install`
   - start: `npm start`
   - health check: `/health`
5. When the deploy is live, open `https://turbo-kart-gp.onrender.com`. The game loads from `/` and calls the API on the same origin.

Node 22 is pinned in `package.json` `engines`. The service listens on Render's `PORT`.

Free-plan notes:

- The instance sleeps after about 15 minutes without requests. The next visit wakes it, which can take a few seconds.
- Sleep, restart, and redeploy wipe in-memory accounts and ranks.
- There is one instance, so one memory store is the whole backend.

## HTTP API

The page sends `Authorization: Bearer <token>` and `Content-Type: application/json`. The token from login or register is what the WebSocket also takes as `?token=`. The client stores it in `localStorage` under `tkg_token`. It does not use cookies.

| Method | Path | Body | Success |
| --- | --- | --- | --- |
| `GET` | `/health` | | `200` text `ok` |
| `GET` | `/api/leaderboard` | | `{ top, online }` |
| `GET` | `/api/me` | | `{ user }` or `{ user: null }` |
| `POST` | `/api/register` | `{ username, password }` | `{ token, user }` |
| `POST` | `/api/login` | `{ username, password }` | `{ token, user }` |
| `POST` | `/api/logout` | `{}` | `{ ok: true }` and the session is dropped |

Failures are JSON `{ error: string }` with a non-200 status. The page prints `error` in the login form or the leaderboard table.

`user` is `{ name, mmr, wins, races, rank: { label } }`. `label` is a tier the page already colors: `BRONZE III` through `BRONZE I`, then Silver, Gold, Platinum, Diamond, and `CHAMPION`. New accounts start at 0 MMR, Bronze III. `top` is the same user shape, only people with at least one ranked race, highest MMR first (20 rows). `online` is how many accounts currently have a socket open.

Usernames are 1–14 characters, trimmed, unique case-insensitively. Passwords are 1–100 characters.

## WebSocket `/ws?token=`

Messages are JSON objects with a `t` field.

**Server → client**

| `t` | When | Fields the page reads |
| --- | --- | --- |
| `hello` | socket opens | `user`, `lan` (LAN URLs for the friends-room share link; empty on Render) |
| `queueStatus` | while queued, about once a second | `wait` seconds, `searching`, `backfillIn` seconds |
| `unqueued` | left the queue, or a match is starting | |
| `room` | lobby changed | `code`, `host` (name), `members: [{ name, rank }]`, `laps`, `bots`, `inMatch` |
| `roomLeft` | you were removed from the lobby | |
| `error` | rejected action | `msg` (toast) |
| `start` | race begins | `id`, `ranked`, `laps`, `host` (slot), `you` (your slot), `startIn` ms, `players` |
| `st` | someone else's kart pose | `slot`, `s` (relayed as sent) |
| `ev` | item event from another client | `e` |
| `fin` | finish confirmed | `slot`, `time` |
| `host` | bot driver changed | `slot` |
| `left` | a racer quit | `slot` |
| `results` | race closed | `you`, `standings`, `user`, `mmr` |

`players` entries are `{ slot, name, isBot, elite }` with slots `0..n-1` in order. The page indexes karts by slot, so the list is dense from 0. Ranked races are 3 laps. Empty spots are elite bots. A private room uses the host's lap count (1–5) and, when **FILL WITH BOTS** is on, normal bots. `elite: true` is what makes the page drive the harder bot profile.

`standings` entries are `{ slot, name, isBot, dnf, est, time }`. Real finishes come first, then estimated times (`est`), then `dnf`. For a ranked race, `mmr` is `{ before, after, delta, rankBefore, rankAfter }` and `user` is the updated account. Friends races send `mmr: null`.

**Client → server**

| `t` | Fields |
| --- | --- |
| `queue` | join ranked |
| `cancelQueue` | |
| `createRoom` | 4-letter code, 3 laps, bots on |
| `joinRoom` | `code` |
| `leaveRoom` | |
| `roomSettings` | `laps` and/or `bots` (host only) |
| `startRoom` | host only |
| `leaveMatch` | |
| `st` | `slot`, `s` (your kart, or a bot's kart if you are the bot host) |
| `ev` | `e` |
| `fin` | `slot`, `time` |

Ranked queue: a match starts immediately at 4 humans. With fewer, elite bots fill the grid when the 15 second backfill timer hits 0. One human is the bot host (`host` slot). If they leave, another human is assigned and everyone gets `host`.

Finish times are taken from the first valid `fin` for that slot. The server echoes `fin` so the page can set `finAck` and stop repeating it. When every racer still in the race has finished, results go out. If humans are done and bots never report a time, the server closes the race after 20 seconds and marks the rest estimated or DNF. A race also closes after 12 minutes.

MMR uses place plus the gap to the rest of the field (bots count as 1600 elite / 1000 friends). First place gains at least 8, last loses at least 4, and MMR never goes below 0. Only ranked races change `wins`, `races`, and MMR.

## CORS

`https://turbokartgp.netlify.app`, localhost, and the host the request arrived on may call the API and open `/ws`. The page served by this process is same-origin and does not need CORS.

The copy of the client in this repo (and the one on Netlify) turns online mode **off** when the hostname ends in `netlify.app`, and it always calls a relative `/api` and `/ws`. Serving that file from Netlify will not reach this Render service until the page is pointed at it. Loading `https://turbo-kart-gp.onrender.com` uses this server directly.

## Layout

```
turbo-kart-gp.html   game client, served at /
server/server.js     HTTP, WebSocket, static page
server/game.js       queue, rooms, race relay, results
server/store.js      accounts and sessions (in-memory)
server/ranks.js      tier labels and MMR deltas
render.yaml          Render Blueprint
scripts/smoke.js     protocol smoke test
```
