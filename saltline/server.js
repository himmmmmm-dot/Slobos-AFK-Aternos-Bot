'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { RoomManager } = require('./rooms');
const { buildGame } = require('./patch');

const MAX_MESSAGE_BYTES = 4096;
const HEARTBEAT_MS = 30000;
// Token bucket per socket: state snapshots run at ~15/s, so this leaves headroom.
const RATE = { burst: 80, perSecond: 50, strikes: 400 };

function asset(body, type) {
  const buf = Buffer.from(body);
  return { type, raw: buf, gzip: zlib.gzipSync(buf), etag: '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"' };
}

function loadAssets() {
  const client = (f) => fs.readFileSync(path.join(__dirname, 'client', f), 'utf8');
  const html = asset(buildGame(), 'text/html; charset=utf-8');
  return {
    '/': html,
    '/index.html': html,
    '/avatar.js': asset(client('avatar.js'), 'text/javascript; charset=utf-8'),
    '/mp.js': asset(client('mp.js'), 'text/javascript; charset=utf-8'),
    '/mp.css': asset(client('mp.css'), 'text/css; charset=utf-8'),
  };
}

function createServer({ maxRooms } = {}) {
  const assets = loadAssets();
  const rooms = new RoomManager({ maxRooms });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, rooms: rooms.rooms.size, players: rooms.clients.size }));
    }
    const a = assets[url.pathname];
    if (!a || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    if (req.headers['if-none-match'] === a.etag) {
      res.writeHead(304, { etag: a.etag });
      return res.end();
    }
    const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const body = gzip ? a.gzip : a.raw;
    res.writeHead(200, {
      'content-type': a.type,
      'content-length': body.length,
      'cache-control': 'no-cache',
      etag: a.etag,
      vary: 'accept-encoding',
      ...(gzip ? { 'content-encoding': 'gzip' } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MESSAGE_BYTES });

  wss.on('connection', (ws) => {
    const client = {
      id: crypto.randomBytes(6).toString('hex'),
      send(msg) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
    };
    let tokens = RATE.burst;
    let last = Date.now();
    let strikes = 0;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    rooms.connect(client);

    ws.on('message', (data, isBinary) => {
      const now = Date.now();
      tokens = Math.min(RATE.burst, tokens + ((now - last) / 1000) * RATE.perSecond);
      last = now;
      if (tokens < 1) {
        if (++strikes > RATE.strikes) ws.close(1008, 'rate limit');
        return;
      }
      tokens -= 1;
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      try { rooms.handle(client, msg); } catch (err) { console.error('[saltline] handler failed', err); }
    });
    ws.on('close', () => rooms.disconnect(client));
    ws.on('error', () => {});
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  server.on('close', () => {
    clearInterval(heartbeat);
    rooms.close();
  });

  return { server, wss, rooms };
}

module.exports = { createServer };

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  const { server } = createServer();
  server.listen(port, () => console.log(`[saltline] multiplayer server on http://localhost:${port}`));
}
