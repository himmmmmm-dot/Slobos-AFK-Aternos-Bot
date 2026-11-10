/* Saltline multiplayer client. Loaded after the game bundle; waits for the game
   to boot, then drives co-op rooms through the patched-in window.__G.mp_hooks. */
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const NAME_KEY = 'saltline.mp.name';
  const SEND_HZ = 15;
  const FIRE_HZ = 12;
  const COLORS = [0xffb347, 0x4fc3f7, 0x9ccc65, 0xef5350, 0xba68c8, 0xffee58, 0x26a69a, 0xf48fb1];
  const LIVE_STATES = new Set(['intro', 'playing', 'paused', 'dead']);
  const STATUS = { title: 'LOBBY', intro: 'BRIEFING', playing: 'IN FIELD', paused: 'PAUSED', dead: 'DOWN', complete: 'EXTRACTED' };

  const S = {
    id: null,
    name: loadName(),
    connected: false,
    room: null,
    rooms: [],
    runId: 0,
    peers: new Map(),
    applying: false,
    wantRoom: (params.get('room') || '').toUpperCase(),
  };

  let G = null;
  let H = null;

  function loadName() {
    try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; }
  }
  function saveName(n) {
    try { localStorage.setItem(NAME_KEY, n); } catch {}
  }
  function hex(c) { return '#' + c.toString(16).padStart(6, '0'); }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function isHost() { return !!(S.room && S.room.host === S.id); }
  function levelName(n) {
    try { return H.SLV.get(n).name; } catch { return ''; }
  }
  function unlocked() {
    try { return Math.max(1, H.SL.save.unlocked | 0); } catch { return 1; }
  }

  // ---------------------------------------------------------------- network

  const net = {
    ws: null,
    retry: 0,
    timer: null,
    url() {
      const s = params.get('server');
      if (s) return s;
      if (location.protocol === 'file:') return null;
      return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    },
    connect() {
      const url = this.url();
      if (!url) { ui.status('Open the game from the Saltline server (or add ?server=wss://…)', false); return; }
      clearTimeout(this.timer);
      ui.status('Connecting…', null);
      let ws;
      try { ws = new WebSocket(url); } catch { this.schedule(); return; }
      this.ws = ws;
      ws.onopen = () => {
        this.retry = 0;
        S.connected = true;
        ui.status('Online', true);
        this.send({ t: 'hello', name: S.name || 'Breacher' });
        const rejoin = S.wantRoom || (S.room && S.room.code);
        if (rejoin) this.send({ t: 'join', code: rejoin });
        this.send({ t: 'list' });
      };
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        try { onMessage(m); } catch (err) { console.error('[mp] message handler failed', err); }
      };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        S.connected = false;
        ui.status('Offline — reconnecting', false);
        clearPeers();
        ui.render();
        this.schedule();
      };
    },
    schedule() {
      this.retry = Math.min(this.retry + 1, 6);
      this.timer = setTimeout(() => this.connect(), 500 * 2 ** this.retry);
    },
    send(m) {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
    },
  };

  function onMessage(m) {
    switch (m.t) {
      case 'welcome':
      case 'hello':
        S.id = m.id;
        break;
      case 'rooms':
        S.rooms = m.rooms || [];
        ui.render();
        break;
      case 'room': {
        const prev = S.room;
        S.room = m.room;
        S.wantRoom = '';
        if (!prev || prev.code !== m.room.code) {
          ui.chatLog.textContent = '';
          ui.chatLine({ system: true, text: `Joined room ${m.room.code}. Press T in the field to talk.` });
          try { history.replaceState(null, '', withRoomParam(m.room.code)); } catch {}
        }
        syncPeers();
        ui.render();
        break;
      }
      case 'left':
        S.room = null;
        S.runId = 0;
        clearPeers();
        try { history.replaceState(null, '', withRoomParam(null)); } catch {}
        if (m.kicked) ui.error('The host removed you from the room.');
        net.send({ t: 'list' });
        ui.render();
        break;
      case 'gone':
        dropPeer(m.id);
        break;
      case 'error':
        if (S.wantRoom) { S.wantRoom = ''; try { history.replaceState(null, '', withRoomParam(null)); } catch {} }
        ui.error(m.message);
        break;
      case 'chat':
        ui.chatLine(m);
        if (!m.system) feed(`${m.name}: ${m.text}`, m.color);
        break;
      case 'start':
        startRun(m.run);
        break;
      case 'st':
        peerState(m);
        break;
      case 'fire':
        peerFire(m);
        break;
      case 'cut':
        remoteCut(m);
        break;
      case 'extract':
        remoteExtract(m);
        break;
      case 'ev':
        if (m.kind === 'down') feed(`${m.name} is down`, null, 'sys');
        else if (m.kind === 'retry') feed(`${m.name} redeployed`, null, 'sys');
        else if (m.kind === 'kill') feed(`${m.name} dropped a ${m.what || 'hostile'}`);
        break;
    }
  }

  function withRoomParam(code) {
    const u = new URL(location.href);
    if (code) u.searchParams.set('room', code);
    else u.searchParams.delete('room');
    return u.toString();
  }

  // ---------------------------------------------------------------- run sync

  function runActive() {
    const run = S.room && S.room.run;
    return !!(run && S.runId === run.id && H.SL.L && H.SL.L.n === run.level && LIVE_STATES.has(H.game.state));
  }

  function startRun(run) {
    S.runId = run.id;
    ui.close();
    H.SL.setLevel(run.level);
    try { G.audio && G.audio.resume && G.audio.resume(); } catch {}
    try { G.input.requestLock(); } catch {}
    H.game.start({});
  }

  function applyRoomCuts() {
    if (!runActive()) return;
    for (const id of S.room.run.cut) applyCut(id);
  }

  function applyCut(id) {
    const relay = H.run.relays && H.run.relays.find((r) => r.id === id);
    if (!relay || relay.cut) return null;
    S.applying = true;
    try { H.cut(relay); } catch (e) { console.error('[mp] cut failed', e); } finally { S.applying = false; }
    return relay;
  }

  function remoteCut(m) {
    if (S.room && S.room.run && S.room.run.id === m.run && !S.room.run.cut.includes(m.relay)) S.room.run.cut.push(m.relay);
    if (m.id === S.id || !runActive()) return;
    const relay = applyCut(m.relay);
    if (relay) feed(`${m.name} cut relay ${relay.short}`, peerColor(m.id));
  }

  function remoteExtract(m) {
    if (S.room && S.room.run && S.room.run.id === m.run) S.room.run.extracted = m.name;
    if (m.id === S.id) return;
    feed(`${m.name} reached the boat — squad extracted`, peerColor(m.id));
    const st = H.game.state;
    if (runActive() && (st === 'playing' || st === 'paused' || st === 'dead')) {
      S.applying = true;
      try { H.extract(); } catch (e) { console.error('[mp] extract failed', e); } finally { S.applying = false; }
    }
  }

  function hookGame() {
    G.events.on('game:state', ({ state, prev }) => {
      if (state === 'intro' || (state === 'playing' && prev !== 'paused')) applyRoomCuts();
      if (state === 'intro' && (prev === 'dead' || prev === 'paused' || prev === 'complete') && runActive()) net.send({ t: 'ev', kind: 'retry' });
      squad.render();
      ui.render();
    });
    G.events.on('objective:done', (e) => {
      if (S.applying || !runActive()) return;
      net.send({ t: 'cut', run: S.runId, relay: e.id });
    });
    G.events.on('extraction:reached', () => {
      if (S.applying || !runActive()) return;
      net.send({ t: 'extract', run: S.runId });
    });
    G.events.on('player:dead', () => {
      if (runActive()) net.send({ t: 'ev', kind: 'down' });
    });
    G.events.on('enemy:killed', (e) => {
      if (runActive()) net.send({ t: 'ev', kind: 'kill', what: e && e.type === 'gull' ? 'gull' : 'hound' });
    });
    let lastFire = 0;
    G.events.on('weapon:fire', (e) => {
      const now = performance.now();
      if (!runActive() || !e || !e.origin || !e.dir || now - lastFire < 1000 / FIRE_HZ) return;
      lastFire = now;
      const o = e.muzzle || e.origin;
      net.send({ t: 'fire', o: [o.x, o.y, o.z].map(r2), d: [e.dir.x, e.dir.y, e.dir.z].map(r3) });
    });
  }

  function r2(v) { return Math.round(v * 100) / 100; }
  function r3(v) { return Math.round(v * 1000) / 1000; }

  let sendT = 0;
  function sendState(dt) {
    sendT -= dt;
    if (sendT > 0 || !S.room || !S.connected) return;
    sendT = 1 / SEND_HZ;
    const p = G.player;
    const f = p.forward || { x: 0, z: -1 };
    const active = runActive() || H.game.state === 'complete';
    net.send({
      t: 'st',
      run: active ? S.runId : 0,
      lv: H.SL.L ? H.SL.L.n : 0,
      gs: H.game.state,
      p: [p.pos.x, p.pos.y, p.pos.z].map(r2),
      y: r3(Math.atan2(-f.x, -f.z)),
      pi: r3(p.pitch || 0),
      hp: Math.round(p.health || 0),
      mhp: Math.round(p.maxHealth || 100),
      al: p.alive !== false,
      cr: !!p.crouching,
      v: [r2(p.vel ? p.vel.x : 0), r2(p.vel ? p.vel.z : 0)],
      ad: r2(p.ads || 0),
      sp: !!p.sprinting,
      og: p.onGround !== false,
    });
  }

  // ---------------------------------------------------------------- avatars

  let tracerKit = null;
  function tracerAssets() {
    if (tracerKit) return tracerKit;
    const T = G.THREE;
    tracerKit = {
      // Extends along +Z: Object3D.lookAt points a mesh's +Z at the target.
      geo: new T.BoxGeometry(0.018, 0.018, 1).translate(0, 0, 0.5),
      mat: new T.MeshBasicMaterial({ color: 0xffd08a, transparent: true, opacity: 0.9, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false }),
    };
    return tracerKit;
  }

  function buildModel(peer) {
    const model = window.SaltlineAvatar.create(G.THREE, { seed: peer.id, team: COLORS[peer.color % COLORS.length], name: 'mp-peer-' + peer.id });
    model.root.visible = false;
    G.scene.add(model.root);
    return model;
  }

  function makeAvatar(peer) {
    const model = buildModel(peer);

    // Name tags are DOM labels projected each frame: the game's render pipeline
    // does not draw three.js sprites, and DOM text stays crisp at any resolution.
    const tag = el('div', 'mp-tag3d');
    const tagName = el('b');
    const tagHp = el('i');
    const tagBar = el('u');
    tagBar.appendChild(tagHp);
    tag.append(tagName, tagBar);
    tags().appendChild(tag);

    return { model, root: model.root, tag, tagName, tagHp, label: '', init: false };
  }

  function rebuildModel(peer) {
    const a = peer.avatar;
    const pos = a.root.position.clone(), yaw = a.root.rotation.y, vis = a.root.visible;
    a.model.dispose();
    a.model = buildModel(peer);
    a.root = a.model.root;
    a.root.position.copy(pos);
    a.root.rotation.y = yaw;
    a.root.visible = vis;
  }

  let tagLayer = null;
  function tags() {
    if (!tagLayer) {
      tagLayer = el('div');
      tagLayer.id = 'mp-tags';
      tagLayer.setAttribute('aria-hidden', 'true');
      document.body.appendChild(tagLayer);
    }
    return tagLayer;
  }

  const tagPoint = { v: null };
  function placeTag(peer, vis) {
    const a = peer.avatar;
    if (!vis) { a.tag.style.display = 'none'; return; }
    const hp = peer.alive ? Math.max(0, Math.min(1, peer.hp / (peer.mhp || 100))) : 0;
    const key = peer.name + '|' + Math.round(hp * 50) + '|' + peer.alive + '|' + peer.color;
    if (a.label !== key) {
      a.label = key;
      a.tagName.textContent = peer.alive ? peer.name : peer.name + ' · down';
      a.tagName.style.color = peer.alive ? hex(COLORS[peer.color % COLORS.length]) : '#ff5a40';
      a.tagHp.style.width = hp * 100 + '%';
      a.tag.classList.toggle('low', hp <= 0.3);
    }
    const v = (tagPoint.v = tagPoint.v || new G.THREE.Vector3());
    a.model.tagAnchor(v).project(G.camera);
    if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) { a.tag.style.display = 'none'; return; }
    const r = (G.renderer.domElement || document.body).getBoundingClientRect();
    const dist = G.camera.position.distanceTo(a.root.position);
    a.tag.style.display = '';
    a.tag.style.opacity = dist > 60 ? 0.55 : 1;
    a.tag.style.transform = `translate(${r.left + (v.x * 0.5 + 0.5) * r.width}px, ${r.top + (0.5 - v.y * 0.5) * r.height}px) translate(-50%, -100%)`;
  }

  function disposeAvatar(a) {
    a.model.dispose();
    a.tag.remove();
  }

  function peerColor(id) {
    const p = S.room && S.room.players.find((x) => x.id === id);
    return p ? p.color : null;
  }

  function syncPeers() {
    const ids = new Set();
    for (const p of S.room.players) {
      if (p.id === S.id) continue;
      ids.add(p.id);
      let peer = S.peers.get(p.id);
      if (!peer) {
        peer = { id: p.id, name: p.name, color: p.color, hp: 100, mhp: 100, alive: true, gs: 'title', run: 0, lv: 0, pos: new G.THREE.Vector3(), yaw: 0, pitch: 0, vx: 0, vz: 0, ads: 0, sprint: false, onGround: true, crouch: false, seen: 0 };
        peer.avatar = makeAvatar(peer);
        S.peers.set(p.id, peer);
      }
      peer.name = p.name;
      if (peer.color !== p.color) {
        peer.color = p.color;
        rebuildModel(peer);
        peer.avatar.label = '';
      }
    }
    for (const id of [...S.peers.keys()]) if (!ids.has(id)) dropPeer(id);
    squad.render();
  }

  function dropPeer(id) {
    const peer = S.peers.get(id);
    if (!peer) return;
    disposeAvatar(peer.avatar);
    S.peers.delete(id);
    squad.render();
  }

  function clearPeers() {
    for (const id of [...S.peers.keys()]) dropPeer(id);
  }

  function peerState(m) {
    const peer = S.peers.get(m.id);
    if (!peer) return;
    const was = peer.gs + peer.alive + peer.hp;
    peer.pos.set(m.p[0], m.p[1], m.p[2]);
    peer.yaw = m.y;
    peer.pitch = m.pi || 0;
    peer.vx = m.v ? m.v[0] : 0;
    peer.vz = m.v ? m.v[1] : 0;
    peer.ads = m.ad || 0;
    peer.sprint = !!m.sp;
    peer.onGround = m.og !== false;
    peer.hp = m.hp;
    peer.mhp = m.mhp;
    peer.alive = m.al;
    peer.crouch = m.cr;
    peer.gs = m.gs;
    peer.run = m.run;
    peer.lv = m.lv;
    peer.seen = performance.now();
    if (was !== peer.gs + peer.alive + peer.hp) squad.render();
  }

  function peerVisible(peer) {
    // Departures arrive as explicit "gone" messages; this only hides a stalled peer.
    return runActive() && peer.run === S.runId && peer.gs !== 'title' && performance.now() - peer.seen < 10000;
  }

  const tracers = [];
  function peerFire(m) {
    const peer = S.peers.get(m.id);
    if (!peer || !peerVisible(peer)) return;
    const T = G.THREE;
    const A = tracerAssets();
    const o = new T.Vector3(m.o[0], m.o[1], m.o[2]);
    const d = new T.Vector3(m.d[0], m.d[1], m.d[2]).normalize();
    let len = 120;
    try {
      const hit = G.physics && G.physics.raycast && G.physics.raycast(o, d, 120);
      if (hit && hit.dist > 0) len = hit.dist;
    } catch {}
    // The shot is aimed from the shooter's camera; draw it from the avatar's muzzle to the same impact point.
    const end = o.clone().addScaledVector(d, len);
    const start = peer.avatar.root.visible ? peer.avatar.model.muzzleWorld(new T.Vector3()) : o;
    const mesh = new T.Mesh(A.geo, A.mat);
    mesh.position.copy(start);
    mesh.lookAt(end);
    mesh.scale.set(1, 1, Math.max(0.1, start.distanceTo(end)));
    mesh.renderOrder = 10;
    G.scene.add(mesh);
    tracers.push({ mesh, life: 0.07 });
    peer.avatar.model.fire();
  }

  function angleLerp(a, b, t) {
    let d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    return a + d * t;
  }

  let targetPos = null;
  function updateAvatars(dt) {
    const k = 1 - Math.exp(-14 * dt);
    const st = H.game.state;
    const showTags = st === 'playing' || st === 'dead';
    const now = performance.now();
    targetPos = targetPos || new G.THREE.Vector3();
    for (const peer of S.peers.values()) {
      const a = peer.avatar;
      const vis = peerVisible(peer);
      a.root.visible = vis;
      if (!vis) { a.init = false; placeTag(peer, false); continue; }
      // Dead-reckon from the last snapshot so movement stays smooth between 15 Hz updates.
      const ahead = Math.min(0.15, (now - peer.seen) / 1000);
      targetPos.set(peer.pos.x + peer.vx * ahead, peer.pos.y, peer.pos.z + peer.vz * ahead);
      if (!a.init || a.root.position.distanceTo(targetPos) > 8) { a.root.position.copy(targetPos); a.root.rotation.y = peer.yaw; a.init = true; }
      else {
        a.root.position.lerp(targetPos, k);
        a.root.rotation.y = angleLerp(a.root.rotation.y, peer.yaw, k);
      }
      a.model.update(dt, { vx: peer.vx, vz: peer.vz, pitch: peer.pitch, crouch: peer.crouch, sprint: peer.sprint, ads: peer.ads, alive: peer.alive, onGround: peer.onGround });
      placeTag(peer, showTags);
    }
    for (let i = tracers.length - 1; i >= 0; i--) {
      const t = tracers[i];
      t.life -= dt;
      if (t.life <= 0) { G.scene.remove(t.mesh); tracers.splice(i, 1); }
    }
  }

  // ---------------------------------------------------------------- squad HUD + feed

  const squad = {
    root: null,
    list: null,
    feedEl: null,
    init() {
      this.root = el('div');
      this.root.id = 'mp-squad';
      this.root.setAttribute('aria-live', 'polite');
      this.list = el('div');
      this.feedEl = el('div', 'mp-feed');
      this.root.append(this.list, this.feedEl);
      document.body.appendChild(this.root);
    },
    render() {
      if (!this.root) return;
      const st = H && H.game.state;
      const on = !!S.room && (st === 'playing' || st === 'intro' || st === 'dead');
      this.root.classList.toggle('on', on);
      if (!on) return;
      this.list.textContent = '';
      for (const peer of S.peers.values()) {
        const row = el('div', 'mp-mate');
        const dot = el('i', 'mp-dot');
        dot.style.background = hex(COLORS[peer.color % COLORS.length]);
        const down = peer.gs === 'dead' || !peer.alive;
        row.classList.toggle('down', down);
        const sameRun = peer.run && peer.run === S.runId;
        const status = !sameRun && peer.gs !== 'title' ? 'ELSEWHERE' : down ? 'DOWN' : STATUS[peer.gs] || peer.gs.toUpperCase();
        row.append(dot, el('span', '', peer.name), el('em', '', status));
        const bar = el('i', 'mp-hp');
        bar.style.width = (down ? 0 : Math.max(0, Math.min(100, (peer.hp / (peer.mhp || 100)) * 100))) + '%';
        row.appendChild(bar);
        this.list.appendChild(row);
      }
    },
  };

  function feed(text, color, cls) {
    if (!squad.feedEl) return;
    const line = el('div', cls || '', text);
    if (color != null) line.style.borderLeft = '3px solid ' + hex(COLORS[color % COLORS.length]);
    squad.feedEl.appendChild(line);
    while (squad.feedEl.children.length > 5) squad.feedEl.firstChild.remove();
    setTimeout(() => line.classList.add('old'), 6000);
    setTimeout(() => line.remove(), 6700);
  }

  // ---------------------------------------------------------------- lobby UI

  const ui = {
    root: null,
    open: false,
    init() {
      const root = el('div');
      root.id = 'mp';
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      root.setAttribute('aria-label', 'Multiplayer');
      root.innerHTML = `
<div class="mp-card">
  <div class="mp-head"><span class="mp-k">Co-op</span><h2>Multiplayer</h2><span class="mp-status" data-r="status"></span><button class="mp-x" data-a="close" aria-label="Close">×</button></div>
  <div class="mp-row"><label for="mp-name">Callsign</label><input id="mp-name" type="text" maxlength="16" placeholder="Breacher" autocomplete="off"></div>
  <div class="mp-err" data-r="err" role="alert"></div>
  <div data-r="lobby" class="mp-grid">
    <div class="mp-box"><b>Open rooms</b><div class="mp-list" data-r="rooms"></div>
      <div class="mp-row"><input class="mp-code" type="text" maxlength="5" placeholder="CODE" aria-label="Room code" data-r="code"><button class="mp-btn" data-a="join">Join by code</button></div></div>
    <div class="mp-box"><b>Host a room</b>
      <div class="mp-row"><input type="text" maxlength="24" placeholder="Room name" aria-label="Room name" data-r="rname"></div>
      <div class="mp-row"><label>Squad size <select data-r="max">${[2, 3, 4, 5, 6, 7, 8].map((n) => `<option${n === 4 ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
        <label><input type="checkbox" data-r="priv"> Private</label></div>
      <button class="mp-btn primary" data-a="create">Create room</button>
      <p class="mp-hint">Private rooms are hidden from the list. Share the code or invite link instead.</p></div>
  </div>
  <div data-r="inroom" class="mp-grid" hidden>
    <div class="mp-box"><b data-r="rtitle">Room</b>
      <div class="mp-row"><span class="mp-bigcode" data-r="rcode"></span><button class="mp-btn sm" data-a="copy">Copy invite</button></div>
      <div class="mp-list" data-r="players"></div>
      <div class="mp-row"><button class="mp-btn" data-a="ready" data-r="readybtn">Ready</button><button class="mp-btn danger" data-a="leave">Leave</button></div></div>
    <div class="mp-box"><b>Contract</b>
      <div class="mp-level"><button class="mp-btn sm" data-a="lvdown" aria-label="Previous contract">◀</button><input type="number" min="1" max="100" data-r="lv" aria-label="Contract number"><button class="mp-btn sm" data-a="lvup" aria-label="Next contract">▶</button></div>
      <div class="mp-lvname" data-r="lvname"></div><div class="mp-sub" data-r="lvnote"></div>
      <button class="mp-btn primary" data-a="deploy" data-r="deploy">Deploy squad</button>
      <button class="mp-btn" data-a="rejoin" data-r="rejoin" hidden>Join the run in progress</button></div>
    <div class="mp-box" style="grid-column:1/-1"><b>Comms</b><div class="mp-chat" data-r="chat" aria-live="polite"></div>
      <div class="mp-row"><input type="text" maxlength="200" placeholder="Message the squad" aria-label="Chat message" data-r="msg"><button class="mp-btn" data-a="send">Send</button></div></div>
  </div>
</div>`;
      document.body.appendChild(root);
      this.root = root;
      this.r = (k) => root.querySelector(`[data-r="${k}"]`);
      this.chatLog = this.r('chat');
      this.nameInput = root.querySelector('#mp-name');
      this.nameInput.value = S.name;

      // Keep keys typed here away from the game's window-level listeners.
      root.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { this.close(); return; }
        if (e.key !== 'Enter') return;
        if (e.target === this.r('msg')) this.act('send');
        else if (e.target === this.r('code')) this.act('join');
        else if (e.target === this.r('rname')) this.act('create');
        else if (e.target === this.nameInput) this.nameInput.blur();
      });
      root.addEventListener('click', (e) => {
        if (e.target === root) return this.close();
        const b = e.target.closest('[data-a]');
        if (b && !b.disabled) this.act(b.dataset.a);
      });
      this.nameInput.addEventListener('change', () => this.commitName());
      this.r('lv').addEventListener('change', () => this.setLevel(+this.r('lv').value));
      this.render();
    },
    commitName() {
      const n = this.nameInput.value.replace(/\s+/g, ' ').trim().slice(0, 16);
      this.nameInput.value = n;
      if (n === S.name) return;
      S.name = n;
      saveName(n);
      net.send({ t: 'hello', name: n || 'Breacher' });
    },
    setLevel(n) {
      if (!isHost()) return;
      n = Math.max(1, Math.min(unlocked(), Math.round(n) || 1));
      this.r('lv').value = n;
      net.send({ t: 'level', level: n });
    },
    act(a) {
      this.error('');
      const room = S.room;
      switch (a) {
        case 'close': return this.close();
        case 'create':
          this.commitName();
          return net.send({ t: 'create', name: this.r('rname').value, max: +this.r('max').value, private: this.r('priv').checked, level: H.SL.L ? Math.min(H.SL.L.n, unlocked()) : 1 });
        case 'join': {
          this.commitName();
          const code = this.r('code').value.trim().toUpperCase();
          if (code) net.send({ t: 'join', code });
          return;
        }
        case 'leave': return net.send({ t: 'leave' });
        case 'ready': {
          const me = room && room.players.find((p) => p.id === S.id);
          return net.send({ t: 'ready', ready: !(me && me.ready) });
        }
        case 'lvdown': return this.setLevel(room.level - 1);
        case 'lvup': return this.setLevel(room.level + 1);
        case 'deploy':
          // Pointer lock needs this click's user gesture; the server echo arrives too late.
          try { G.input.requestLock(); } catch {}
          return net.send({ t: 'start' });
        case 'rejoin':
          if (room && room.run) startRun(room.run);
          return;
        case 'copy': {
          const link = withRoomParam(room.code);
          (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(
            () => this.chatLine({ system: true, text: 'Invite link copied.' }),
            () => this.chatLine({ system: true, text: 'Invite link: ' + link }),
          );
          return;
        }
        case 'send': {
          const input = this.r('msg');
          const text = input.value.trim();
          if (text) net.send({ t: 'chat', text });
          input.value = '';
          return;
        }
        default:
          if (a.startsWith('kick:')) net.send({ t: 'kick', id: a.slice(5) });
          else if (a.startsWith('room:')) { this.commitName(); net.send({ t: 'join', code: a.slice(5) }); }
      }
    },
    show() {
      if (H.game.state === 'playing') H.game.pause();
      try { G.input.exitLock(); } catch {}
      this.open = true;
      this.root.classList.add('on');
      net.send({ t: 'list' });
      this.render();
      setTimeout(() => (S.room ? this.r('msg') : this.nameInput).focus(), 30);
    },
    close() {
      this.open = false;
      this.root.classList.remove('on');
      document.getElementById('view')?.focus();
    },
    status(text, ok) {
      const s = this.r && this.r('status');
      if (!s) return;
      s.textContent = text;
      s.className = 'mp-status' + (ok === true ? ' ok' : ok === false ? ' bad' : '');
    },
    error(text) {
      if (this.r) this.r('err').textContent = text || '';
    },
    chatLine(m) {
      const line = el('div', m.system ? 'sys' : '');
      if (m.system) line.textContent = m.text;
      else {
        const who = el('b', '', m.name + ': ');
        who.style.color = hex(COLORS[(m.color || 0) % COLORS.length]);
        line.append(who, document.createTextNode(m.text));
      }
      this.chatLog.appendChild(line);
      while (this.chatLog.children.length > 80) this.chatLog.firstChild.remove();
      this.chatLog.scrollTop = this.chatLog.scrollHeight;
    },
    render() {
      if (!this.root) return;
      const room = S.room;
      this.r('lobby').hidden = !!room;
      this.r('inroom').hidden = !room;
      if (!room) {
        const list = this.r('rooms');
        list.textContent = '';
        if (!S.rooms.length) list.appendChild(el('div', 'mp-empty', S.connected ? 'No open rooms yet. Host one.' : 'Waiting for the server…'));
        for (const r of S.rooms) {
          const row = el('div', 'mp-room');
          const label = el('span', '', r.name);
          const meta = el('small', '', `${r.players}/${r.max} · C${r.level}${r.inRun ? ' · in field' : ''}`);
          const b = el('button', 'mp-btn sm', 'Join');
          b.dataset.a = 'room:' + r.code;
          b.disabled = r.players >= r.max;
          row.append(label, meta, b);
          list.appendChild(row);
        }
        return;
      }
      this.r('rtitle').textContent = room.name + (room.private ? ' · private' : '');
      this.r('rcode').textContent = room.code;
      const players = this.r('players');
      players.textContent = '';
      for (const p of room.players) {
        const row = el('div', 'mp-player');
        const dot = el('i', 'mp-dot');
        dot.style.background = hex(COLORS[p.color % COLORS.length]);
        row.append(dot, el('span', '', p.name + (p.id === S.id ? ' (you)' : '')));
        if (p.id === room.host) row.appendChild(el('em', 'mp-tag host', 'Host'));
        if (p.ready) row.appendChild(el('em', 'mp-tag ready', 'Ready'));
        if (isHost() && p.id !== S.id) {
          const k = el('button', 'mp-btn sm danger', 'Kick');
          k.dataset.a = 'kick:' + p.id;
          k.setAttribute('aria-label', 'Remove ' + p.name);
          row.appendChild(k);
        }
        players.appendChild(row);
      }
      const me = room.players.find((p) => p.id === S.id);
      this.r('readybtn').textContent = me && me.ready ? 'Not ready' : 'Ready';
      const host = isHost();
      const lv = this.r('lv');
      if (document.activeElement !== lv) lv.value = room.level;
      lv.disabled = !host;
      this.root.querySelector('[data-a="lvdown"]').disabled = !host || room.level <= 1;
      this.root.querySelector('[data-a="lvup"]').disabled = !host || room.level >= unlocked();
      this.r('lvname').textContent = levelName(room.level);
      const readyCount = room.players.filter((p) => p.ready || p.id === room.host).length;
      this.r('lvnote').textContent = host ? `${readyCount}/${room.players.length} ready · host can deploy any time` : 'The host picks the contract and deploys.';
      this.r('deploy').hidden = !host;
      const live = room.run && !room.run.extracted;
      this.r('rejoin').hidden = !live || runActive();
      if (live) this.r('rejoin').textContent = `Join the run in progress · C${room.run.level}`;
    },
  };

  // In-field chat on T. The game ignores keys typed into inputs, so play continues while typing.
  const chatbar = {
    root: null,
    input: null,
    init() {
      this.root = el('div');
      this.root.id = 'mp-chatbar';
      this.input = el('input');
      this.input.type = 'text';
      this.input.maxLength = 200;
      this.input.placeholder = 'Squad chat — Enter to send, Esc to cancel';
      this.input.setAttribute('aria-label', 'Squad chat');
      this.root.appendChild(this.input);
      document.body.appendChild(this.root);
      this.input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          const text = this.input.value.trim();
          if (text) net.send({ t: 'chat', text });
          this.hide();
        } else if (e.key === 'Escape') this.hide();
      });
      this.input.addEventListener('blur', () => this.hide());
    },
    show() {
      this.input.value = '';
      this.root.classList.add('on');
      this.input.focus();
    },
    hide() {
      this.root.classList.remove('on');
    },
  };

  // ---------------------------------------------------------------- boot

  function init() {
    G = window.__G;
    H = G.mp_hooks;
    ui.init();
    squad.init();
    chatbar.init();
    hookGame();

    document.addEventListener('click', (e) => {
      if (e.target.closest && e.target.closest('[data-act="mp"]')) ui.show();
    });
    addEventListener('keydown', (e) => {
      if (e.code !== 'KeyT' || !S.room || ui.open || e.repeat) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (!LIVE_STATES.has(H.game.state)) return;
      e.preventDefault();
      chatbar.show();
    });

    let last = performance.now();
    const loop = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      try { sendState(dt); updateAvatars(dt); } catch (err) { console.error('[mp] frame failed', err); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);

    net.connect();
    if (S.wantRoom) ui.show();
    window.__mp = S;
  }

  const wait = setInterval(() => {
    if (window.__G && window.__G.mp_hooks && window.__ready) {
      clearInterval(wait);
      init();
    } else if (window.__fatal) clearInterval(wait);
  }, 200);
})();
