# Saltline — online co-op rooms

Online multiplayer for **Saltline — 100 Contracts**. A small Node server hosts the
game page and a WebSocket room service; players create or join rooms, and the host
deploys the whole squad onto a contract together.

## Run it

```bash
cd saltline
npm install
npm start            # http://localhost:8080  (set PORT to change)
```

Open the page in two browsers, pick **Multiplayer** on the title or pause menu, host a
room in one and join it from the other. Use the room code or the **Copy invite** link
(`?room=CODE`).

`npm test` runs the server, room and character-model tests.

### Hosting

`npm start` is all a host like Render, Fly or Railway needs. It serves the game at `/`,
the room socket at `/ws` and a health check at `/healthz`. To host the page somewhere
else (static hosting), run `npm run build` and serve `dist/`. Then point the page at your
server with `?server=wss://your-server.example/ws`.

## What is shared

| | |
|---|---|
| **Rooms** | Public (listed) or private (code only) rooms, 2–8 players, ready-up, kick, host migration when the host leaves, auto-rejoin after a dropped connection. |
| **Deploy** | The host picks the contract (up to their own unlocked level) and deploys. Every member starts the same contract. Players who join mid-run get **Join the run in progress**. |
| **Teammates** | A full human breacher model (see below) with a name tag and health bar, and tracers from their muzzle when they fire. A squad panel shows each teammate's status. |
| **Objectives** | Relays cut by anyone are cut for everyone, including players who retry or join late. When any player reaches the boat, the whole squad extracts. |
| **Comms** | Room chat in the lobby. In the field, press **T** to chat. The feed also shows teammate cuts, kills, downs and redeploys. |

Hostiles are simulated by each player's own game: enemies, waves and damage are local,
and only the events above are synchronised. Pausing therefore only pauses your own
fight. Dying shows the normal debrief, and **Retry** puts you back into the shared run
with the squad's progress.

## How it fits together

- `game/Saltline_Levels.html` is the original, unmodified game.
- `patch.js` applies three small anchored patches when the server starts:
  - it exposes the game's level and objective internals as `window.__G.mp_hooks`;
  - it adds the **Multiplayer** menu buttons;
  - it loads the client.

  Each anchor must match exactly once, so a changed game file fails loudly instead of
  breaking silently.
- `client/mp.js` and `client/mp.css` are the lobby, HUD and sync.
- `client/avatar.js` is the teammate character model (below).

## Teammate model

Teammates are Port Authority breachers built from primitives at runtime, like the rest of
the game, so nothing is downloaded.

- **Body:** an athletic adult of about 1.83 m, matching the 1.80 m first-person player and
  its 1.68 m eye height. The torso is V-tapered and the limbs are shaped with deltoids,
  biceps, quads and calves.
- **Kit:** high-cut helmet with headset and the game's amber goggles, plate carrier with
  pouches and radio, and an assault pack. The pack has a reflective band and bolt cutters
  for cutting relays. Team colour shows on glowing armbands, the chest patch and an IR
  strobe.
- **Variety:** skin tone, hair and facial hair come from the player id, so every client
  sees the same person.
- **Arms:** both hands are solved with two-bone IK onto the rifle grips. Teammates hold
  the rifle at low ready, shoulder it with a bladed torso when aiming or firing, carry it
  across the body when sprinting, and kneel when crouched.
- **Legs and body:** two-bone IK plants the feet, with a cadence and stride that match
  ground speed. The legs tuck in the air, and a downed teammate lies propped on the pack.
- **Cost:** about 24 draw calls and 24k vertices per teammate.
- `rooms.js` holds the transport-independent room logic. `server.js` handles HTTP, the
  WebSocket, per-socket rate limiting, message size limits and heartbeats.
