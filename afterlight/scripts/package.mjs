// Packages dist/ for upload to CrazyGames and checks it against the limits in the official
// requirements (https://docs.crazygames.com/requirements/technical/, checked 2026-11-10).
// Run after `npm run build`:  node scripts/package.mjs

import { zipSync } from 'fflate';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

const MB = 1024 * 1024;
const LIMITS = { totalBytes: 250 * MB, initialBytes: 50 * MB, mobileHomepageBytes: 20 * MB, files: 1500 };
/** The only external host the client may reference: the CrazyGames SDK script. */
const ALLOWED_HOSTS = new Set(['sdk.crazygames.com']);

async function walk(dir, base = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(path.join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

try {
  await stat(path.join(dist, 'index.html'));
} catch {
  console.error('dist/index.html not found. Run `npm run build` first.');
  process.exit(1);
}

const files = (await walk(dist)).sort();
const problems = [];
const hosts = new Set();
const zipInput = {};
let total = 0;
let gzipped = 0;

for (const rel of files) {
  const body = await readFile(path.join(dist, rel));
  total += body.length;
  gzipped += gzipSync(body).length;
  zipInput[rel] = body;
  if (rel.endsWith('.map')) problems.push(`${rel}: source maps must not ship`);
  if (!/\.(html|js|css|json)$/.test(rel)) continue;
  const text = body.toString('utf8');
  // Absolute paths break when the platform serves the bundle from a sub-folder.
  for (const m of text.matchAll(/(?:src|href)=["'](\/[^/"'][^"']*)["']|url\((["']?)(\/[^/)"'][^)"']*)\2\)/g)) {
    problems.push(`${rel}: absolute path "${m[1] ?? m[3]}"`);
  }
  for (const m of text.matchAll(/\b(https?|wss?):\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
    const host = m[2].toLowerCase();
    // Namespaces and documentation links inside library code are not network requests.
    if (/^(www\.w3\.org|github\.com|threejs\.org|developer\.mozilla\.org|docs\.crazygames\.com|[a-z.]*example\.(com|org))$/.test(host)) continue;
    hosts.add(host);
    if (m[1].toLowerCase() === 'http' || m[1].toLowerCase() === 'ws') problems.push(`${rel}: insecure URL ${m[0]}`);
    if (!ALLOWED_HOSTS.has(host)) problems.push(`${rel}: unexpected external host ${host}`);
  }
  for (const m of text.matchAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|secret|password)\s*[:=]\s*["'][^"']{12,}["']/gi)) {
    problems.push(`${rel}: looks like a credential: ${m[0].slice(0, 40)}`);
  }
}

if (total > LIMITS.totalBytes) problems.push(`total size ${(total / MB).toFixed(1)} MB exceeds 250 MB`);
// Everything in this build is fetched before the first gameplay start, so total equals initial download.
if (total > LIMITS.initialBytes) problems.push(`initial download ${(total / MB).toFixed(1)} MB exceeds 50 MB`);
if (files.length > LIMITS.files) problems.push(`${files.length} files exceeds 1500`);

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`AFTERLIGHT: BLACKOUT ${pkg.version} — CrazyGames package check`);
console.log(`  files                 ${files.length}  (limit 1500)`);
console.log(`  total size            ${kb(total)}  (limit 250 MB)`);
console.log(`  initial download      ${kb(total)}  (limit 50 MB; 20 MB for mobile homepage eligibility)`);
console.log(`  gzip transfer size    ${kb(gzipped)}`);
console.log(`  external hosts        ${[...hosts].join(', ') || 'none'}`);
for (const rel of files) console.log(`    ${rel}  ${kb(zipInput[rel].length)}`);

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const outDir = path.join(root, 'release');
await mkdir(outDir, { recursive: true });
const zipPath = path.join(outDir, `afterlight-blackout-${pkg.version}-crazygames.zip`);
await writeFile(zipPath, zipSync(zipInput, { level: 9 }));
console.log(`\nNo problems found. Wrote ${path.relative(root, zipPath)} (${kb((await stat(zipPath)).size)}), index.html at the archive root.`);
