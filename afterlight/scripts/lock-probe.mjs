// Checks whether this Chrome grants real pointer lock to the built game, and if it does, that the
// lock-driven flow works: Start locks the mouse and begins play, losing the lock pauses, Resume
// locks again. Headless Chrome may refuse; the result is printed either way.
//
//   node scripts/lock-probe.mjs      (after `npm run build`)

import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const CHROME = process.env.CHROME_PATH || '/usr/local/bin/google-chrome';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  const rel = new URL(req.url, 'http://x').pathname.slice(1) || 'index.html';
  try {
    res.writeHead(200, { 'content-type': MIME[path.extname(rel)] || 'application/octet-stream' });
    res.end(await readFile(path.join(dist, rel)));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1280,720'],
});
const out = {};
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.setRequestInterception(true);
  page.on('request', (r) => (new URL(r.url()).hostname === 'sdk.crazygames.com' ? r.abort() : r.continue()));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html?debug`);
  const state = () => page.evaluate(() => window.__afterlight?.state());
  const until = async (want, ms) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) if ((await state()) === want) return true;
    return false;
  };
  await until('menu', 60000);
  await page.click('.screen.menu button.primary');
  out.startLocksAndPlays = await until('playing', 6000);
  out.lockElement = await page.evaluate(() => document.pointerLockElement?.id ?? null);
  if (out.startLocksAndPlays) {
    const yaw0 = await page.evaluate(() => window.__afterlight.sim().player.yaw);
    await page.mouse.move(600, 360);
    await page.mouse.move(700, 360, { steps: 5 });
    await sleep(800);
    out.mouseLookUnderLock = (await page.evaluate(() => window.__afterlight.sim().player.yaw)) < yaw0 - 0.05;
    await page.evaluate(() => document.exitPointerLock());
    out.losingLockPauses = await until('paused', 4000);
    await sleep(1300);
    await page.click('.screen.pause button.primary');
    out.resumeLocksAgain = await until('playing', 6000);
    await page.keyboard.press('KeyP');
    out.pauseKeyReleasesLock = (await until('paused', 4000)) && (await page.evaluate(() => document.pointerLockElement === null));
  } else {
    out.stateAfterClick = await state();
    out.notice = await page.evaluate(() => document.querySelector('.screen.menu .notice')?.textContent ?? '');
  }
} finally {
  await browser.close();
  server.close();
}
console.log(JSON.stringify(out, null, 2));
if (!out.startLocksAndPlays) {
  console.log('note: this browser did not grant pointer lock, so the lock-driven flow was not exercised.');
} else if (Object.values(out).some((v) => v === false)) {
  console.error('LOCK PROBE FAILED');
  process.exit(1);
} else {
  console.log('Pointer-lock flow passed.');
}
