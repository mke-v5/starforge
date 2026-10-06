// Test runner: `node tests/run.mjs [name-filter …] [--fast] [--shots] [--verbose]`
// Each file in tests/scenarios exports `meta` ({ name, slow?, viewport?, context?, allowErrors? }) and a default
// async function (t) that drives the game through t.page / t.eval and records checks with t.check(cond, msg).
// A scenario fails on any failed check, an exception, or a console error.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serve } from './server.mjs';
import { launch, Run } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootArg = process.argv.find((a) => a.startsWith('--root='));
const root = rootArg ? path.resolve(rootArg.slice(7)) : path.resolve(here, '..');      // --root=<dir>: test another checkout
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const filters = args.filter((a) => !a.startsWith('--'));
const opts = { shots: flags.has('--shots'), verbose: flags.has('--verbose'), shotDir: path.join(here, 'shots') };

const files = fs.readdirSync(path.join(here, 'scenarios')).filter((f) => f.endsWith('.mjs')).sort();
const scenarios = [];
for (const f of files) {
  const mod = await import(pathToFileURL(path.join(here, 'scenarios', f)).href);
  const meta = { name: f.replace(/\.mjs$/, ''), ...(mod.meta || {}) };
  if (filters.length && !filters.some((x) => meta.name.includes(x) || f.includes(x))) continue;
  if (flags.has('--fast') && meta.slow) continue;
  scenarios.push({ meta, fn: mod.default });
}

const { server, port } = await serve(root);
const base = `http://127.0.0.1:${port}`;
const browser = await launch();
const results = [];
for (const { meta, fn } of scenarios) {
  const t = new Run(browser, base, opts);
  const t0 = Date.now();
  let err = null;
  process.stdout.write(`▶ ${meta.name} … `);
  try {
    await t.open(meta.viewport, meta.context);
    await Promise.race([fn(t), new Promise((_, rej) => setTimeout(() => rej(new Error('scenario timeout')), (meta.timeout || 600) * 1000))]);
  } catch (e) { err = e; }
  if (err) { try { await t.shot(meta.name + '-error'); } catch (e2) { /* ignore */ } }
  await t.close();
  const consoleErr = meta.allowErrors ? [] : t.errors;
  const ok = !err && !t.fails.length && !consoleErr.length;
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(ok ? `pass (${secs}s)` : `FAIL (${secs}s)`);
  if (!ok || opts.verbose) {
    if (err) console.log('   error:', err.stack || err.message);
    for (const f of t.fails) console.log('   ✗', f);
    for (const e of consoleErr.slice(0, 10)) console.log('   console:', e);
    if (!ok) for (const n of t.notes.slice(-12)) console.log('   ·', n);
  }
  results.push({ name: meta.name, ok, secs });
}
await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? ' — failed: ' + failed.map((r) => r.name).join(', ') : ''}`);
process.exit(failed.length ? 1 : 0);
