'use strict';
const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { createServer } = require('../server');
const { RoomManager } = require('../rooms');

function startServer() {
  return new Promise((resolve) => {
    const ctx = createServer();
    ctx.server.listen(0, '127.0.0.1', () => resolve({ ...ctx, port: ctx.server.address().port }));
  });
}

// Minimal test client that records every message and can await a predicate.
function connect(port, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const c = { ws, msgs: [], waiters: [] };
    c.send = (m) => ws.send(JSON.stringify(m));
    c.next = (pred, ms = 2000) => new Promise((res, rej) => {
      const hit = c.msgs.find(pred);
      if (hit) { c.msgs.splice(c.msgs.indexOf(hit), 1); return res(hit); }
      const w = { pred, res };
      c.waiters.push(w);
      setTimeout(() => { c.waiters = c.waiters.filter((x) => x !== w); rej(new Error('timeout waiting for message')); }, ms);
    });
    c.close = () => ws.close();
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      const w = c.waiters.find((x) => x.pred(m));
      if (w) { c.waiters = c.waiters.filter((x) => x !== w); w.res(m); } else c.msgs.push(m);
    });
    ws.on('open', async () => {
      const welcome = await c.next((m) => m.t === 'welcome');
      c.id = welcome.id;
      c.send({ t: 'hello', name });
      await c.next((m) => m.t === 'hello');
      resolve(c);
    });
    ws.on('error', reject);
  });
}

const roomMsg = (pred = () => true) => (m) => m.t === 'room' && pred(m.room);

test('serves the patched game and client assets', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.match(html, /i\.mp_hooks=\{SL,SLV,run:c,game:_,cut:me,extract:ee/);
  assert.equal(html.match(/data-act="mp"/g).length, 2);
  assert.match(html, /<script src="mp\.js"><\/script>\s*$/);
  for (const f of ['mp.js', 'mp.css']) assert.equal((await fetch(`http://127.0.0.1:${port}/${f}`)).status, 200);
  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.equal(health.ok, true);
  assert.equal((await fetch(`http://127.0.0.1:${port}/nope`)).status, 404);
});

test('rooms: create, list, join, ready, deploy, sync and leave', async (t) => {
  const { server, port } = await startServer();
  const a = await connect(port, 'Mara');
  const b = await connect(port, 'Ike');
  t.after(() => { a.close(); b.close(); server.close(); });

  a.send({ t: 'create', name: 'Night shift', max: 3, level: 7 });
  const created = (await a.next(roomMsg())).room;
  assert.equal(created.code.length, 5);
  assert.equal(created.host, a.id);
  assert.equal(created.level, 7);
  assert.equal(created.max, 3);

  b.send({ t: 'list' });
  const list = await b.next((m) => m.t === 'rooms' && m.rooms.length === 1);
  assert.deepEqual(list.rooms[0], { code: created.code, name: 'Night shift', host: 'Mara', players: 1, max: 3, level: 7, inRun: false });

  b.send({ t: 'join', code: created.code.toLowerCase() });
  const joined = (await b.next(roomMsg((r) => r.players.length === 2))).room;
  assert.deepEqual(joined.players.map((p) => p.name), ['Mara', 'Ike']);
  assert.notEqual(joined.players[0].color, joined.players[1].color);
  await a.next(roomMsg((r) => r.players.length === 2));

  b.send({ t: 'ready', ready: true });
  await a.next(roomMsg((r) => r.players[1].ready));

  // Only the host may change the contract or deploy.
  b.send({ t: 'start' });
  assert.match((await b.next((m) => m.t === 'error')).message, /host/i);
  a.send({ t: 'level', level: 12 });
  await b.next(roomMsg((r) => r.level === 12));

  a.send({ t: 'start' });
  const start = await b.next((m) => m.t === 'start');
  assert.equal(start.run.level, 12);
  const runId = start.run.id;

  // State snapshots go to the other players only, clamped to sane ranges.
  b.send({ t: 'st', run: runId, lv: 12, gs: 'playing', p: [1, 2, 99999], y: 0.5, pi: 0, hp: 80, mhp: 100, al: true, cr: false });
  const st = await a.next((m) => m.t === 'st');
  assert.deepEqual(st.p, [1, 2, 10000]);
  assert.equal(st.id, b.id);
  b.send({ t: 'fire', o: [0, 1, 0], d: [0, 0, -1] });
  assert.equal((await a.next((m) => m.t === 'fire')).id, b.id);

  // Relay cuts are deduplicated and only accepted for the current run.
  b.send({ t: 'cut', run: runId, relay: 'relay_a' });
  const cut = await a.next((m) => m.t === 'cut');
  assert.deepEqual([cut.relay, cut.name], ['relay_a', 'Ike']);
  await b.next((m) => m.t === 'cut');
  a.send({ t: 'cut', run: runId, relay: 'relay_a' });
  a.send({ t: 'cut', run: runId - 1, relay: 'relay_b' });
  a.send({ t: 'extract', run: runId });
  const ex = await b.next((m) => m.t === 'extract');
  assert.equal(ex.name, 'Mara');
  const after = (await b.next(roomMsg((r) => r.run && r.run.extracted))).room;
  assert.deepEqual(after.run.cut, ['relay_a']);
  assert.ok(!b.msgs.some((m) => m.t === 'cut'), 'duplicate or stale cut was relayed');

  // Host leaves: the remaining player becomes host.
  a.send({ t: 'leave' });
  await a.next((m) => m.t === 'left');
  const migrated = (await b.next(roomMsg((r) => r.players.length === 1))).room;
  assert.equal(migrated.host, b.id);
});

test('rooms: private rooms, full rooms, kicks, chat and bad codes', async (t) => {
  const { server, port } = await startServer();
  const a = await connect(port, 'Host');
  const b = await connect(port, '  Two\u0007  ');
  const c = await connect(port, 'Three');
  t.after(() => { a.close(); b.close(); c.close(); server.close(); });

  a.send({ t: 'create', max: 2, private: true });
  const room = (await a.next(roomMsg())).room;
  assert.equal(room.name, "Host's crew");
  c.send({ t: 'list' });
  assert.deepEqual((await c.next((m) => m.t === 'rooms')).rooms, []);

  b.send({ t: 'join', code: room.code });
  const r2 = (await b.next(roomMsg((r) => r.players.length === 2))).room;
  assert.equal(r2.players[1].name, 'Two');

  c.send({ t: 'join', code: room.code });
  assert.match((await c.next((m) => m.t === 'error')).message, /full/);
  c.send({ t: 'join', code: 'ZZZZZ' });
  assert.match((await c.next((m) => m.t === 'error')).message, /No room/);

  b.send({ t: 'chat', text: 'x'.repeat(500) });
  const chat = await a.next((m) => m.t === 'chat' && !m.system);
  assert.equal(chat.text.length, 200);

  a.send({ t: 'kick', id: b.id });
  assert.equal((await b.next((m) => m.t === 'left')).kicked, true);
  await a.next(roomMsg((r) => r.players.length === 1));
});

test('room manager removes empty rooms and ignores junk', () => {
  const rm = new RoomManager();
  const sent = [];
  const client = { id: 'a', send: (m) => sent.push(m) };
  rm.connect(client);
  rm.handle(client, null);
  rm.handle(client, { t: 'nope' });
  rm.handle(client, { t: 'st', p: 'bad' });
  rm.handle(client, { t: 'create' });
  assert.equal(rm.rooms.size, 1);
  rm.disconnect(client);
  assert.equal(rm.rooms.size, 0);
  rm.close();
});
