'use strict';
// Turns the original single-file game into the multiplayer build. The game
// bundle is minified, so every patch targets an exact anchor and must match
// once; a mismatch means the game file changed and the patch needs review.
const fs = require('fs');
const path = require('path');

const SOURCE = path.join(__dirname, 'game', 'Saltline_Levels.html');

const PATCHES = [
  {
    name: 'expose game internals to the multiplayer client',
    find: 'const SL={L:null,save:SLV.load(),from:"title",sel:1,sec:0,noSave:!1,el:null,qs:null,cache:{}};',
    add: 'i.mp_hooks={SL,SLV,run:c,game:_,cut:me,extract:ee,hud:o,menus:l};',
  },
  {
    name: 'title menu button',
    find: '<button class="btn primary" data-act="deploy" data-f="deploy-btn">Deploy</button>',
    add: '\n          <button class="btn" data-act="mp">Multiplayer</button>',
  },
  {
    name: 'pause menu button',
    find: '<button class="btn primary" data-act="resume">Resume</button>',
    add: '\n        <button class="btn" data-act="mp">Multiplayer</button>',
  },
];

const CLIENT_FILES = ['avatar.js', 'mp.js', 'mp.css'];
const ASSETS = '\n<link rel="stylesheet" href="mp.css">\n<script src="avatar.js"></script>\n<script src="mp.js"></script>\n';

function patchGame(html) {
  for (const p of PATCHES) {
    const count = html.split(p.find).length - 1;
    if (count !== 1) throw new Error(`patch "${p.name}": expected 1 anchor match, found ${count}`);
    html = html.replace(p.find, () => p.find + p.add);
  }
  return html + ASSETS;
}

function buildGame(source = SOURCE) {
  return patchGame(fs.readFileSync(source, 'utf8'));
}

module.exports = { patchGame, buildGame, PATCHES, CLIENT_FILES };

// `node patch.js [outDir]` writes a static build (index.html + client assets),
// for hosting the page separately and pointing it at a server with ?server=wss://…
if (require.main === module) {
  const out = path.resolve(process.argv[2] || path.join(__dirname, 'dist'));
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'index.html'), buildGame());
  for (const f of CLIENT_FILES) fs.copyFileSync(path.join(__dirname, 'client', f), path.join(out, f));
  console.log(`[saltline] static build written to ${out}`);
}
