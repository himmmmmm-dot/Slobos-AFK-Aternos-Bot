'use strict';
// Transport-agnostic room logic. A "client" is any object with a unique `id`
// and a `send(message)` function, which keeps this module testable without sockets.

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const LIMITS = { name: 16, roomName: 24, chat: 200, relayId: 40, minPlayers: 2, maxPlayers: 8, levels: 100 };
const FEED_KINDS = new Set(['down', 'retry', 'kill']);
const COLORS = 8;

function cleanText(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function num(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function int(value, min, max, fallback) {
  return Math.round(num(value, min, max, fallback));
}

class RoomManager {
  constructor({ maxRooms = 200, random = Math.random } = {}) {
    this.maxRooms = maxRooms;
    this.random = random;
    this.rooms = new Map();
    this.clients = new Map();
    this.runSeq = 0;
    this.listTimer = null;
  }

  // ---- connection lifecycle ----

  connect(client) {
    client.name = client.name || 'Breacher';
    client.room = null;
    client.ready = false;
    this.clients.set(client.id, client);
    client.send({ t: 'welcome', id: client.id });
  }

  disconnect(client) {
    this.leave(client, { silent: true });
    this.clients.delete(client.id);
  }

  handle(client, msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    const fn = this.handlers[msg.t];
    if (fn) fn.call(this, client, msg);
  }

  // ---- helpers ----

  error(client, message) {
    client.send({ t: 'error', message });
  }

  newCode() {
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[Math.floor(this.random() * CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('could not allocate a room code');
  }

  summary(room) {
    return {
      code: room.code,
      name: room.name,
      host: this.clients.get(room.hostId)?.name || '',
      players: room.players.size,
      max: room.max,
      level: room.level,
      inRun: !!(room.run && !room.run.extracted),
    };
  }

  snapshot(room) {
    return {
      code: room.code,
      name: room.name,
      host: room.hostId,
      max: room.max,
      private: room.private,
      level: room.level,
      run: room.run ? { id: room.run.id, level: room.run.level, cut: [...room.run.cut], extracted: room.run.extracted } : null,
      players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, ready: p.ready, color: p.color })),
    };
  }

  broadcast(room, msg, except = null) {
    for (const p of room.players.values()) if (p !== except) p.send(msg);
  }

  pushRoom(room) {
    this.broadcast(room, { t: 'room', room: this.snapshot(room) });
    this.scheduleList();
  }

  system(room, text) {
    this.broadcast(room, { t: 'chat', system: true, text, ts: Date.now() });
  }

  publicRooms() {
    return [...this.rooms.values()].filter((r) => !r.private).map((r) => this.summary(r));
  }

  // Lobby browsers (clients not in a room) get the list pushed when rooms change.
  scheduleList() {
    if (this.listTimer) return;
    this.listTimer = setTimeout(() => {
      this.listTimer = null;
      const msg = { t: 'rooms', rooms: this.publicRooms() };
      for (const c of this.clients.values()) if (!c.room) c.send(msg);
    }, 200);
    this.listTimer.unref?.();
  }

  close() {
    clearTimeout(this.listTimer);
    this.listTimer = null;
  }

  hostOf(client) {
    const room = client.room;
    if (!room) return null;
    if (room.hostId !== client.id) {
      this.error(client, 'Only the host can do that.');
      return null;
    }
    return room;
  }

  addToRoom(client, room) {
    const used = new Set([...room.players.values()].map((p) => p.color));
    let color = 0;
    while (used.has(color) && color < COLORS - 1) color++;
    client.color = color;
    client.ready = false;
    client.room = room;
    room.players.set(client.id, client);
  }

  leave(client, { silent = false, kicked = false } = {}) {
    const room = client.room;
    if (!room) return;
    room.players.delete(client.id);
    client.room = null;
    client.ready = false;
    if (!silent) client.send({ t: 'left', kicked });
    if (room.players.size === 0) {
      this.rooms.delete(room.code);
      this.scheduleList();
      return;
    }
    this.broadcast(room, { t: 'gone', id: client.id });
    this.system(room, `${client.name} ${kicked ? 'was removed from' : 'left'} the room.`);
    if (room.hostId === client.id) {
      const next = room.players.values().next().value;
      room.hostId = next.id;
      this.system(room, `${next.name} is now the host.`);
    }
    this.pushRoom(room);
  }

  runOf(client, msg) {
    const run = client.room && client.room.run;
    if (!run || run.id !== Number(msg.run)) return null;
    return run;
  }
}

RoomManager.prototype.handlers = {
  hello(client, msg) {
    client.name = cleanText(msg.name, LIMITS.name) || 'Breacher';
    client.send({ t: 'hello', id: client.id, name: client.name });
    if (client.room) this.pushRoom(client.room);
  },

  list(client) {
    client.send({ t: 'rooms', rooms: this.publicRooms() });
  },

  create(client, msg) {
    if (this.rooms.size >= this.maxRooms) return this.error(client, 'The server is full. Try again later.');
    this.leave(client, { silent: true });
    const room = {
      code: this.newCode(),
      name: cleanText(msg.name, LIMITS.roomName) || `${client.name}'s crew`,
      hostId: client.id,
      max: int(msg.max, LIMITS.minPlayers, LIMITS.maxPlayers, 4),
      private: !!msg.private,
      level: int(msg.level, 1, LIMITS.levels, 1),
      run: null,
      players: new Map(),
      created: Date.now(),
    };
    this.rooms.set(room.code, room);
    this.addToRoom(client, room);
    this.pushRoom(room);
  },

  join(client, msg) {
    const code = cleanText(msg.code, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const room = this.rooms.get(code);
    if (!room) return this.error(client, `No room with code ${code || '—'}.`);
    if (client.room === room) return this.pushRoom(room);
    if (room.players.size >= room.max) return this.error(client, 'That room is full.');
    this.leave(client, { silent: true });
    this.addToRoom(client, room);
    this.system(room, `${client.name} joined.`);
    this.pushRoom(room);
  },

  leave(client) {
    this.leave(client);
  },

  ready(client, msg) {
    if (!client.room) return;
    client.ready = !!msg.ready;
    this.pushRoom(client.room);
  },

  level(client, msg) {
    const room = this.hostOf(client);
    if (!room) return;
    room.level = int(msg.level, 1, LIMITS.levels, room.level);
    this.pushRoom(room);
  },

  start(client) {
    const room = this.hostOf(client);
    if (!room) return;
    room.run = { id: ++this.runSeq, level: room.level, cut: new Set(), extracted: null, started: Date.now() };
    for (const p of room.players.values()) p.ready = false;
    this.broadcast(room, { t: 'start', run: { id: room.run.id, level: room.level } });
    this.system(room, `${client.name} deployed the squad on contract ${room.level}.`);
    this.pushRoom(room);
  },

  kick(client, msg) {
    const room = this.hostOf(client);
    if (!room) return;
    const target = room.players.get(String(msg.id));
    if (!target || target === client) return;
    this.leave(target, { kicked: true });
  },

  chat(client, msg) {
    const room = client.room;
    const text = cleanText(msg.text, LIMITS.chat);
    if (!room || !text) return;
    this.broadcast(room, { t: 'chat', id: client.id, name: client.name, color: client.color, text, ts: Date.now() });
  },

  // Player transform/status snapshot, relayed to everyone else in the room.
  st(client, msg) {
    const room = client.room;
    if (!room || !Array.isArray(msg.p) || msg.p.length !== 3) return;
    this.broadcast(room, {
      t: 'st',
      id: client.id,
      run: int(msg.run, 0, Number.MAX_SAFE_INTEGER, 0),
      lv: int(msg.lv, 0, LIMITS.levels, 0),
      gs: cleanText(msg.gs, 12),
      p: msg.p.map((v) => num(v, -1e4, 1e4)),
      y: num(msg.y, -100, 100),
      pi: num(msg.pi, -3.2, 3.2),
      hp: int(msg.hp, 0, 1000, 0),
      mhp: int(msg.mhp, 1, 1000, 100),
      al: !!msg.al,
      cr: !!msg.cr,
    }, client);
  },

  fire(client, msg) {
    const room = client.room;
    if (!room || !Array.isArray(msg.o) || !Array.isArray(msg.d) || msg.o.length !== 3 || msg.d.length !== 3) return;
    this.broadcast(room, {
      t: 'fire',
      id: client.id,
      o: msg.o.map((v) => num(v, -1e4, 1e4)),
      d: msg.d.map((v) => num(v, -1, 1)),
    }, client);
  },

  cut(client, msg) {
    const run = this.runOf(client, msg);
    const relay = cleanText(msg.relay, LIMITS.relayId);
    if (!run || !relay || run.extracted || run.cut.has(relay)) return;
    run.cut.add(relay);
    this.broadcast(client.room, { t: 'cut', run: run.id, relay, id: client.id, name: client.name });
  },

  extract(client, msg) {
    const run = this.runOf(client, msg);
    if (!run || run.extracted) return;
    run.extracted = client.name;
    this.broadcast(client.room, { t: 'extract', run: run.id, id: client.id, name: client.name });
    this.pushRoom(client.room);
  },

  ev(client, msg) {
    const room = client.room;
    const kind = String(msg.kind);
    if (!room || !FEED_KINDS.has(kind)) return;
    this.broadcast(room, { t: 'ev', id: client.id, name: client.name, kind, what: cleanText(msg.what, 16) }, client);
  },

  ping(client, msg) {
    client.send({ t: 'pong', t0: num(msg.t0, 0, Number.MAX_SAFE_INTEGER) });
  },
};

module.exports = { RoomManager, cleanText, LIMITS, CODE_ALPHABET };
