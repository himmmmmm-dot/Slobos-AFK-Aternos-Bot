// Drives the production build in headless Chrome with real key and mouse events, checks the
// critical flows, and captures screenshots of the actual game. Run after `npm run build`.
//
//   node scripts/smoke.mjs            all checks, screenshots to docs/media/
//   CHROME_PATH=/path/to/chrome ...   use a different browser binary
//
// The page is opened with ?debug (exposes window.__afterlight for reading state) and ?nolock
// (mouse look without pointer lock), so these checks do not depend on pointer-lock timing; the
// real pointer-lock flow is covered by scripts/lock-probe.mjs. Both are automation switches and
// neither changes game rules. Rendering here is a software rasteriser, so the frame times this
// prints say nothing about real GPUs.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const media = path.join(root, 'docs', 'media');
const CHROME = process.env.CHROME_PATH || '/usr/local/bin/google-chrome';
const SDK_HOST = 'sdk.crazygames.com';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

const report = { checks: [], perf: {}, platform: {}, notes: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail = '') {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) throw new Error(`check failed: ${name} ${detail}`);
}

/** The build is served from a nested path, as on a real host, so any absolute asset URL would 404. */
const PREFIX = '/embedded/afterlight';

function serve() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith(`${PREFIX}/`)) return res.writeHead(404).end('outside the game folder');
    const rel = decodeURIComponent(url.pathname.slice(PREFIX.length + 1)) || 'index.html';
    const file = path.join(dist, rel);
    if (!file.startsWith(dist)) return res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** sdk: 'real' lets the CrazyGames SDK load, 'block' aborts it, 'slow' delays it by 3 s. */
async function open(browser, base, { sdk = 'real', query = 'debug&nolock', before } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  const log = { errors: [], sdkCalls: [], console: [] };
  page.on('pageerror', (e) => log.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    const text = m.text();
    log.console.push(text);
    if (m.type() === 'error' && !/net::ERR_FAILED|Failed to load resource/.test(text)) log.errors.push(`console: ${text}`);
  });
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const host = new URL(req.url()).hostname;
    if (host === SDK_HOST && sdk === 'block') return req.abort('blockedbyclient');
    if (host === SDK_HOST && sdk === 'slow') await sleep(3000);
    req.continue();
  });
  if (before) await page.evaluateOnNewDocument(before);
  const t0 = Date.now();
  await page.goto(`${base}/index.html?${query}`, { waitUntil: 'domcontentloaded' });
  return { page, log, t0 };
}

/** In its local environment the SDK logs every lifecycle request, so its own console is the record. */
const SDK_LOG = { 'game loading start': 'loadingStart', 'game loading stop': 'loadingStop', 'gameplay start': 'gameplayStart', 'gameplay stop': 'gameplayStop' };
const sdkCalls = (log) =>
  log.console.flatMap((text) => {
    const m = /Requesting (game loading start|game loading stop|gameplay start|gameplay stop)/.exec(text);
    return m ? [SDK_LOG[m[1]]] : [];
  });

const state = (page) => page.evaluate(() => window.__afterlight?.state());

async function waitState(page, want, timeout = 60000) {
  const t0 = Date.now();
  for (;;) {
    const s = await state(page);
    if (s === want) return Date.now() - t0;
    if (s === 'error') throw new Error(`game entered the error state: ${await page.evaluate(() => document.querySelector('.screen.error .detail')?.textContent)}`);
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for state "${want}" (still "${s}")`);
    await sleep(50);
  }
}

async function waitFor(page, fn, timeout = 30000, arg) {
  const t0 = Date.now();
  for (;;) {
    const v = await page.evaluate(fn, arg);
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${fn.toString().slice(0, 90)}`);
    await sleep(50);
  }
}

async function shot(page, name) {
  await mkdir(media, { recursive: true });
  await page.screenshot({ path: path.join(media, `${name}.jpg`), type: 'jpeg', quality: 84 });
  console.log(`      screenshot docs/media/${name}.jpg`);
}

const clickButton = (page, screen, text) =>
  page.evaluate(
    ({ screen, text }) => {
      const b = [...document.querySelectorAll(`.screen.${screen} button`)].find((x) => x.textContent.includes(text));
      if (!b) throw new Error(`no "${text}" button on ${screen}`);
      b.click();
    },
    { screen, text },
  );

const sim = (page, fn) => page.evaluate(fn);
const playerZ = (page) => sim(page, () => window.__afterlight.sim().player.move.body.pos.z);

async function main() {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,720'],
  });
  report.browser = await browser.version();
  try {
    // ---------- 1. cold start with the real SDK ----------
    console.log('\n# Cold start, real CrazyGames SDK script');
    let { page, log, t0 } = await open(browser, base);
    await waitState(page, 'menu');
    report.perf.coldStartToMenuMs = Date.now() - t0;
    const platform = await page.evaluate(() => window.__afterlight.platform());
    report.platform.real = platform;
    check('reaches the main menu from a nested path (relative asset URLs)', true, `${report.perf.coldStartToMenuMs} ms`);
    console.log(`      platform: ${JSON.stringify(platform)}`);
    if (platform.status === 'ready') {
      check('SDK initialises in its local test environment', platform.environment === 'local', platform.environment);
      const calls = sdkCalls(log);
      check('the SDK logs loading start then stop, once each', calls.join() === 'loadingStart,loadingStop', calls.join() || 'no calls seen');
    } else {
      report.notes.push(`The live SDK script did not initialise here (${platform.reason}); SDK-dependent checks were skipped.`);
    }
    await shot(page, '01-menu');

    // ---------- 2. one click into gameplay ----------
    console.log('\n# Start, movement, look and firing with real input events');
    await page.click('.screen.menu button.primary');
    await waitState(page, 'playing', 15000);
    check('one click from the menu starts gameplay', true);
    if (platform.status === 'ready') {
      const calls = sdkCalls(log).slice(2);
      check('the SDK logs one gameplay start', calls.join() === 'gameplayStart', calls.join() || 'no calls seen');
    }
    await sleep(1200);
    await shot(page, '02-tunnel-start');

    // Tunnel: walk to the beam, crouch under it, then vault the barricade.
    await page.keyboard.down('KeyW');
    await waitFor(page, () => window.__afterlight.sim().player.move.body.pos.z < 21.9, 20000);
    check('W walks the player forward', true);
    const blocked = await playerZ(page);
    await sleep(700);
    check('the beam blocks a standing player', Math.abs((await playerZ(page)) - blocked) < 0.4 && (await playerZ(page)) > 21.4);
    await page.keyboard.down('KeyC');
    await waitFor(page, () => window.__afterlight.sim().player.move.body.pos.z < 20.2, 20000);
    await page.keyboard.up('KeyC');
    check('C crouches under the beam', true);
    await waitFor(page, () => window.__afterlight.sim().player.move.body.pos.z < 18.5, 20000);
    await shot(page, '03-barricade');
    for (let i = 0; i < 12 && (await playerZ(page)) > 17.2; i++) {
      await page.keyboard.press('Space');
      await sleep(500);
    }
    check('Space vaults the barricade', (await playerZ(page)) < 17.2);
    await page.keyboard.down('ShiftLeft');
    await waitFor(page, () => window.__afterlight.sim().mission.index >= 1, 30000);
    await page.keyboard.up('ShiftLeft');
    await page.keyboard.up('KeyW');
    check('reaching the concourse completes the first objective', true);

    const yaw0 = await sim(page, () => window.__afterlight.sim().player.yaw);
    await page.mouse.move(640, 360);
    await page.mouse.move(700, 360, { steps: 6 });
    await sleep(200);
    const yaw1 = await sim(page, () => window.__afterlight.sim().player.yaw);
    check('moving the mouse right turns the view right', yaw1 < yaw0 - 0.05, `${yaw0.toFixed(3)} -> ${yaw1.toFixed(3)}`);
    await page.mouse.down();
    await sleep(150);
    await page.mouse.up();
    await waitFor(page, () => window.__afterlight.sim().stats.shots >= 1, 5000);
    check('left mouse fires the pistol', (await sim(page, () => window.__afterlight.sim().stats.shots)) === 1);
    await page.keyboard.press('KeyR');
    await waitFor(page, () => window.__afterlight.sim().player.weapon.reloadLeft > 0, 5000);
    check('R starts a reload', true);
    await shot(page, '04-concourse');

    // ---------- 3. pause, settings, persistence ----------
    console.log('\n# Pause, settings and persistence');
    await page.keyboard.press('KeyP');
    await waitState(page, 'paused', 5000);
    const tick = await sim(page, () => window.__afterlight.sim().tick);
    await sleep(500);
    check('P pauses and the simulation stops', (await sim(page, () => window.__afterlight.sim().tick)) === tick);
    await shot(page, '05-pause');
    await clickButton(page, 'pause', 'Settings');
    await sleep(200);
    await shot(page, '06-settings');
    await page.select('#set-quality', 'low');
    await page.evaluate(() => {
      const fov = document.querySelector('#set-fov');
      fov.value = '104';
      fov.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#set-invertY').click();
    });
    const changed = await page.evaluate(() => window.__afterlight.settings());
    check('settings controls change the live settings', changed.quality === 'low' && changed.fov === 104 && changed.invertY === true);

    // Rebind crouch to Q through the UI with a real key press.
    await page.evaluate(() => [...document.querySelectorAll('.binds .row')].find((r) => r.textContent.includes('Crouch')).querySelector('button').click());
    await page.keyboard.press('KeyQ');
    const binds = await page.evaluate(() => window.__afterlight.settings().bindings);
    check('a key can be rebound from the settings screen', binds.crouch[0] === 'KeyQ');
    await page.evaluate(() => [...document.querySelectorAll('.binds .row')].find((r) => r.textContent.includes('Jump')).querySelector('button').click());
    await page.keyboard.press('Escape');
    check('Escape cancels a rebind and stays on the settings screen', (await page.evaluate(() => window.__afterlight.settings().bindings.jump[0])) === 'Space' && !(await page.evaluate(() => document.querySelector('.screen.settings').hidden)));
    await clickButton(page, 'settings', 'Back');
    await clickButton(page, 'pause', 'Resume');
    await waitState(page, 'playing', 5000);
    check('Resume returns to play', true);
    if (platform.status === 'ready') {
      const calls = sdkCalls(log).slice(2);
      check('the SDK logs stop on pause and start on resume', calls.join() === 'gameplayStart,gameplayStop,gameplayStart', calls.join() || 'no calls seen');
    }
    await page.evaluate(() => window.__afterlight.resetPerf());
    await sleep(4000);
    await shot(page, '07-quality-low');
    report.perf.low = await page.evaluate(() => window.__afterlight.perf());

    // The same view on the High preset, for a like-for-like comparison.
    await page.keyboard.press('KeyP');
    await waitState(page, 'paused', 5000);
    await clickButton(page, 'pause', 'Settings');
    await page.select('#set-quality', 'high');
    await clickButton(page, 'settings', 'Back');
    await clickButton(page, 'pause', 'Resume');
    await waitState(page, 'playing', 5000);
    await page.evaluate(() => window.__afterlight.resetPerf());
    await sleep(6000);
    await shot(page, '07-quality-high');
    report.perf.high = await page.evaluate(() => window.__afterlight.perf());

    // The platform data module debounces writes by about a second.
    await sleep(1600);
    const storage = await page.evaluate(() => window.__afterlight.storage());
    report.platform.storage = storage;
    check('no script errors during the first session', log.errors.length === 0, log.errors.join(' | '));
    await page.close();

    ({ page, log, t0 } = await open(browser, base));
    await waitState(page, 'menu');
    report.perf.warmStartToMenuMs = Date.now() - t0;
    const kept = await page.evaluate(() => window.__afterlight.settings());
    check('settings survive a reload', kept.quality === 'high' && kept.fov === 104 && kept.invertY && kept.bindings.crouch[0] === 'KeyQ', `store: ${storage.kind}`);
    // Put the capture run back on default settings.
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) localStorage.removeItem(k);
    });
    await page.close();

    // ---------- 4. full mission on autopilot, screenshots, results ----------
    console.log('\n# Full mission with the scripted player (labelled automation, casual profile)');
    ({ page, log } = await open(browser, base, { sdk: 'block', query: 'debug&nolock&autopilot' }));
    await waitState(page, 'menu');
    const blockedPlatform = await page.evaluate(() => window.__afterlight.platform());
    report.platform.blocked = blockedPlatform;
    check('with the SDK blocked the game still reaches the menu', blockedPlatform.status === 'unavailable', blockedPlatform.reason);
    check('the menu says platform services are unavailable', await page.evaluate(() => /SDK unavailable/.test(document.querySelector('.screen.menu .notice').textContent)));
    let outcome = '';
    let combatShots = 0;
    for (let attempt = 1; attempt <= 5 && outcome !== 'results'; attempt++) {
      await clickButton(page, attempt === 1 ? 'menu' : 'failed', attempt === 1 ? 'Start mission' : 'Retry');
      await waitState(page, 'playing', 15000);
      await page.evaluate(() => window.__afterlight.resetPerf());
      const started = Date.now();
      for (;;) {
        const s = await state(page);
        if (s === 'results' || s === 'failed') {
          outcome = s;
          break;
        }
        if (Date.now() - started > 240000) throw new Error('mission did not end within 4 minutes');
        // Capture while units are actively fighting, a few times per run.
        const fighting = await sim(page, () => {
          const g = window.__afterlight.sim();
          return g.enemies.filter((e) => e.state === 'combat').length + g.bolts.length;
        });
        if (fighting > 0 && combatShots < 6) {
          combatShots++;
          await shot(page, `08-combat-${combatShots}`);
          if (combatShots === 2) report.perf.medium = await page.evaluate(() => window.__afterlight.perf());
          await sleep(1200);
        }
        await sleep(150);
      }
      const stats = await sim(page, () => ({ ...window.__afterlight.sim().stats, tick: window.__afterlight.sim().tick }));
      console.log(`      attempt ${attempt}: ${outcome} after ${(stats.tick / 60).toFixed(1)} s of game time, ${JSON.stringify(stats)}`);
      if (outcome === 'failed') {
        if (attempt === 1) await shot(page, '09-failed');
        check('dying shows the failure screen with a retry', await page.evaluate(() => !document.querySelector('.screen.failed').hidden));
      }
    }
    check('the mission can be completed in the real build', outcome === 'results');
    await shot(page, '10-results');
    await clickButton(page, 'results', 'Replay');
    await waitState(page, 'playing', 15000);
    check('Replay starts a fresh run', (await sim(page, () => window.__afterlight.sim().mission.index)) === 0);
    await page.evaluate(() => window.__afterlight.autopilot(false));

    // Failure and recovery, forced through the simulation's own damage path.
    await sim(page, () => window.__afterlight.sim().hurtPlayer(1000, null));
    await waitState(page, 'failed', 90000);
    await clickButton(page, 'failed', 'Retry');
    await waitState(page, 'playing', 30000);
    check('Retry after death returns to a live run', await sim(page, () => window.__afterlight.sim().player.alive));
    await page.keyboard.press('KeyP');
    await waitState(page, 'paused', 5000);
    await clickButton(page, 'pause', 'Quit to menu');
    await waitState(page, 'menu', 5000);
    check('Quit returns to the menu', true);

    // Repeated start and quit must not leak GPU objects.
    const before = await page.evaluate(() => window.__afterlight.perf());
    for (let i = 0; i < 6; i++) {
      await clickButton(page, 'menu', 'Start mission');
      await waitState(page, 'playing', 15000);
      await page.keyboard.press('KeyP');
      await waitState(page, 'paused', 5000);
      await clickButton(page, 'pause', 'Quit to menu');
      await waitState(page, 'menu', 5000);
    }
    const after = await page.evaluate(() => window.__afterlight.perf());
    check('six restarts do not grow GPU geometry or texture counts', after.geometries <= before.geometries && after.textures <= before.textures, `geometries ${before.geometries}->${after.geometries}, textures ${before.textures}->${after.textures}`);

    // ---------- 5. embed sizes ----------
    console.log('\n# CrazyGames embed sizes');
    await clickButton(page, 'menu', 'Start mission');
    await waitState(page, 'playing', 15000);
    await sleep(800);
    for (const [w, h] of [[821, 462], [907, 510], [1077, 606], [1216, 684], [1366, 768], [1920, 1080]]) {
      await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
      await sleep(500);
      const fit = await page.evaluate(() => {
        const c = document.querySelector('#view canvas').getBoundingClientRect();
        const off = [...document.querySelectorAll('.hud > *')].filter((e) => !e.hidden && !['vignette', 'marker', 'damage-ring', 'crosshair', 'hitmarker'].some((k) => e.classList.contains(k))).filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight);
        });
        const size = parseFloat(getComputedStyle(document.querySelector('.objective .text')).fontSize);
        return { canvas: `${Math.round(c.width)}x${Math.round(c.height)}`, offscreen: off.map((e) => e.className), fontPx: size };
      });
      check(`${w}x${h}: canvas fills the frame and the HUD stays on screen`, fit.canvas === `${w}x${h}` && fit.offscreen.length === 0 && fit.fontPx >= 11, `objective text ${fit.fontPx.toFixed(1)} px ${fit.offscreen.join(',')}`);
      if (w === 821 || w === 1920) await shot(page, `11-embed-${w}x${h}`);
    }
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
    check('no script errors in the second session', log.errors.length === 0, log.errors.join(' | '));
    await page.close();

    // ---------- 6. slow SDK, broken storage, corrupt save ----------
    console.log('\n# Degraded environments');
    ({ page, log, t0 } = await open(browser, base, { sdk: 'slow' }));
    await waitState(page, 'menu');
    report.platform.slow = await page.evaluate(() => window.__afterlight.platform());
    check('a slow SDK only delays the menu', true, `${Date.now() - t0} ms, status ${report.platform.slow.status}`);
    await page.close();

    // ?muteAudio=true is the SDK's documented local switch for the platform mute setting.
    ({ page, log } = await open(browser, base, { query: 'debug&nolock&muteAudio=true' }));
    await waitState(page, 'menu');
    const muted = await page.evaluate(() => ({ platform: window.__afterlight.platform(), audio: window.__afterlight.audioMuted() }));
    if (muted.platform.status === 'ready') {
      check('the platform mute setting silences the game', muted.platform.muteAudio === true && muted.audio === true);
    }
    await page.close();

    ({ page, log } = await open(browser, base, {
      sdk: 'block',
      before: () => {
        Storage.prototype.setItem = () => {
          throw new DOMException('denied', 'SecurityError');
        };
      },
    }));
    await waitState(page, 'menu');
    const mem = await page.evaluate(() => window.__afterlight.storage());
    check('blocked storage falls back to memory and tells the player', mem.persistent === false && (await page.evaluate(() => /session only/.test(document.querySelector('.screen.menu .notice').textContent))));
    await page.click('.screen.menu button.primary');
    await waitState(page, 'playing', 15000);
    check('the game is still playable without storage', log.errors.length === 0, log.errors.join(' | '));
    await page.close();

    ({ page, log } = await open(browser, base, { sdk: 'block', before: () => localStorage.setItem('afterlight.settings', '{"version":1,"sens') }));
    await waitState(page, 'menu');
    check('a corrupt save is replaced with defaults and reported', (await page.evaluate(() => window.__afterlight.settings().sensitivity)) === 1 && (await page.evaluate(() => /could not be read/.test(document.querySelector('.screen.menu .notice').textContent))));
    await page.close();
  } finally {
    await browser.close();
    server.close();
    await mkdir(media, { recursive: true });
    await writeFile(path.join(media, 'smoke-report.json'), JSON.stringify(report, null, 2));
  }
  const failed = report.checks.filter((c) => !c.ok).length;
  console.log(`\n${report.checks.length - failed}/${report.checks.length} checks passed on ${report.browser}`);
  console.log(`perf (software rasteriser, not representative): ${JSON.stringify(report.perf)}`);
  for (const n of report.notes) console.log(`note: ${n}`);
}

main().catch((e) => {
  console.error(`\nSMOKE FAILED: ${e.message}`);
  process.exit(1);
});
