// Run with: node --test
// Drives a real headless Chrome/Edge/Chromium through the same code that drives Flow, against a fake Flow
// page (fixtures/flow.html) served from this machine. No Google account and no network needed.
// Skipped when no Chromium-based browser is installed; BROWSER_PATH picks one.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cig-browser-'));
process.env.CIG_HOME = HOME;
process.env.CIG_TIMEOUT = '30';
const { launch, closeBrowser, Page, select, browserPath, generate, JS, EXIT } = require('../claude-image-gen.js');

select(path.join(HOME, 'accounts', 'test@example.com'));
let exe = null;
try { exe = browserPath(); } catch {}
const skip = !exe && 'no Chromium-based browser installed';

// A 1x1 PNG, and something shaped like an MP4 (an ftyp box), for the fake Flow to hand out.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(4096)]);
const PAGES = {
  '/': '<button>New project</button><a href="/project/1">My project</a>',
  '/welcome': '<h1>Create with Google Flow</h1><button>Sign in</button>',
  '/unavailable': '<p>Flow isn\'t available in your country yet.</p>',
  '/project/broken': '<p>Something went wrong</p>',
  '/project/loading': '<div class="spinner"></div>',
};

let server, base, b, page;
test.before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/media/')) {
      const video = url.pathname.endsWith('.mp4');
      res.writeHead(200, { 'content-type': video ? 'video/mp4' : 'image/png' });
      return res.end(video ? MP4 : PNG);
    }
    if (url.pathname === '/project/fake') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(fs.readFileSync(path.join(__dirname, 'fixtures', 'flow.html')));
    }
    res.writeHead(PAGES[url.pathname] ? 200 : 404, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>t</title>${PAGES[url.pathname] || 'not found'}`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  b = await launch(true);
  page = await Page.open(b, true);
});
test.after(async () => {
  page?.close();
  await closeBrowser(b);
  server?.close();
  fs.rmSync(HOME, { recursive: true, force: true });
});

const fake = async (query = '') => { await page.goto(`${base}/project/fake${query}`); return page; };
const fakeState = () => page.eval('JSON.stringify(S)').then(JSON.parse);

test('the headless browser passes for a normal one', { skip }, async () => {
  const ua = await page.eval('navigator.userAgent');
  assert.ok(!/Headless/.test(ua), ua);
});

test('page state: home, signed out, unavailable, broken, loading, project', { skip }, async () => {
  for (const [p, want] of [['/', 'home'], ['/welcome', 'signedout'], ['/unavailable', 'unavailable'],
    ['/project/broken', 'broken'], ['/project/loading', 'loading'], ['/project/fake', 'project']]) {
    await page.goto(base + p);
    assert.strictEqual(await page.eval(JS.state), want, p);
  }
  assert.match(await page.eval(JS.account), /test@example\.com/);
});

test('an image: settings, prompt, new tiles, saved with the real file type', { skip, timeout: 60000 }, async () => {
  await fake();
  const out = path.join(HOME, 'out', 'barn.jpg'); // asks for .jpg, Flow hands back PNG
  const r = await generate(page, '  a red   barn under a blue sky ', out, { kind: 'image', model: 'nano-banana-pro', aspect: '1:1', count: 2 });
  assert.strictEqual(r.model, 'Nano Banana Pro');
  assert.strictEqual(r.credits, null, 'images are free');
  assert.deepStrictEqual(r.files, [path.join(HOME, 'out', 'barn-1.png'), path.join(HOME, 'out', 'barn-2.png')]);
  for (const f of r.files) assert.deepStrictEqual(fs.readFileSync(f), PNG);
  const s = await fakeState();
  assert.deepStrictEqual([s.mode, s.model.Image, s.aspect, s.count], ['Image', 'Nano Banana Pro', '1:1', 'x2']);
  assert.deepStrictEqual(s.prompts, ['a red barn under a blue sky']);
  assert.strictEqual(s.popup, false, 'the settings popup is closed again');

  // A second run in the same project only picks up the new tiles.
  const again = await generate(page, 'a blue barn', path.join(HOME, 'out', 'blue'), { kind: 'image', model: 'nano-banana-2', aspect: '16:9', count: 1 });
  assert.deepStrictEqual(again.files, [path.join(HOME, 'out', 'blue.png')]);
});

test('a video: cost read from Flow, saved through Download > Original size', { skip, timeout: 60000 }, async () => {
  await fake();
  const r = await generate(page, 'waves at sunset', path.join(HOME, 'out', 'waves'), { kind: 'video', model: 'omni-flash', aspect: '9:16', count: 1, duration: '4s', resolution: '360p' });
  assert.strictEqual(r.credits, 4);
  assert.deepStrictEqual(r.files, [path.join(HOME, 'out', 'waves.mp4')]);
  assert.deepStrictEqual(fs.readFileSync(r.files[0]), MP4);
  const s = await fakeState();
  assert.deepStrictEqual([s.mode, s.aspect, s.duration, s.res, s.downloads], ['Video', '9:16', '4s', '360p', 1]);
});

test('picking another model through the model menu', { skip, timeout: 60000 }, async () => {
  await fake();
  const r = await generate(page, 'a drone shot', path.join(HOME, 'out', 'veo'), { kind: 'video', model: 'veo-fast', aspect: '16:9', count: 1 });
  assert.strictEqual(r.model, 'Veo 3.1 - Fast');
  assert.strictEqual(r.credits, 20);
  await fake();
  await assert.rejects(generate(page, 'x', path.join(HOME, 'out', 'x'), { kind: 'video', model: 'veo-ultra', aspect: '16:9', count: 1 }),
    e => /does not offer the video model "veo-ultra".*Veo 3\.1 - Fast/.test(e.message));
  await assert.rejects(generate(page, 'x', path.join(HOME, 'out', 'x'), { kind: 'video', model: 'veo-fast', aspect: '16:9', count: 1, duration: '4s' }),
    /fixed length/);
});

test('Flow refusing the prompt is exit code 5, quoting Flow', { skip, timeout: 60000 }, async () => {
  await fake('?refuse=1');
  await assert.rejects(generate(page, 'something not allowed', path.join(HOME, 'out', 'no'), { kind: 'image', model: 'nano-banana-2', aspect: '16:9', count: 1 }),
    e => e.code === EXIT.refused && /Generation failed/.test(e.message));
});

test('a greyed-out Create button on a paid video is exit code 4', { skip, timeout: 60000 }, async () => {
  await fake('?credits=0');
  await assert.rejects(generate(page, 'waves', path.join(HOME, 'out', 'w'), { kind: 'video', model: 'omni-flash', aspect: '16:9', count: 1 }),
    e => e.code === EXIT.credits && /costs 11 credits/.test(e.message));
});

test('end to end over MCP: a tool call launches the browser, makes the image and returns it', { skip, timeout: 90000 }, async () => {
  // An account whose saved Flow project is the fake page, in a home of its own.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cig-e2e-'));
  const acct = path.join(home, 'accounts', 'e2e@example.com');
  fs.mkdirSync(path.join(acct, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(acct, 'project.txt'), `${base}/project/fake`);
  const { spawn } = require('child_process');
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'claude-image-gen.js'), 'mcp'],
    { env: { ...process.env, CIG_HOME: home, CIG_OUTPUT_DIR: home, BROWSER_PATH: exe } });
  const msgs = [];
  let buf = '';
  p.stdout.on('data', d => { buf += d; for (let i; (i = buf.indexOf('\n')) >= 0;) { msgs.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  p.stderr.on('data', () => {});
  const send = m => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  try {
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ id: 2, method: 'tools/call', params: { name: 'generate_image', arguments: { prompt: 'a lighthouse', output: 'art/', aspect_ratio: '4:3' }, _meta: { progressToken: 'p1' } } });
    for (let i = 0; i < 600 && !msgs.some(m => m.id === 2); i++) await new Promise(r => setTimeout(r, 100));
    const r = msgs.find(m => m.id === 2).result;
    assert.ok(!r.isError, r.content[0].text);
    assert.strictEqual(r.structuredContent.model, 'Nano Banana 2');
    const [file] = r.structuredContent.files;
    assert.match(file, new RegExp(`^${path.join(home, 'art').replace(/\\/g, '\\\\')}[\\\\/]a-lighthouse-\\d+\\.png$`));
    assert.deepStrictEqual(fs.readFileSync(file), PNG);
    assert.deepStrictEqual(r.content[1], { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' });
    const progress = msgs.filter(m => m.method === 'notifications/progress' && m.params.progressToken === 'p1');
    assert.ok(progress.some(m => /Nano Banana 2/.test(m.params.message)), 'progress tells the client what is being made');
    assert.ok(!fs.existsSync(path.join(home, 'lock')), 'the lock is released');
  } finally {
    p.stdin.end();
    await new Promise(r => p.on('exit', r));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
