// Run with: node --test
// The lock that queues parallel runs. Several processes hammer it at once and must never hold it together.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cig-lock-'));
process.env.CIG_HOME = HOME;
const { lock, unlock } = require('../claude-image-gen.js');
const LOCK = path.join(HOME, 'lock');

// One worker: take the lock N times, and each time check nobody else is inside.
const WORKER = `
const fs = require('fs'), path = require('path');
const { lock, unlock } = require(${JSON.stringify(path.resolve(__dirname, '../claude-image-gen.js'))});
const inside = path.join(process.env.CIG_HOME, 'inside');
(async () => {
  for (let i = 0; i < Number(process.argv[1]); i++) {
    await lock(60);
    try { fs.writeFileSync(inside, String(process.pid), { flag: 'wx' }); }
    catch { console.log('OVERLAP'); process.exit(3); }
    await new Promise(r => setTimeout(r, Math.random() * 3));
    fs.rmSync(inside);
    unlock();
  }
})().catch(e => { console.log('CRASH ' + e.message); process.exit(1); });`;

function worker(n) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, ['-e', WORKER, String(n)], { env: { ...process.env, CIG_HOME: HOME } });
    let out = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', () => {});
    p.on('exit', code => resolve({ code, out: out.trim() }));
  });
}

test('parallel runs queue up: no crash, never two inside at once', { timeout: 120000 }, async () => {
  const results = await Promise.all(Array.from({ length: 6 }, () => worker(15)));
  for (const r of results) assert.deepStrictEqual(r, { code: 0, out: '' });
  assert.ok(!fs.existsSync(LOCK), 'the lock is released at the end');
});

test('the lock file vanishing between our two steps is not a crash', { timeout: 60000 }, async () => {
  // Another process creates and deletes the lock as fast as it can, so the file keeps disappearing between
  // our failed create and our read of who holds it (the window a parallel run's unlock hits).
  const flicker = spawn(process.execPath, ['-e', `const fs = require('fs'), f = ${JSON.stringify(LOCK)}, end = Date.now() + 3000;
    while (Date.now() < end) { try { fs.writeFileSync(f, String(process.pid), { flag: 'wx' }); fs.rmSync(f); } catch {} }`]);
  const exited = new Promise(r => flicker.on('exit', r));
  await new Promise(r => setTimeout(r, 100));
  try {
    for (let i = 0; i < 300; i++) { await lock(10); unlock(); }
  } finally { flicker.kill(); await exited; fs.rmSync(LOCK, { force: true }); }
});

test('a lock left by a dead process is taken over', async () => {
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise(r => dead.on('exit', r));
  fs.writeFileSync(LOCK, String(dead.pid));
  await lock(5);
  assert.strictEqual(fs.readFileSync(LOCK, 'utf8'), String(process.pid));
  unlock();
  assert.ok(!fs.existsSync(LOCK));
});

test('a live holder is waited for, then the lock times out with exit code 3', async () => {
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  fs.writeFileSync(LOCK, String(holder.pid));
  try {
    await assert.rejects(lock(1), e => e.code === 3 && /held the browser/.test(e.message));
  } finally { holder.kill(); fs.rmSync(LOCK, { force: true }); }
});

test('unlock leaves a lock held by someone else alone', () => {
  fs.writeFileSync(LOCK, '999999');
  unlock();
  assert.ok(fs.existsSync(LOCK));
  fs.rmSync(LOCK);
});

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
