// Run with: node --test
// Starts "claude-image-gen mcp" and talks to it the way an MCP client does. No browser, no Google.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cig-mcp-'));
const { VERSION } = require('../claude-image-gen.js');

function server() {
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'claude-image-gen.js'), 'mcp'],
    { env: { ...process.env, CIG_HOME: HOME, CIG_OUTPUT_DIR: HOME } });
  const waiting = new Map(), lines = [];
  let buf = '', id = 0;
  p.stdout.on('data', d => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      lines.push(line);
      const m = JSON.parse(line); // everything on stdout must be protocol
      if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    }
  });
  p.stderr.on('data', () => {});
  const raw = s => p.stdin.write(s + '\n');
  const request = (method, params) => new Promise(resolve => {
    waiting.set(++id, resolve);
    raw(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
  const call = (name, args) => request('tools/call', { name, arguments: args }).then(m => m.result);
  return { p, raw, request, call, lines, waiting, close: () => new Promise(r => { p.on('exit', r); p.stdin.end(); }) };
}

test('an MCP client can connect, list the tools and call them', { timeout: 30000 }, async () => {
  const s = server();
  try {
    const init = await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.strictEqual(init.result.protocolVersion, '2025-06-18', 'speaks the version the client asked for');
    assert.deepStrictEqual(init.result.serverInfo, { name: 'claude-image-gen', title: 'Claude Image Gen', version: VERSION });
    assert.ok(init.result.capabilities.tools);
    s.raw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })); // gets no reply

    const unknownVersion = await s.request('initialize', { protocolVersion: '1999-01-01' });
    assert.match(unknownVersion.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/, 'falls back to a version it knows');

    const { tools } = (await s.request('tools/list')).result;
    assert.deepStrictEqual(tools.map(t => t.name), ['generate_image', 'generate_video', 'list_accounts', 'check_accounts', 'login']);
    const image = tools.find(t => t.name === 'generate_image');
    assert.deepStrictEqual(image.inputSchema.required, ['prompt']);
    assert.deepStrictEqual(image.inputSchema.properties.model.enum, ['nano-banana-2', 'nano-banana-pro', 'nano-banana-2-lite']);
    assert.deepStrictEqual(tools.find(t => t.name === 'generate_video').inputSchema.properties.aspect_ratio.enum, ['16:9', '9:16']);

    assert.match((await s.call('list_accounts', {})).content[0].text, /No accounts yet/);

    const noPrompt = await s.call('generate_image', {});
    assert.strictEqual(noPrompt.isError, true);
    assert.match(noPrompt.content[0].text, /"prompt" is required/);

    const badCount = await s.call('generate_image', { prompt: 'a cat', count: 9 });
    assert.strictEqual(badCount.isError, true);
    assert.match(badCount.content[0].text, /count must be/);

    // With nobody signed in, the result says so and tells the model what to do next.
    const signedOut = await s.call('generate_image', { prompt: 'a cat' });
    assert.strictEqual(signedOut.isError, true);
    assert.match(signedOut.content[0].text, /^not_signed_in: NOT SIGNED IN/);
    assert.match(signedOut.content[0].text, /Call the "login" tool/);

    assert.strictEqual((await s.request('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
    assert.strictEqual((await s.request('resources/list')).error.code, -32601);
    assert.deepStrictEqual((await s.request('ping')).result, {});

    s.raw('this is not json');
    await new Promise(r => setTimeout(r, 200));
    assert.strictEqual(JSON.parse(s.lines.at(-1)).error.code, -32700);
  } finally { await s.close(); }
});

test('calls made at the same time are answered one after another, each with its own id', { timeout: 30000 }, async () => {
  const s = server();
  try {
    const results = await Promise.all([1, 2, 3].map(() => s.call('generate_video', { prompt: 'waves' })));
    for (const r of results) assert.match(r.content[0].text, /^not_signed_in/);
  } finally { await s.close(); }
});

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
