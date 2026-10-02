// Run with: node --test
// The parts that need no browser: arguments, models, file names, batches, file types, account switching.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cig-cli-'));
process.env.CIG_HOME = HOME;
const cig = require('../claude-image-gen.js');
const { parseArgs, genOptions, resolveModel, sniff, slug, outPath, batchTodo, eachAccount, findAccount, EXIT, CliError } = cig;

test('parseArgs reads flags and values, and rejects unknown flags', () => {
  const a = parseArgs(['image', 'a cat', '-o', 'out/cat', '-m', 'Nano-Banana-Pro', '-a', '1:1', '-n', '3', '--show', '--account', '2']);
  assert.deepStrictEqual(a._, ['image', 'a cat']);
  assert.strictEqual(a.out, 'out/cat');
  assert.strictEqual(a.model, 'nano-banana-pro');
  assert.strictEqual(a.count, 3);
  assert.strictEqual(a.show, true);
  assert.strictEqual(a.account, '2');
  assert.throws(() => parseArgs(['image', 'x', '--nope']), /Unknown option "--nope"/);
  assert.throws(() => parseArgs(['image', 'x', '-o']), /-o needs a value/);
});

test('genOptions fills defaults, normalizes 4 -> 4s and 360 -> 360p, and validates', () => {
  assert.deepStrictEqual(genOptions({ count: 1 }, 'image'),
    { kind: 'image', model: 'nano-banana-2', aspect: '16:9', count: 1, duration: undefined, resolution: undefined });
  const v = genOptions({ count: 2, duration: '4', resolution: '360' }, 'video');
  assert.strictEqual(v.model, 'omni-flash');
  assert.strictEqual(v.duration, '4s');
  assert.strictEqual(v.resolution, '360p');
  for (const count of [0, 5, 1.5, NaN, 'x']) assert.throws(() => genOptions({ count }, 'image'), /--count must be/);
  assert.throws(() => genOptions({ count: 1, duration: '4s' }, 'image'), /video options/);
});

test('resolveModel matches Flow labels by pattern, including future versions', () => {
  assert.ok(resolveModel('image', 'nano-banana-pro').test('Nano Banana Pro'));
  assert.ok(resolveModel('image', 'pro').test('Nano Banana Pro'), 'short alias');
  assert.ok(resolveModel('video', 'veo-fast').test('Veo 3.1 - Fast'));
  assert.ok(resolveModel('video', 'veo-fast').test('Veo 3.2 - Fast'), 'a version bump keeps working');
  assert.ok(!resolveModel('video', 'veo-fast').test('Veo 3.1 - Quality'));
  assert.ok(resolveModel('video', 'veo 3.1 - lite').test('Veo 3.1 - Lite'), 'an exact Flow label');
  assert.ok(!resolveModel('video', 'veo 3.1 - lite').test('Veo 3x1 - Lite'), 'labels are matched literally');
  assert.throws(() => resolveModel('image', 'veo-fast'), /is a video model/);
});

test('sniff tells file types apart by their first bytes', () => {
  const b = (...x) => Buffer.concat(x.map(v => typeof v === 'string' ? Buffer.from(v, 'latin1') : Buffer.from(v)));
  assert.strictEqual(sniff(b([0x89, 0x50, 0x4e, 0x47], '\r\n\x1a\n')), '.png');
  assert.strictEqual(sniff(b([0xff, 0xd8, 0xff, 0xe0], 'xxxxxxxx')), '.jpg');
  assert.strictEqual(sniff(b('RIFF', [0, 0, 0, 0], 'WEBP')), '.webp');
  assert.strictEqual(sniff(b([0, 0, 0, 0x20], 'ftypisom')), '.mp4');
  assert.strictEqual(sniff(b([0x1a, 0x45, 0xdf, 0xa3], 'xxxxxxxx')), '.webm');
  assert.strictEqual(sniff(b('<!doctype html><html>')), null, 'an error page is not an image');
  assert.strictEqual(sniff(Buffer.alloc(0)), null, 'an empty download is not an image');
});

test('slug makes safe, short file names', () => {
  assert.strictEqual(slug('A Red Barn, under a BLUE sky!'), 'a-red-barn-under-a-blue-sky');
  assert.strictEqual(slug('日本語'), 'flow');
  assert.ok(slug('x'.repeat(200)).length <= 50);
});

test('outPath: a file, a folder, or a name made from the prompt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cig-out-'));
  assert.strictEqual(outPath('art/cover', 'p', dir), path.join(dir, 'art/cover'));
  assert.match(outPath('art/', 'a red barn', dir), new RegExp(`^${path.join(dir, 'art').replace(/\\/g, '\\\\')}[\\\\/]a-red-barn-\\d+$`));
  assert.match(outPath(dir, 'a red barn'), /[\\/]a-red-barn-\d+$/, 'an existing folder');
  assert.match(outPath(undefined, 'a red barn', dir), /[\\/]a-red-barn-\d+$/);
  assert.strictEqual(outPath('/abs/x', 'p', dir), path.resolve('/abs/x'));
  fs.rmSync(dir, { recursive: true });
});

test('batchTodo skips prompts already saved, without mixing up similar names or kinds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cig-batch-'));
  const prompts = ['a cat', 'a dog', 'a bird', 'a fish'];
  for (const f of ['001-a-cat.png', '002-a-dog-2.jpg', '003-a-bird.mp4', '004-a-fish-and-chips.png', 'notes.txt']) fs.writeFileSync(path.join(dir, f), '');
  const left = batchTodo(prompts, dir, 'image').map(t => t.p);
  assert.deepStrictEqual(left, ['a bird', 'a fish'], 'a video does not count for an image batch; "a fish and chips" is not "a fish"');
  assert.deepStrictEqual(batchTodo(prompts, dir, 'video').map(t => t.p), ['a cat', 'a dog', 'a fish']);
  assert.strictEqual(batchTodo(prompts, path.join(dir, 'missing'), 'image').length, 4);
  fs.rmSync(dir, { recursive: true });
});

// Accounts on disk, for the switching tests.
const ACCOUNTS = path.join(HOME, 'accounts');
for (const n of ['a@x.com', 'b@x.com', 'c@x.com']) fs.mkdirSync(path.join(ACCOUNTS, n, 'profile'), { recursive: true });

test('findAccount takes a number or an email', () => {
  assert.strictEqual(findAccount('2'), 'b@x.com');
  assert.strictEqual(findAccount('C@X.com'), 'c@x.com');
  assert.throws(() => findAccount('9'), /No account "9"/);
});

test('eachAccount moves to the next account only for account problems', async () => {
  const tried = [];
  const r = await eachAccount({}, async email => {
    tried.push(email);
    if (email === 'a@x.com') throw new CliError('OUT OF CREDITS: none left', EXIT.credits);
    if (email === 'b@x.com') throw new CliError('NOT SIGNED IN: gone', EXIT.signedOut);
    return 'made it';
  });
  assert.strictEqual(r, 'made it');
  assert.deepStrictEqual(tried, ['a@x.com', 'b@x.com', 'c@x.com']);

  // A refused prompt is about the prompt, so it stops at once.
  tried.length = 0;
  await assert.rejects(eachAccount({}, async e => { tried.push(e); throw new CliError('refused', EXIT.refused); }), e => e.code === EXIT.refused);
  assert.deepStrictEqual(tried, ['a@x.com']);

  // Every account failing reports the most useful code: rate limit, then credits, then signed out.
  await assert.rejects(eachAccount({}, async e => {
    throw new CliError('x', e === 'b@x.com' ? EXIT.rateLimited : EXIT.signedOut);
  }), e => e.code === EXIT.rateLimited && /Every account failed/.test(e.message));

  // --account pins one account.
  tried.length = 0;
  await assert.rejects(eachAccount({ account: '3' }, async e => { tried.push(e); throw new CliError('x', EXIT.credits); }), e => e.code === EXIT.credits);
  assert.deepStrictEqual(tried, ['c@x.com']);
});

test('the version is the same everywhere it is written', () => {
  const root = path.join(__dirname, '..');
  const json = f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
  assert.strictEqual(json('package.json').version, cig.VERSION);
  assert.strictEqual(json('.claude-plugin/plugin.json').version, cig.VERSION);
});

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
