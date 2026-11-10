// Loads the live CrazyGames HTML5 SDK on 127.0.0.1 (where it runs in its "local" environment)
// and prints the API surface it actually exposes, so the adapter and the compliance matrix can be
// checked against the script that is being served today rather than against memory.
//
//   node scripts/sdk-probe.mjs

import http from 'node:http';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || '/usr/local/bin/google-chrome';
const SDK_URL = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';
const PAGE = `<!doctype html><meta charset="utf-8"><title>sdk probe</title><script src="${SDK_URL}"></script><body>probe</body>`;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
  const result = await page.evaluate(async () => {
    const sdk = window.CrazyGames?.SDK;
    if (!sdk) return { error: 'window.CrazyGames.SDK is not defined' };
    const members = (o) => {
      const names = new Set();
      for (let p = o; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
        for (const k of Object.getOwnPropertyNames(p)) if (k !== 'constructor' && !k.startsWith('_')) names.add(k);
      }
      return [...names].sort();
    };
    const before = { keys: members(sdk) };
    let initError = null;
    try {
      await sdk.init();
    } catch (e) {
      initError = e?.message || e?.code || String(e);
    }
    const out = { before, initError, environment: sdk.environment, modules: {} };
    for (const name of ['game', 'ad', 'banner', 'user', 'data', 'analytics']) {
      try {
        const m = sdk[name];
        out.modules[name] = m ? members(m) : null;
      } catch (e) {
        out.modules[name] = `threw: ${e?.message || e?.code || e}`;
      }
    }
    try {
      out.settings = sdk.game.settings;
      out.isInstantMultiplayer = sdk.game.isInstantMultiplayer;
      out.inviteParams = sdk.game.inviteParams;
      out.isUserAccountAvailable = sdk.user.isUserAccountAvailable;
      out.systemInfo = sdk.user.systemInfo;
    } catch (e) {
      out.readError = e?.message || String(e);
    }
    // Exercise the calls the adapter makes, in order, and report anything that throws.
    out.calls = {};
    for (const [label, fn] of [
      ['game.loadingStart', () => sdk.game.loadingStart()],
      ['game.loadingStop', () => sdk.game.loadingStop()],
      ['game.gameplayStart', () => sdk.game.gameplayStart()],
      ['game.gameplayStop', () => sdk.game.gameplayStop()],
      ['data.setItem', () => sdk.data.setItem('afterlight.probe', 'x')],
      ['data.getItem', () => sdk.data.getItem('afterlight.probe')],
      ['data.removeItem', () => sdk.data.removeItem('afterlight.probe')],
    ]) {
      try {
        const v = fn();
        out.calls[label] = v === undefined ? 'ok' : `ok -> ${JSON.stringify(v)}`;
      } catch (e) {
        out.calls[label] = `threw: ${e?.code || ''} ${e?.message || e}`;
      }
    }
    out.gameDescriptors = Object.fromEntries(
      ['gameplayStart', 'loadingStart'].map((k) => {
        let d;
        for (let p = sdk.game; p && !d; p = Object.getPrototypeOf(p)) d = Object.getOwnPropertyDescriptor(p, k);
        return [k, d ? { writable: d.writable, configurable: d.configurable, own: Object.prototype.hasOwnProperty.call(sdk.game, k) } : null];
      }),
    );
    return out;
  });
  console.log(JSON.stringify(result, null, 2));
  console.log('\n--- SDK console output ---');
  for (const l of logs) console.log(l.slice(0, 300));
} finally {
  await browser.close();
  server.close();
}
