#!/usr/bin/env node
// claude-image-gen: generate images and videos with Google Flow from the command line.
// Drives a private, headless Chromium-family browser (Chrome, Edge, Brave, Chromium) over the
// Chrome DevTools Protocol. Node 22+, no dependencies.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const VERSION = '0.3.0';
const NAME = 'claude-image-gen';
const FLOW = 'https://flow.google.com';
const HOME = process.env.CIG_HOME || path.join(os.homedir(), '.claude-image-gen');
const ACCOUNTS_DIR = path.join(HOME, 'accounts');
const CONFIG = path.join(HOME, 'config.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));
// The home folder holds signed-in browser profiles (Google session cookies), so only its owner may read it.
function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') try { if (fs.statSync(HOME).mode & 0o077) fs.chmodSync(HOME, 0o700); } catch {}
}
// Progress goes to stderr, saved file paths to stdout. The MCP server also forwards progress to the client.
let onLog = null;
const log = (...a) => { console.error(...a); onLog?.(a.join(' ')); };

// Exit codes an agent can branch on.
const EXIT = { error: 1, signedOut: 2, busy: 3, credits: 4, refused: 5, rateLimited: 6 };
class CliError extends Error { constructor(msg, code = EXIT.error) { super(msg); this.code = code; } }

// Each Google account is its own browser profile in accounts/<email>/. One account is in use at a time.
let ACCOUNT, PROFILE, PROJECT_FILE, BROWSER_FILE;
function select(dir) {
  ACCOUNT = path.basename(dir);
  PROFILE = path.join(dir, 'profile');
  PROJECT_FILE = path.join(dir, 'project.txt');
  BROWSER_FILE = path.join(dir, 'browser.txt');
}
const signedOut = () => new CliError(
  `NOT SIGNED IN: Google signed ${ACCOUNT} out of Flow. Run "${NAME} login" and sign in as ${ACCOUNT}, then run this again.`, EXIT.signedOut);
const noAccount = () => new CliError(`NOT SIGNED IN: no Google account yet. Run "${NAME} login" and sign in.`, EXIT.signedOut);

// Models as Flow names them. Each alias matches by pattern so a version bump (Veo 3.1 -> 3.2) keeps working.
const MODELS = {
  image: [
    ['nano-banana-2', /^nano banana 2$/i],
    ['nano-banana-pro', /^nano banana pro$/i],
    ['nano-banana-2-lite', /^nano banana 2 lite$/i],
  ],
  video: [
    ['omni-flash', /^omni.*flash$/i],
    ['veo-lite', /^veo.*lite$/i],
    ['veo-fast', /^veo.*fast$/i],
    ['veo-quality', /^veo.*quality$/i],
  ],
};
const ALIASES = { nb2: 'nano-banana-2', pro: 'nano-banana-pro', lite: 'nano-banana-2-lite', omni: 'omni-flash' };

const HELP = `${NAME} ${VERSION}: generate images and videos with Google Flow from the command line

Usage:
  ${NAME} image "<prompt>" [options]     generate an image (free)
  ${NAME} video "<prompt>" [options]     generate a video (spends Flow credits)
  ${NAME} batch <prompts.txt> [options]  one prompt per line; skips files already saved
  ${NAME} mcp                            run as an MCP server (stdio) for Claude and other MCP clients

Accounts:
  ${NAME} login                          add a Google account (a sign-in window opens)
  ${NAME} accounts                       list accounts and show the active one
  ${NAME} use <number|email>             make an account the one runs start with
  ${NAME} logout [number|email]          remove an account (default: the active one)
  ${NAME} status                         check that each account is still signed in

Options:
  -o, --out <path>      output file (image/video) or folder (batch)
  -m, --model <name>    image: nano-banana-2 (default), nano-banana-pro, nano-banana-2-lite
                        video: omni-flash (default), veo-lite, veo-fast, veo-quality
  -a, --aspect <ratio>  image: 16:9 (default), 4:3, 1:1, 3:4, 9:16   video: 16:9 (default), 9:16
  -n, --count <1-4>     how many to generate from the prompt (default 1)
  -d, --duration <s>    omni-flash only: 4s, 6s, 8s (default), 10s. Veo is always 8s.
  -r, --resolution <p>  omni-flash only: 360p, 720p (default)
      --video           batch: make videos instead of images
      --show            show the browser window instead of running headless
      --account <n|email>  use only this account
      --browser <name>  chrome, edge, brave or chromium (default: the one the account signed in with)
  -h, --help  -v, --version

Exit codes: 0 ok, 1 error, 2 not signed in (run "${NAME} login"), 3 busy with another run,
            4 out of credits, 5 Flow refused the prompt, 6 rate-limited (wait and retry).
Files: ${HOME}`;

// ---------- browser ----------

const BROWSERS = {
  chrome: { win: 'Google/Chrome/Application/chrome.exe', mac: 'Google Chrome.app/Contents/MacOS/Google Chrome', linux: ['google-chrome', 'google-chrome-stable'] },
  edge: { win: 'Microsoft/Edge/Application/msedge.exe', mac: 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge', linux: ['microsoft-edge', 'microsoft-edge-stable'] },
  brave: { win: 'BraveSoftware/Brave-Browser/Application/brave.exe', mac: 'Brave Browser.app/Contents/MacOS/Brave Browser', linux: ['brave-browser', 'brave'] },
  chromium: { win: 'Chromium/Application/chrome.exe', mac: 'Chromium.app/Contents/MacOS/Chromium', linux: ['chromium', 'chromium-browser'] },
};

function locate(name) {
  const b = BROWSERS[name];
  let c = [];
  if (process.platform === 'win32')
    c = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).map(d => path.join(d, b.win));
  else if (process.platform === 'darwin')
    c = ['/Applications', path.join(os.homedir(), 'Applications')].map(d => path.join(d, b.mac));
  else
    c = (process.env.PATH || '').split(path.delimiter).flatMap(d => b.linux.map(n => path.join(d, n)));
  return c.find(p => fs.existsSync(p));
}

// A profile only works with the browser that signed in to it (each browser encrypts its
// cookies with its own key), so each account remembers which one that was.
function browserPath(want) {
  if (process.env.BROWSER_PATH) return process.env.BROWSER_PATH;
  if (want) {
    if (!BROWSERS[want]) throw new CliError(`Unknown browser "${want}". Use one of: ${Object.keys(BROWSERS).join(', ')}, or set BROWSER_PATH.`);
    const p = locate(want);
    if (!p) throw new CliError(`${want} is not installed (or not where it usually is). Set BROWSER_PATH to its executable.`);
    return p;
  }
  try { const p = fs.readFileSync(BROWSER_FILE, 'utf8').trim(); if (fs.existsSync(p)) return p; } catch {}
  for (const n of Object.keys(BROWSERS)) { const p = locate(n); if (p) return p; }
  throw new CliError('No Chromium-based browser found. Install Google Chrome, Microsoft Edge, Brave or Chromium, or set BROWSER_PATH.');
}

async function getJson(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
  return r.json();
}

// Chrome writes the debug port it picked into the profile. Reading it back means we only ever
// talk to OUR browser, never to some other Chrome that happens to have a debug port open.
async function running() {
  try {
    const port = fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
    const v = await getJson(`http://127.0.0.1:${port}/json/version`);
    return { port, ws: v.webSocketDebuggerUrl, headless: /Headless/.test(v['User-Agent'] || ''), ua: v['User-Agent'] };
  } catch { return null; }
}

async function launch(headless, browser, start = FLOW) {
  ensureHome();
  fs.mkdirSync(PROFILE, { recursive: true });
  fs.rmSync(path.join(PROFILE, 'DevToolsActivePort'), { force: true });
  const exe = browserPath(browser);
  const args = ['--remote-debugging-port=0', `--user-data-dir=${PROFILE}`, '--no-first-run',
    '--no-default-browser-check', '--disable-search-engine-choice-screen', '--window-size=1400,1000'];
  if (process.getuid?.() === 0) args.push('--no-sandbox'); // Chrome refuses to start as root (Docker) without it
  // Headless gets a normal screen size (it defaults to 800x600) and starts blank, so the
  // user agent can be fixed before Flow loads (see Page.open).
  if (headless) { args.push('--headless=new', '--screen-info={1920x1080}'); start = 'about:blank'; }
  args.push(start);
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  let died = false;
  child.on('error', () => { died = true; });
  child.on('exit', () => { died = true; });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const r = await running();
    if (r) { fs.writeFileSync(BROWSER_FILE, exe); return r; }
    if (died && i > 2) break;
  }
  throw new CliError(`The browser did not start (${exe}). If a ${NAME} window from an old run is still open, close it and retry.`);
}

// Close the browser and wait until it has really exited, so its profile is free again.
async function closeBrowser(b) {
  if (!b) return;
  try { const c = new Cdp(b.ws); await c.ready; await c.send('Browser.close').catch(() => {}); c.close(); } catch {}
  for (let i = 0; i < 40; i++) {
    try { await getJson(`http://127.0.0.1:${b.port}/json/version`); } catch { break; }
    await sleep(250);
  }
  await sleep(700);
}

// ---------- one-at-a-time lock ----------
// Agents often fire several commands in parallel. They share the same browser profiles, so queue them.

const LOCK = path.join(HOME, 'lock');
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// The pid in the lock file: null when there is no lock, 0 while its owner is still writing it.
const lockHolder = () => { try { return Number(fs.readFileSync(LOCK, 'utf8').trim()) || 0; } catch { return null; } };
const fileAge = f => { try { return Date.now() - fs.statSync(f).mtimeMs; } catch { return 0; } };

async function lock(waitS = 900) {
  ensureHome();
  const deadline = Date.now() + waitS * 1000;
  let told = false, deniedSince = 0;
  for (;;) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); return; } catch (e) {
      // Windows refuses to create a file whose delete by another process is still pending (EPERM,
      // EACCES or EBUSY rather than EEXIST). That clears in moments; a folder we cannot write to does not.
      const denied = process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(e.code);
      if (denied) deniedSince ||= Date.now(); else deniedSince = 0;
      if (e.code !== 'EEXIST' && !(denied && Date.now() - deniedSince < 5000)) throw e;
    }
    const pid = lockHolder();
    if (Date.now() > deadline) throw new CliError(`Another ${NAME} run (pid ${pid}) has held the browser for ${waitS}s. Wait for it, or delete ${LOCK} if it is stuck.`, EXIT.busy);
    if (pid === null) { await sleep(10); continue; } // released between our two steps; try again
    // An empty lock file is one being written right now, unless it has been empty for a while.
    if (pid === 0 ? fileAge(LOCK) > 5000 : !pidAlive(pid)) breakStale(pid);
    if (pid === 0 || !pidAlive(pid)) { await sleep(20); continue; }
    if (!told) { log(`waiting for another ${NAME} run (pid ${pid}) to finish...`); told = true; }
    await sleep(200);
  }
}
// Remove a lock left behind by a run that died. Two waiters can both see the same dead pid, and the
// first one may already have taken a fresh lock by the time the second acts, so only the holder of
// lock.break may remove the lock, and only while the dead pid still holds it.
function breakStale(pid) {
  const brk = LOCK + '.break';
  if (fileAge(brk) > 10000) fs.rmSync(brk, { force: true }); // its holder died mid-break
  try { fs.writeFileSync(brk, String(process.pid), { flag: 'wx' }); } catch { return; }
  try { if (lockHolder() === pid) fs.rmSync(LOCK, { force: true }); } finally { fs.rmSync(brk, { force: true }); }
}
function unlock() {
  if (lockHolder() === process.pid) fs.rmSync(LOCK, { force: true });
}

// ---------- CDP ----------

class Cdp {
  constructor(ws) {
    this.id = 0; this.pending = new Map(); this.listeners = [];
    this.ws = new WebSocket(ws);
    this.ws.onmessage = ev => {
      const m = JSON.parse(ev.data), p = this.pending.get(m.id);
      if (m.method) for (const l of this.listeners) l(m.method, m.params);
      if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    };
    this.ws.onclose = () => { for (const p of this.pending.values()) p.reject(new CliError('The browser closed unexpectedly.')); this.pending.clear(); };
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new CliError('Could not connect to the browser.')); });
  }
  send(method, params = {}, timeoutMs = 60000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new CliError(`The browser stopped responding (${method}).`)); }, timeoutMs);
      this.pending.set(id, { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

class Page extends Cdp {
  // Use exactly one tab: the Flow tab if there is one, else the first tab. Close any others we own.
  static async open(b, owned) {
    const base = `http://127.0.0.1:${b.port}`;
    const pages = (await getJson(`${base}/json/list`)).filter(t => t.type === 'page');
    let t = pages.find(t => /flow\.google\.com|labs\.google/.test(t.url)) || pages[0];
    if (!t) t = await getJson(`${base}/json/new?${FLOW}`, { method: 'PUT' });
    if (owned) for (const o of pages) if (o.id !== t.id) await fetch(`${base}/json/close/${o.id}`).catch(() => {});
    const p = new Page(t.webSocketDebuggerUrl);
    p.browserWs = b.ws; p.headless = b.headless;
    await p.ready;
    // Headless Chrome announces itself in its user agent. Send what the same browser sends with a window,
    // client hints included (an override without them is its own giveaway). The headless browser starts on
    // about:blank, so Flow never sees the headless version.
    if (b.headless) {
      const major = (b.ua.match(/Chrome\/(\d+)/) || [])[1] || '0';
      const exe = browserPath().toLowerCase();
      const name = /msedge|edge/.test(exe) ? 'Microsoft Edge' : /brave/.test(exe) ? 'Brave' : /chromium/.test(exe) ? null : 'Google Chrome';
      const brands = [{ brand: 'Chromium', version: major }, ...(name ? [{ brand: name, version: major }] : []), { brand: 'Not A(Brand', version: '24' }];
      await p.send('Network.setUserAgentOverride', {
        userAgent: b.ua.replace('HeadlessChrome', 'Chrome'),
        userAgentMetadata: {
          brands, fullVersionList: brands.map(x => ({ ...x, version: x.version === '24' ? '24.0.0.0' : `${major}.0.0.0` })),
          platform: { win32: 'Windows', darwin: 'macOS' }[process.platform] || 'Linux', platformVersion: '',
          architecture: process.arch.startsWith('arm') ? 'arm' : 'x86', bitness: '64', model: '', mobile: false, wow64: false,
        },
      });
    }
    return p;
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'page script failed');
    return r.result?.value;
  }
  async goto(url) { await this.send('Page.navigate', { url }); await sleep(2500); }
  async click(xy) {
    if (!xy) throw new CliError('A Flow button this tool needs was not on screen. Flow may have changed its page; run again with CIG_DEBUG=1 and attach claude-image-gen-debug.png to an issue.');
    const [x, y] = xy;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
      await sleep(60);
    }
  }
  async key(key, code, vk) {
    for (const type of ['keyDown', 'keyUp']) await this.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk });
  }
}

async function waitFor(page, expr, seconds) {
  for (let i = 0; i < seconds * 2; i++) { const v = await page.eval(expr).catch(() => null); if (v) return v; await sleep(500); }
  return null;
}

// ---------- page scripts ----------

const OVERLAY = '.cdk-overlay-container';
const CENTER = 'e=>{const r=e.getBoundingClientRect();return r.width?[Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)]:null}';
// A button's text without its icon names ("crop_16_9 16:9" -> "16:9", "360p info" -> "360p").
const LABEL = `b=>{const c=b.cloneNode(true);c.querySelectorAll('mat-icon,.material-icons,.google-symbols').forEach(i=>i.remove());return c.textContent.replace(/\\s+/g,' ').trim()}`;
const JS = {
  // Where are we? project | home | signedout | unavailable | broken | loading
  // A project still loading has no prompt box yet, so it is 'loading', never 'home'. A failed tile inside a
  // working project can say "Something went wrong", so that text only means 'broken' when there's no box.
  state: `(()=>{const t=document.body?.innerText||'',box=document.querySelector('[contenteditable="true"]'),inProject=location.pathname.includes('/project/');
    if(location.hostname.startsWith('accounts.'))return 'signedout';
    if(inProject&&box)return 'project';
    if(/Something went wrong|Application error/i.test(t))return 'broken';
    if(!inProject&&(document.querySelector('a[href*="/project/"]')||[...document.querySelectorAll('button')].some(b=>/new project/i.test(b.innerText))))return 'home';
    if(/not available (in|for)|isn.t available|unavailable in your|age requirement/i.test(t))return 'unavailable';
    if(/sign in|create with google flow|get started/i.test(t))return 'signedout';
    return 'loading'})()`,
  account: `(document.querySelector('a[aria-label^="Google Account"]')?.getAttribute('aria-label')||'').replace(/^Google Account:\\s*/,'').replace(/\\s+/g,' ').trim()`,
  newProject: `(()=>{const e=[...document.querySelectorAll('button,[role=button],a')].find(e=>/new project/i.test(e.innerText||''));return e?(${CENTER})(e):null})()`,
  at: sel => `(()=>{const e=${sel};return e?(${CENTER})(e):null})()`,
  trigger: `document.querySelector('[aria-label="Settings trigger"]')`,
  popupOpen: `!!document.querySelector('${OVERLAY} [role=radio]')`,
  // Popup options, by their visible label: Image, Video, 16:9, 8s, 720p, x1 ...
  radios: `JSON.stringify([...document.querySelectorAll('${OVERLAY} [role=radio]')].map(b=>[(${LABEL})(b),b.getAttribute('aria-checked')==='true']))`,
  radio: label => `[...document.querySelectorAll('${OVERLAY} [role=radio]')].find(b=>(${LABEL})(b)===${JSON.stringify(label)})`,
  modelBtn: `document.querySelector('${OVERLAY} [aria-label="Select model family"]')`,
  clean: `t=>t.replace(/arrow_drop_down|volume_up/g,'').replace(/[^\\w .:-]/g,'').replace(/\\s+/g,' ').trim()`,
  credits: `+((document.querySelector('${OVERLAY}')?.innerText||'').match(/use (\\d+) credits?/)||[])[1]`,
  box: `document.querySelector('[contenteditable="true"]')`,
  selectBox: `(()=>{const b=document.querySelector('[contenteditable="true"]');b.focus();
    const r=document.createRange();r.selectNodeContents(b);const s=getSelection();s.removeAllRanges();s.addRange(r)})()`,
  boxText: `(document.querySelector('[contenteditable="true"]')?.innerText||'').replace(/\\s+/g,' ').trim()`,
  go: `document.querySelector('[aria-label="Start generation"]')`,
  goDisabled: `(b=>!b||b.disabled||b.getAttribute('aria-disabled')==='true')(document.querySelector('[aria-label="Start generation"]'))`,
  // Every generated tile on the page. Images: their full URL. Videos show a thumbnail that hovering
  // swaps for a <video> with the same id plus "=options", so videos are keyed by the URL up to "=".
  // Profile pictures (lh3 avatars) don't match the hosts.
  media: `(()=>{const els=[...document.querySelectorAll('img,video')].map(e=>[e,e.currentSrc||e.src])
      .filter(([,s])=>/flow\\.google\\.com\\/asb\\/|getMediaUrlRedirect|storage\\.googleapis|flow-content\\.google/.test(s));
    const isVid=e=>e.tagName==='VIDEO'||/video/i.test(e.alt||'');
    return JSON.stringify({image:[...new Set(els.filter(([e])=>!isVid(e)).map(([,s])=>s))],
      video:[...new Set(els.filter(([e])=>isVid(e)).map(([,s])=>s.split('=')[0]))]})})()`,
  // Mark the tile that holds this picture so we can find it again after hovering swaps the picture out.
  markTile: k => `(()=>{document.querySelectorAll('[data-cig]').forEach(e=>e.removeAttribute('data-cig'));
    let e=[...document.querySelectorAll('img,video')].find(i=>(i.currentSrc||i.src).split('=')[0]===${JSON.stringify(k)});
    while(e&&!e.querySelector?.('button[aria-label="More options"]'))e=e.parentElement;if(e)e.setAttribute('data-cig','1');return !!e})()`,
  // The clickable row in the open menu whose text (icons removed) matches.
  menuItem: re => `(e=>e&&(e.closest('button,[role^=menuitem],a')||e))([...document.querySelectorAll('${OVERLAY} *')]
    .filter(e=>e.getBoundingClientRect().width&&${re}.test((${LABEL})(e))).sort((a,b)=>a.innerText.length-b.innerText.length)[0])`,
  lines: `JSON.stringify((document.body.innerText||'').split('\\n').map(s=>s.trim()).filter(Boolean))`,
  // Download inside the page so the signed-in session is what fetches the file.
  grab: u => `(async()=>{const r=await fetch(${JSON.stringify(u)});if(!r.ok)throw new Error('HTTP '+r.status);
    const b=new Uint8Array(await r.arrayBuffer());let s='';for(let i=0;i<b.length;i+=32768)s+=String.fromCharCode.apply(null,b.subarray(i,i+32768));return btoa(s)})()`,
};

// ---------- Flow ----------

async function flowState(page, seconds = 40) {
  const s = await waitFor(page, `(s=>s==='loading'?null:s)(${JS.state})`, seconds);
  if (s === 'signedout') throw signedOut();
  if (s === 'unavailable') throw new CliError('Google Flow says it is not available for this account. Flow needs a Google account whose owner is 18 or older, in a country where Flow is offered.');
  return s || 'loading';
}

// Get onto the Flow project this tool uses, creating one the first time.
async function openProject(page) {
  if (await page.eval(JS.state) === 'project') return;
  let saved = null;
  try { saved = fs.readFileSync(PROJECT_FILE, 'utf8').trim(); } catch {}
  if (saved) {
    await page.goto(saved);
    if (await flowState(page) === 'project') return;
  }
  await page.goto(FLOW);
  const s = await flowState(page);
  if (s !== 'home') throw new CliError(`Google Flow did not load (state: ${s}). Check your internet connection, or run "${NAME} login" and make sure Flow opens.`);
  const np = await waitFor(page, JS.newProject, 10);
  if (!np) throw new CliError('Could not find the "New project" button in Flow.');
  await page.click(np);
  if (!await waitFor(page, `location.pathname.includes('/project/')&&!!${JS.box}`, 40))
    throw new CliError('Flow did not open a new project.');
  fs.writeFileSync(PROJECT_FILE, await page.eval('location.href'));
}

function resolveModel(kind, want) {
  const key = ALIASES[want] || want;
  const m = MODELS[kind].find(([k]) => k === key);
  if (m) return m[1];
  const other = kind === 'image' ? 'video' : 'image';
  if (MODELS[other].some(([k]) => k === key)) throw new CliError(`"${want}" is a ${other} model. Use "${NAME} ${other}" for it.`);
  return new RegExp(`^${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'); // an exact Flow label
}

async function openPopup(page) {
  if (await page.eval(JS.popupOpen)) return;
  for (let i = 0; i < 3; i++) {
    const at = await page.eval(JS.at(JS.trigger));
    if (!at) throw new CliError('Could not find Flow\'s settings button. Flow may have changed its page.');
    await page.click(at);
    if (await waitFor(page, JS.popupOpen, 4)) return;
  }
  throw new CliError('Flow\'s settings popup did not open.');
}

async function pickRadio(page, label, what) {
  const radios = JSON.parse(await page.eval(JS.radios));
  const hit = radios.find(([l]) => l.toLowerCase() === String(label).toLowerCase());
  if (!hit) throw new CliError(`Flow does not offer ${what} "${label}" here.`);
  if (hit[1]) return;
  await page.click(await page.eval(JS.at(JS.radio(hit[0]))));
  await sleep(500);
  if (!JSON.parse(await page.eval(JS.radios)).find(([l, on]) => l === hit[0] && on))
    throw new CliError(`Could not select ${what} "${label}" in Flow.`);
}

async function pickModel(page, kind, want) {
  const re = resolveModel(kind, want);
  const current = await page.eval(`(${JS.clean})(${JS.modelBtn}?.innerText||'')`);
  if (re.test(current)) return current;
  await page.click(await page.eval(JS.at(JS.modelBtn)));
  const items = await waitFor(page, `(a=>a.length?a:null)([...document.querySelectorAll('${OVERLAY} [role=menuitem]')].map(e=>(${JS.clean})(e.innerText)))`, 5) || [];
  const hit = items.find(t => re.test(t));
  if (!hit) {
    await page.key('Escape', 'Escape', 27);
    throw new CliError(`Flow does not offer the ${kind} model "${want}". Flow currently offers: ${items.join(', ') || 'nothing (menu did not open)'}.`);
  }
  await page.click(await page.eval(JS.at(`[...document.querySelectorAll('${OVERLAY} [role=menuitem]')].find(e=>(${JS.clean})(e.innerText)===${JSON.stringify(hit)})`)));
  await sleep(800);
  await openPopup(page); // picking a model can close the popup
  return hit;
}

// Set Image/Video, model, aspect, duration, resolution and count in Flow's settings popup.
async function configure(page, o) {
  await openPopup(page);
  await pickRadio(page, o.kind === 'video' ? 'Video' : 'Image', 'the mode');
  const radios = () => page.eval(JS.radios).then(JSON.parse).then(r => r.map(([l]) => l));
  if (o.kind === 'video' && (await radios()).includes('Ingredients')) await pickRadio(page, 'Ingredients', 'the video type');
  const model = await pickModel(page, o.kind, o.model);
  const offered = await radios();
  await pickRadio(page, o.aspect, 'the aspect ratio').catch(e => {
    throw new CliError(`${e.message} Options: ${offered.filter(l => /^\d+:\d+$/.test(l)).join(', ')}.`); });
  const durations = offered.filter(l => /^\d+s$/.test(l)), res = offered.filter(l => /^\d+p$/.test(l));
  if (o.duration) {
    if (!durations.length) throw new CliError(`${model} has a fixed length; --duration only works with omni-flash.`);
    await pickRadio(page, o.duration, 'the duration').catch(e => { throw new CliError(`${e.message} Options: ${durations.join(', ')}.`); });
  } else if (durations.includes('8s')) await pickRadio(page, '8s', 'the duration');
  if (o.resolution) {
    if (!res.length) throw new CliError(`${model} has a fixed resolution; --resolution only works with omni-flash.`);
    await pickRadio(page, o.resolution, 'the resolution').catch(e => { throw new CliError(`${e.message} Options: ${res.join(', ')}.`); });
  } else if (res.includes('720p')) await pickRadio(page, '720p', 'the resolution');
  await pickRadio(page, `x${o.count}`, 'the count');
  const credits = await page.eval(JS.credits);
  await page.key('Escape', 'Escape', 27);
  await sleep(400);
  return { model, credits: Number.isFinite(credits) ? credits : null };
}

function sniff(buf) {
  if (buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return '.webp';
  if (buf.slice(4, 8).toString() === 'ftyp') return '.mp4';
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return '.webm';
  return null;
}

// A video tile only shows a preview (lower quality than the real file), so save it the way a person
// would: tile menu > Download > Original size, with the browser's download landing in a temp folder.
async function downloadOriginal(page, thumb) {
  const tile = `document.querySelector('[data-cig]')`;
  // A brand-new tile can take a moment to get its size, so wait until it is on screen.
  const at = await waitFor(page, `${JS.markTile(thumb)}&&${JS.at(tile)}`, 20);
  if (!at) throw new CliError('Could not find the new video in Flow\'s grid.');
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at[0], y: at[1] });
  await sleep(800);
  const more = await page.eval(JS.at(`${tile}.querySelector('button[aria-label="More options"]')`));
  if (!more) throw new CliError('Could not open the video\'s menu in Flow.');
  await page.click(more);
  const dl = await waitFor(page, JS.at(JS.menuItem('/^Download$/')), 5);
  if (!dl) throw new CliError('Flow\'s video menu has no Download option.');
  await page.click(dl);
  if (!await waitFor(page, JS.at(JS.menuItem('/Original size/')), 5)) throw new CliError('Flow\'s Download menu has no "Original size" option.');
  await sleep(700); // the submenu slides in; click once it has stopped moving
  const orig = await page.eval(JS.at(JS.menuItem('/Original size/')));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cig-'));
  const browser = new Cdp(page.browserWs);
  await browser.ready;
  try {
    const done = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new CliError('The video download did not finish in 3 minutes.')), 180000);
      browser.listeners.push((m, p) => {
        if (m !== 'Browser.downloadProgress') return;
        if (p.state === 'completed') { clearTimeout(t); resolve(p.filePath || path.join(dir, p.guid)); }
        if (p.state === 'canceled') { clearTimeout(t); reject(new CliError('Flow canceled the video download.')); }
      });
    });
    await browser.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dir, eventsEnabled: true });
    await page.click(orig);
    return fs.readFileSync(await done);
  } finally {
    await browser.send('Browser.setDownloadBehavior', { behavior: 'default' }).catch(() => {});
    browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
    await page.key('Escape', 'Escape', 27).catch(() => {});
  }
}

const FAIL = /fail|couldn.t|could not|unable to|violat|policy|not allowed|try again|went wrong|limit|quota|credits? (left|remaining)|not enough/i;

async function generate(page, prompt, out, o) {
  await openProject(page);
  const { model, credits } = await configure(page, o);
  log(`${o.kind} | ${model} | ${o.aspect}${o.duration ? ' | ' + o.duration : ''} | x${o.count}` + (credits ? ` | uses ${credits} Flow credits` : ' | free'));

  const before = JSON.parse(await page.eval(JS.media))[o.kind];
  const linesBefore = new Map();
  for (const l of JSON.parse(await page.eval(JS.lines))) linesBefore.set(l, (linesBefore.get(l) || 0) + 1);
  const box = await page.eval(JS.at(JS.box));
  if (!box) throw new CliError('No prompt box on the Flow page.');
  await page.click(box);
  await sleep(300);
  // Select the old text through the DOM, then type as real input so Flow's editor sees it.
  await page.eval(JS.selectBox);
  const text = prompt.replace(/\s+/g, ' ').trim();
  await page.send('Input.insertText', { text });
  await sleep(1200);
  const typed = await page.eval(JS.boxText);
  if (!typed.startsWith(text.slice(0, 40))) throw new CliError(`The prompt did not land in Flow's prompt box (it holds: "${typed.slice(0, 60)}").`);
  if (await page.eval(JS.goDisabled)) {
    // Flow greys out Create, with no message, when the account can't afford the generation.
    if (credits) throw new CliError(`OUT OF CREDITS: Flow won't start this ${o.kind}: it costs ${credits} credits and the account has fewer. ` +
      `Credits refill daily; omni-flash at 4s/360p is the cheapest video. Images are free.`, EXIT.credits);
    throw new CliError('Flow\'s Create button is disabled.');
  }
  await page.click(await page.eval(JS.at(JS.go)));

  const timeout = (Number(process.env.CIG_TIMEOUT) || (o.kind === 'video' ? 600 : 240)) * 1000;
  const start = Date.now();
  let fresh = [];
  while (Date.now() - start < timeout) {
    await sleep(3000);
    const st = await page.eval(JS.state);
    if (st === 'signedout') throw signedOut();
    fresh = JSON.parse(await page.eval(JS.media))[o.kind].filter(u => !before.includes(u));
    if (fresh.length >= o.count) break;
    // A line is new if it shows up more often than before (a second identical failure is still new).
    const seen = new Map(linesBefore);
    const newLines = JSON.parse(await page.eval(JS.lines)).filter(l => { const n = seen.get(l) || 0; seen.set(l, n - 1); return n <= 0; })
      .filter(l => l.length < 300 && !text.includes(l.replace(/…$/, '')) && !l.includes(text.slice(0, 30))); // the tile repeats the prompt
    const i = newLines.findIndex(l => FAIL.test(l));
    if (i >= 0) {
      const msg = newLines.slice(i, i + 3).join(' ');
      // "Unusual activity" is Google's limit on many generations from one account in a short time.
      if (/unusual activity/i.test(msg)) throw new CliError(`RATE LIMITED: Flow says "${msg}" Too many generations ` +
        `in a short time. Nothing was charged. Wait a while (it can take a few hours) and try again.`, EXIT.rateLimited);
      if (/(not enough|out of|insufficient|no) credits/i.test(msg)) throw new CliError(`OUT OF CREDITS: Flow says "${msg}" Credits refill daily; images are free.`, EXIT.credits);
      throw new CliError(`Flow refused or failed: "${msg}"`, EXIT.refused);
    }
  }
  if (!fresh.length) throw new CliError(`Nothing came back after ${Math.round(timeout / 1000)}s. Flow may be busy or rate-limiting you; wait and retry.`);
  await sleep(1500); // let the final file settle
  const saved = [];
  for (const [i, u] of fresh.slice(0, o.count).entries()) {
    const buf = o.kind === 'video' ? await downloadOriginal(page, u) : Buffer.from(await page.eval(JS.grab(u)), 'base64');
    const ext = sniff(buf);
    if (!ext || (o.kind === 'video') !== /mp4|webm/.test(ext))
      throw new CliError(`Flow returned something that is not ${o.kind === 'video' ? 'a video' : 'an image'} (${buf.length} bytes).`);
    let file = o.count > 1 ? out.replace(/(\.\w+)?$/, `-${i + 1}$1`) : out;
    // Use the real format's extension (Flow decides PNG or JPEG), so "-o x.png" never mislabels a JPEG.
    const asked = path.extname(file).toLowerCase();
    if (asked !== ext && !(asked === '.jpeg' && ext === '.jpg')) {
      if (asked) log(`note: Flow returned ${ext.slice(1).toUpperCase()}, saving as ${ext}`);
      file = file.slice(0, file.length - asked.length) + ext;
    }
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, buf);
    saved.push(path.resolve(file));
  }
  return { files: saved, model, credits };
}

// ---------- accounts ----------

const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; } };
const writeConfig = c => { ensureHome(); fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2)); };

// Signed-in accounts, alphabetical (the numbers "accounts" shows), and the active one.
function accounts() {
  let list = [];
  try { list = fs.readdirSync(ACCOUNTS_DIR).filter(n => !n.startsWith('.') && fs.existsSync(path.join(ACCOUNTS_DIR, n, 'profile'))).sort(); } catch {}
  let active = readConfig().active;
  if (!list.includes(active)) active = list[0];
  return { list, active };
}

// Find an account by number ("2") or email.
function findAccount(want) {
  const { list } = accounts();
  if (!list.length) throw noAccount();
  const hit = /^\d+$/.test(want) ? list[Number(want) - 1] : list.find(n => n === String(want).toLowerCase());
  if (!hit) throw new CliError(`No account "${want}". Accounts: ${list.map((n, i) => `${i + 1}. ${n}`).join(', ')}.`);
  return hit;
}

// These failures are about the account, not the prompt, and charge nothing, so the next account can take over.
const SWITCHABLE = [EXIT.signedOut, EXIT.credits, EXIT.rateLimited];

// Run fn once per account, starting with the active one (or only --account), until one succeeds.
async function eachAccount(a, fn) {
  const { list, active } = accounts();
  if (!list.length) throw noAccount();
  const order = a.account ? [findAccount(a.account)] : [active, ...list.filter(n => n !== active)];
  const failed = [];
  for (const email of order) {
    select(path.join(ACCOUNTS_DIR, email));
    if (order.length > 1) log(`account: ${email}`);
    try { return await fn(email); } catch (e) {
      if (!SWITCHABLE.includes(e.code)) throw e;
      failed.push([email, e]);
      if (email !== order[order.length - 1]) log(`${email}: ${e.message.split(':')[0].toLowerCase()}; switching to the next account`);
    }
  }
  if (failed.length === 1) throw failed[0][1];
  const code = [EXIT.rateLimited, EXIT.credits, EXIT.signedOut].find(c => failed.some(([, e]) => e.code === c));
  throw new CliError(`Every account failed:\n${failed.map(([n, e]) => `  ${n}: ${e.message}`).join('\n')}`, code);
}


// ---------- commands (shared by the command line and the MCP server) ----------

function parseArgs(argv) {
  const a = { _: [], show: false, video: false, count: 1 };
  const val = (i, f) => { if (argv[i + 1] === undefined) throw new CliError(`${f} needs a value.`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--show') a.show = true;
    else if (v === '--headless') a.show = false;
    else if (v === '--video') a.video = true;
    else if (v === '-h' || v === '--help') a.help = true;
    else if (v === '-v' || v === '--version') a.version = true;
    else if (['-o', '--out'].includes(v)) a.out = val(i++, v);
    else if (['-m', '--model'].includes(v)) a.model = val(i++, v).toLowerCase();
    else if (['-a', '--aspect'].includes(v)) a.aspect = val(i++, v);
    else if (['-n', '--count'].includes(v)) a.count = Number(val(i++, v));
    else if (['-d', '--duration'].includes(v)) a.duration = val(i++, v);
    else if (['-r', '--resolution'].includes(v)) a.resolution = val(i++, v);
    else if (v === '--account') a.account = val(i++, v);
    else if (v === '--browser') a.browser = val(i++, v).toLowerCase();
    else if (v.startsWith('-') && v.length > 1) throw new CliError(`Unknown option "${v}". Run "${NAME} --help".`);
    else a._.push(v);
  }
  return a;
}

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'flow';
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function genOptions(a, kind) {
  if (kind === 'image' && (a.duration || a.resolution)) throw new CliError('--duration and --resolution are video options.');
  const count = Number(a.count ?? 1);
  if (!(Number.isInteger(count) && count >= 1 && count <= 4)) throw new CliError('--count must be 1, 2, 3 or 4.');
  return { kind, model: a.model || (kind === 'video' ? 'omni-flash' : 'nano-banana-2'), aspect: a.aspect || '16:9', count,
    duration: a.duration && String(a.duration).replace(/^(\d+)$/, '$1s'), resolution: a.resolution && String(a.resolution).replace(/^(\d+)$/, '$1p') };
}

// Where to save: the path asked for, or a name made from the prompt (inside the folder asked for, if it is one).
function outPath(want, prompt, base = '.') {
  const name = `${slug(prompt)}-${Date.now()}`;
  if (!want) return path.resolve(base, name);
  const out = path.resolve(base, want);
  return /[\\/]$/.test(want) || isDir(out) ? path.join(out, name) : out;
}

// The prompts of a batch still to make. Prompt 3 is saved as 003-<slug>.<ext> (or -1..-4 with a count),
// so a batch that stopped halfway picks up where it left off.
function batchTodo(prompts, dir, kind) {
  const ext = kind === 'video' ? '(mp4|webm)' : '(png|jpe?g|webp)';
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  return prompts.map((p, i) => ({ p, i, base: path.join(dir, `${String(i + 1).padStart(3, '0')}-${slug(p)}`) }))
    .filter(t => { const re = new RegExp(`^${escapeRe(path.basename(t.base))}(-[1-4])?\\.${ext}$`, 'i'); return !files.some(f => re.test(f)); });
}

// Run fn with a page in the selected account's browser, then close the browser if this run started it.
let cleanup = null;
async function withPage(a, fn) {
  let b = null, owned = false, page = null;
  cleanup = async () => { page?.close(); if (owned) await closeBrowser(b); };
  try {
    b = await running();
    // We hold the lock, so a headless browser still running is left over from a killed run: adopt it
    // (it gets closed at the end), or replace it when the window should be visible.
    if (b && b.headless) { owned = true; if (a.show) { await closeBrowser(b); b = null; } }
    if (!b) { b = await launch(!a.show, a.browser); owned = true; }
    page = await Page.open(b, owned);
    return await fn(page).catch(async e => {
      // CIG_DEBUG=1 saves what the browser showed when it failed, for bug reports.
      if (process.env.CIG_DEBUG) {
        const shot = await page.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
        // In the current folder, or the temp folder when that isn't writable (an MCP server started in /).
        for (const dir of shot ? ['.', os.tmpdir()] : []) {
          const f = path.resolve(dir, 'claude-image-gen-debug.png');
          try { fs.writeFileSync(f, Buffer.from(shot.data, 'base64')); log(`debug screenshot: ${f}`); break; } catch {}
        }
      }
      throw e;
    });
  } finally { const c = cleanup; cleanup = null; await c(); }
}

// Hold the lock for the whole command.
async function locked(fn, waitS) {
  await lock(waitS);
  try { return await fn(); } finally { unlock(); }
}

// Generate one prompt with the first account that can. Returns { files, model, credits }.
async function make(a, kind, prompt, out) {
  const o = genOptions(a, kind);
  return locked(() => eachAccount(a, () => withPage(a, page => generate(page, prompt, out, o))));
}

function accountsText() {
  const { list, active } = accounts();
  if (!list.length) return `No accounts yet. Run "${NAME} login" to add one.`;
  return `Accounts (runs use the active one; if it is signed out, out of credits or rate-limited, the next is tried):\n` +
    `${list.map((n, i) => `  ${i + 1}. ${n}${n === active ? '  (active)' : ''}`).join('\n')}\n` +
    `Add another: ${NAME} login    Make one active: ${NAME} use <number>    Remove: ${NAME} logout <number>`;
}

function useAccount(want) {
  if (!want) throw new CliError(`Usage: ${NAME} use <number or email>\n\n${accountsText()}`);
  const cfg = readConfig();
  cfg.active = findAccount(want);
  writeConfig(cfg);
  return `Active account: ${cfg.active}\n\n${accountsText()}`;
}

function logout(want) {
  return locked(async () => {
    const { list, active } = accounts();
    if (!list.length) return 'No accounts to remove.';
    const email = want ? findAccount(want) : active;
    select(path.join(ACCOUNTS_DIR, email));
    await closeBrowser(await running());
    fs.rmSync(path.join(ACCOUNTS_DIR, email), { recursive: true, force: true });
    return `Removed ${email}.\n\n${accountsText()}`;
  }, 30);
}

// Open Flow with each account to see whether Google still has it signed in.
function status(a) {
  return locked(async () => {
    const { list, active } = accounts();
    if (!list.length) throw noAccount();
    const lines = [];
    let ok = 0;
    for (const email of a.account ? [findAccount(a.account)] : list) {
      select(path.join(ACCOUNTS_DIR, email));
      const tag = `${email}${email === active ? ' (active)' : ''}`;
      try {
        await withPage(a, page => openProject(page));
        lines.push(`${tag}: signed in`);
        ok++;
      } catch (e) {
        if (e.code !== EXIT.signedOut) throw e;
        lines.push(`${tag}: NOT SIGNED IN. Run "${NAME} login" and sign in as ${email}.`);
      }
    }
    return { text: lines.join('\n'), ok };
  });
}

// Sign in with a fresh profile, then file it under the account's email. Signing in to an
// account that is already there replaces it, which is how a signed-out account is fixed.
function login(a) {
  return locked(async () => {
    const tmp = path.join(ACCOUNTS_DIR, `.signing-in-${process.pid}`);
    // Clear sign-ins a killed run left behind (we hold the lock, so none of them is still in progress).
    try { for (const n of fs.readdirSync(ACCOUNTS_DIR)) if (n.startsWith('.signing-in-')) fs.rmSync(path.join(ACCOUNTS_DIR, n), { recursive: true, force: true }); } catch {}
    select(tmp);
    let b = null;
    try {
      b = await launch(false, a.browser, `https://accounts.google.com/ServiceLogin?continue=${encodeURIComponent(FLOW + '/')}`);
      const page = await Page.open(b, true);
      log(`A browser window is open. Sign in with your Google account and wait for Flow to load; the window\n` +
        `closes by itself. (Flow needs an account whose owner is 18 or older.)`);
      const deadline = Date.now() + 15 * 60 * 1000;
      let s;
      while (Date.now() < deadline) {
        try {
          s = await page.eval(JS.state);
          // Flow's marketing page means the sign-in didn't carry over; send the person back to Google's sign-in.
          if (s === 'signedout' && /flow\.google\.com/.test(await page.eval('location.host'))) {
            await page.goto(`https://accounts.google.com/ServiceLogin?continue=${encodeURIComponent(FLOW + '/')}`);
            continue;
          }
          // Wait out Flow's first-visit dialogs (terms, welcome) so the person can accept them.
          if ((s === 'home' || s === 'project') && !await page.eval(`!!document.querySelector('[role=dialog],mat-dialog-container')`)) break;
        } catch { throw new CliError('The sign-in window was closed before sign-in finished. Run login again.'); }
        if (s === 'unavailable') throw new CliError('Google Flow says it is not available for this account. It needs an account whose owner is 18 or older, in a country where Flow is offered.');
        await sleep(1500);
      }
      if (s !== 'home' && s !== 'project') throw new CliError('Timed out after 15 minutes waiting for sign-in.');
      await sleep(2000); // let the browser finish saving the session
      const email = ((await page.eval(JS.account).catch(() => '')).match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/) || [])[0];
      page.close();
      await closeBrowser(b);
      b = null;
      if (!email) throw new CliError('Signed in, but could not read which Google account it is. Run login again.');
      const { key, replaced } = await fileAccount(tmp, email);
      return `${replaced ? 'Signed in again' : 'Signed in'} as ${key}.\n\n${accountsText()}`;
    } finally {
      if (b) await closeBrowser(b);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30);
}

// Move a freshly signed-in profile folder to accounts/<email>, replacing an old sign-in of the same account.
// The first account becomes the active one.
async function fileAccount(tmp, email) {
  const key = email.toLowerCase(), dest = path.join(ACCOUNTS_DIR, key);
  const replaced = fs.existsSync(dest);
  try { fs.copyFileSync(path.join(dest, 'project.txt'), path.join(tmp, 'project.txt')); } catch {}
  for (let i = 0; ; i++) { // the browser can hold its files for a moment after it exits
    try { fs.rmSync(dest, { recursive: true, force: true }); fs.renameSync(tmp, dest); break; } catch (e) { if (i > 40) throw e; await sleep(250); }
  }
  const cfg = readConfig();
  if (!accounts().list.includes(cfg.active)) { cfg.active = key; writeConfig(cfg); }
  return { key, replaced };
}

// ---------- MCP server ----------
// "claude-image-gen mcp" speaks the Model Context Protocol over stdio (JSON-RPC 2.0, one message per line),
// so Claude Code, Claude Desktop, Cursor and other MCP clients can call the generator as tools.

const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const IMAGE_ASPECTS = ['16:9', '4:3', '1:1', '3:4', '9:16'], VIDEO_ASPECTS = ['16:9', '9:16'];
const PREVIEW_MAX = 3.5 * 1024 * 1024; // images bigger than this are returned as a path only
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

// Where MCP saves files given no absolute path: CIG_OUTPUT_DIR, else the folder the client started the server in,
// unless that is the filesystem root or read-only (as with desktop apps); then ~/claude-image-gen.
function outputDir() {
  if (process.env.CIG_OUTPUT_DIR) return path.resolve(process.env.CIG_OUTPUT_DIR);
  const cwd = process.cwd();
  try { if (path.parse(cwd).root !== cwd) { fs.accessSync(cwd, fs.constants.W_OK); return cwd; } } catch {}
  return path.join(os.homedir(), NAME);
}

const MCP_INSTRUCTIONS = `Generates images (free) and videos (spend Google Flow credits) with Google Flow through the user's
own signed-in Google account. Calls run one at a time; an image takes 20-60 s, a video 1-3 min. Save files into the
user's project by passing an absolute "output" path. If a tool reports NOT SIGNED IN, call "login" and tell the user
to sign in in the browser window that opens. Tell the user what a video will cost before generating several.`;

function mcpTools() {
  const s = (description, extra) => ({ type: 'string', description, ...extra });
  const gen = kind => ({
    prompt: s(`What the ${kind} should show: subject, style, composition, lighting${kind === 'video' ? ', camera motion' : ''}.`),
    model: s(`Model. Default ${kind === 'video' ? 'omni-flash' : 'nano-banana-2'}.`, { enum: MODELS[kind].map(([k]) => k) }),
    aspect_ratio: s('Aspect ratio. Default 16:9.', { enum: kind === 'video' ? VIDEO_ASPECTS : IMAGE_ASPECTS }),
    count: { type: 'integer', minimum: 1, maximum: 4, description: 'How many to make from the prompt (files get -1, -2, ...). Default 1.' },
    output: s(`Where to save: a file path without extension (the real one is added), or a folder ending in "/". ` +
      `Relative paths are resolved against ${outputDir()}. Default: a name made from the prompt, in that folder.`),
    account: s('Use only this account: its number from list_accounts, or its email. Default: the active account, then the others.'),
  });
  const files = { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } }, model: { type: 'string' }, credits: { type: 'number' } }, required: ['files'] };
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  return [
    { name: 'generate_image', title: 'Generate image',
      description: 'Generate an image with Google Flow (Nano Banana). Free. Returns the saved file paths and the image itself. ' +
        'nano-banana-pro has the best quality and text rendering; nano-banana-2-lite is fastest.',
      inputSchema: { type: 'object', properties: { ...gen('image'),
        preview: { type: 'boolean', description: 'Return the image in the result so you can see it. Default true.' } }, required: ['prompt'] },
      outputSchema: files, annotations: write },
    { name: 'generate_video', title: 'Generate video',
      description: 'Generate a video with sound with Google Flow (Omni Flash or Veo). Spends Flow credits, which refill daily: ' +
        'omni-flash 4-15 credits (4s at 360p is cheapest), veo-lite ~10, veo-fast ~20, veo-quality ~100. Returns the saved file paths.',
      inputSchema: { type: 'object', properties: { ...gen('video'),
        duration: s('omni-flash only. Default 8s. Veo is always 8s.', { enum: ['4s', '6s', '8s', '10s'] }),
        resolution: s('omni-flash only. Default 720p. Veo is always 720p.', { enum: ['360p', '720p'] }) }, required: ['prompt'] },
      outputSchema: files, annotations: write },
    { name: 'list_accounts', title: 'List accounts', description: 'List the signed-in Google accounts and which one is active.',
      inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, openWorldHint: false } },
    { name: 'check_accounts', title: 'Check sign-ins',
      description: 'Check that each Google account is still signed in to Flow. Opens a headless browser per account (about 10 s each).',
      inputSchema: { type: 'object', properties: { account: s('Check only this account (number or email).') } },
      annotations: { readOnlyHint: true, openWorldHint: true } },
    { name: 'login', title: 'Sign in',
      description: 'Open a browser window on the user\'s screen to sign in to a Google account (adds it, or refreshes a signed-out one). ' +
        'Waits up to 15 minutes. Tell the user to sign in in that window; the account must belong to someone 18 or older.',
      inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
  ];
}

const HINTS = {
  [EXIT.signedOut]: 'Call the "login" tool and ask the user to sign in in the window that opens, then retry.',
  [EXIT.credits]: 'Credits refill daily. Images are free; omni-flash at 4s/360p is the cheapest video.',
  [EXIT.refused]: 'Rephrase the prompt (no real people, logos or unsafe content).',
  [EXIT.rateLimited]: 'Nothing was charged. Wait before retrying; it can take a few hours.',
};
const CODE_NAMES = { 1: 'error', 2: 'not_signed_in', 3: 'busy', 4: 'out_of_credits', 5: 'refused', 6: 'rate_limited' };

async function mcpCall(name, args = {}) {
  const a = { _: [], show: false, model: args.model?.toLowerCase(), aspect: args.aspect_ratio, count: args.count ?? 1,
    duration: args.duration, resolution: args.resolution, account: args.account != null ? String(args.account) : undefined };
  if (name === 'generate_image' || name === 'generate_video') {
    const kind = name === 'generate_video' ? 'video' : 'image';
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) throw new CliError('"prompt" is required.');
    const r = await make(a, kind, args.prompt, outPath(args.output, args.prompt, outputDir()));
    const content = [{ type: 'text', text: `Saved ${r.files.length} ${kind}${r.files.length > 1 ? 's' : ''} ` +
      `(${r.model}, ${r.credits ? `used ${r.credits} Flow credits` : 'free'}):\n${r.files.join('\n')}` }];
    if (kind === 'image' && args.preview !== false)
      for (const f of r.files) if (fs.statSync(f).size <= PREVIEW_MAX) content.push({ type: 'image', data: fs.readFileSync(f).toString('base64'), mimeType: MIME[path.extname(f)] });
    return { content, structuredContent: { files: r.files, model: r.model, credits: r.credits || 0 } };
  }
  if (name === 'list_accounts') return { content: [{ type: 'text', text: accountsText() }] };
  if (name === 'check_accounts') { const r = await status(a); return { content: [{ type: 'text', text: r.text }], isError: !r.ok }; }
  if (name === 'login') return { content: [{ type: 'text', text: await login(a) }] };
  return null;
}

function mcpServe() {
  const send = m => process.stdout.write(JSON.stringify(m) + '\n');
  console.log = console.error; // stdout carries the protocol; nothing else may write to it
  let queue = Promise.resolve(); // one tool call at a time: they share the browser profiles

  async function handle(m) {
    const reply = result => send({ jsonrpc: '2.0', id: m.id, result });
    const fail = (code, message) => send({ jsonrpc: '2.0', id: m.id, error: { code, message } });
    if (m.method === 'initialize') {
      const want = m.params?.protocolVersion;
      return reply({ protocolVersion: MCP_VERSIONS.includes(want) ? want : MCP_VERSIONS[0], capabilities: { tools: {} },
        serverInfo: { name: NAME, title: 'Claude Image Gen', version: VERSION }, instructions: MCP_INSTRUCTIONS });
    }
    if (m.method === 'ping') return reply({});
    if (m.method === 'tools/list') return reply({ tools: mcpTools() });
    if (m.method === 'tools/call') {
      const { name, arguments: args } = m.params || {};
      if (!mcpTools().some(t => t.name === name)) return fail(-32602, `Unknown tool "${name}".`);
      // Progress notifications show what is happening and keep the client from timing out on long videos.
      const token = m.params?._meta?.progressToken, started = Date.now();
      let n = 0;
      const progress = message => token !== undefined && send({ jsonrpc: '2.0', method: 'notifications/progress',
        params: { progressToken: token, progress: ++n, message: message || `working (${Math.round((Date.now() - started) / 1000)}s)` } });
      const tick = setInterval(progress, 15000);
      const job = queue.then(async () => {
        onLog = msg => progress(String(msg).split('\n')[0]);
        try { reply(await mcpCall(name, args)); } catch (e) {
          const code = e instanceof CliError ? e.code : EXIT.error;
          reply({ content: [{ type: 'text', text: `${CODE_NAMES[code] || 'error'}: ${e.message}${HINTS[code] ? ' ' + HINTS[code] : ''}` }], isError: true });
        } finally { onLog = null; clearInterval(tick); }
      });
      queue = job.catch(() => {});
      return job;
    }
    if (m.id !== undefined && m.method) return fail(-32601, `Method not found: ${m.method}`);
  }

  const rl = require('readline').createInterface({ input: process.stdin });
  rl.on('line', line => {
    if (!line.trim()) return;
    let m;
    try { m = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    for (const msg of Array.isArray(m) ? m : [m]) handle(msg).catch(e => log(`mcp: ${e.message}`));
  });
  rl.on('close', async () => { if (cleanup) await cleanup(); unlock(); process.exit(0); });
  log(`${NAME} ${VERSION} MCP server ready on stdio`);
}

// ---------- command line ----------

async function main() {
  if (typeof WebSocket === 'undefined') throw new CliError(`${NAME} needs Node.js 22 or newer (you have ${process.version}).`);
  const a = parseArgs(process.argv.slice(2));
  const [cmd, arg] = a._;
  if (a.version) return console.log(VERSION);
  if (a.help || !cmd) return console.log(HELP);

  if (cmd === 'mcp') return mcpServe();
  if (cmd === 'login') return console.log(await login(a));
  if (cmd === 'accounts') return console.log(accountsText());
  if (cmd === 'use') return console.log(useAccount(arg));
  if (cmd === 'logout') return console.log(await logout(arg));
  if (cmd === 'status') {
    const r = await status(a);
    console.log(r.text);
    if (!r.ok) process.exitCode = EXIT.signedOut;
    return;
  }

  if (cmd === 'image' || cmd === 'video' || cmd === 'gen') {
    const kind = cmd === 'video' ? 'video' : 'image';
    if (!arg) throw new CliError(`Usage: ${NAME} ${kind} "<prompt>" [-o file]`);
    const r = await make(a, kind, arg, outPath(a.out, arg));
    for (const f of r.files) console.log(f);
    return;
  }

  if (cmd === 'batch') {
    if (!arg) throw new CliError(`Usage: ${NAME} batch <prompts.txt> [-o folder] [--video]`);
    if (!fs.existsSync(arg)) throw new CliError(`No such file: ${arg}`);
    const prompts = fs.readFileSync(arg, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
    if (!prompts.length) throw new CliError(`${arg} has no prompts (one per line; lines starting with # are skipped).`);
    const o = genOptions(a, a.video ? 'video' : 'image');
    const dir = a.out || 'flow-output';
    fs.mkdirSync(dir, { recursive: true });
    const todo = batchTodo(prompts, dir, o.kind);
    if (todo.length < prompts.length) log(`${prompts.length - todo.length} of ${prompts.length} already saved, skipping them`);
    let ok = 0, failed = 0, streak = 0;
    try {
      // An account that runs out of credits or gets rate-limited throws, and the next account picks up the rest.
      await locked(() => eachAccount(a, () => withPage(a, async page => {
        while (todo.length) {
          const t = todo[0], tag = `[${t.i + 1}/${prompts.length}]`;
          try {
            for (const f of (await generate(page, t.p, t.base, o)).files) console.log(f);
            ok++; streak = 0; todo.shift();
          } catch (e) {
            if (SWITCHABLE.includes(e.code)) throw e;
            log(`${tag} FAILED: ${e.message}`); failed++; todo.shift();
            if (++streak >= 3) { log('Stopping: 3 failures in a row. Flow may be rate-limiting you; wait a while and run the same batch again.'); return; }
          }
        }
      })));
    } finally {
      log(`done: ${ok} saved, ${failed} failed, ${todo.length} left. Run the same batch again to retry what's left.`);
    }
    if (failed) process.exitCode = 1;
    return;
  }

  throw new CliError(`Unknown command "${cmd}". Run "${NAME} --help".`);
}

if (require.main === module) {
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.on(sig, async () => { if (cleanup) await cleanup(); unlock(); process.exit(code); });
  main().catch(e => { console.error(`error: ${e.message}`); process.exit(e.code || EXIT.error); });
}
module.exports = {
  Page, Cdp, JS, launch, closeBrowser, running, browserPath, select, generate, downloadOriginal, openProject,
  fileAccount, accounts, findAccount, eachAccount, lock, unlock, parseArgs, genOptions, resolveModel, sniff, slug,
  outPath, batchTodo, mcpTools, mcpCall, EXIT, CliError, VERSION,
};
