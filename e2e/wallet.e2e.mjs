// End-to-end browser test for the wallet chat's live mode.
//
// Drives a headless Chrome over the DevTools protocol (no extra dependencies)
// against a running API with seeded data (@amina PIN 1234, @juma, Java House
// Till 832909), and asserts on what the person sees and on the real balances:
// sign-in, send to an @tag, pay a Till, a business request arriving and being
// paid, a pasted till code, history, receive QR, reload, sign-out.
//
//   WALLET_URL='http://127.0.0.1:8766/index.html?api=http://localhost:4000' API_URL=http://localhost:4000 node e2e/wallet.e2e.mjs
//
// CHROME_BIN overrides the browser; screenshots go to E2E_OUT (default e2e/out).
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAGE = process.env.WALLET_URL ?? 'http://127.0.0.1:8766/index.html?api=http://localhost:4000';
const API = process.env.API_URL ?? 'http://localhost:4000';
const OUT = process.env.E2E_OUT ?? 'e2e/out';
const PORT = Number(process.env.CDP_PORT ?? 9334);
const CHROME = process.env.CHROME_BIN
  ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, what, detail = '') => {
  if (cond) console.log('  ✓', what);
  else { failures++; console.log('  ✗', what, detail ? '— ' + detail : ''); }
};
const post = async (path, body, token) => fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const custToken = async (tag, pin) => (await (await post('/customer/auth/login', { axoTag: tag, pin })).json()).accessToken;
const balanceOf = async (tag, pin) => BigInt((await (await fetch(API + '/customer/me', { headers: { authorization: `Bearer ${await custToken(tag, pin)}` } })).json()).wallet.balanceMinor);

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpdir(), 'axo-wallet-e2e-' + process.pid)}`,
  '--window-size=460,940', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  ...(process.env.CI ? ['--no-sandbox'] : []), 'about:blank',
], { stdio: 'ignore' });

let ws;
try {
  let targets = [];
  for (let i = 0; i < 80 && !targets.length; i++) {
    try { targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page'); } catch {}
    if (!targets.length) await sleep(250);
  }
  if (!targets.length) throw new Error('Chrome did not start (CHROME_BIN=' + CHROME + ')');
  ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });

  let id = 0; const pending = new Map(); const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const js = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  const waitFor = async (expr, what, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await js(expr).catch(() => false)) return true; await sleep(150); }
    throw new Error('timed out waiting for: ' + what);
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `wallet-${name}.png`), Buffer.from(r.result.data, 'base64'));
  };
  // The chat is a list of bubbles; count them so each step can wait for the bot's next reply.
  const count = () => js(`document.querySelectorAll('#chat .row.in, #chat .card').length`);
  const last = () => js(`(()=>{const n=[...document.querySelectorAll('#chat .row.in .bub, #chat .card')].pop();return n?n.innerText.replace(/\\s+/g,' ').trim():''})()`);
  /** The bot has finished replying when the chat ends in buttons: the menu, a
   *  question's answer/Cancel chips, or a request's Pay/Decline. */
  const settled = (what) => waitFor(`(()=>{const l=document.querySelector('#chat').lastElementChild;return !!l && (l.classList.contains('quick')||l.classList.contains('acts'))})()`, what, 12000);
  const type = async (t, what) => { await js(`txt.value=${JSON.stringify(t)}; fire()`); await sleep(150); await settled(what ?? 'reply to ' + t); await sleep(400); };
  const click = async (label) => {
    const done = await js(`(()=>{const b=[...document.querySelectorAll('#chat button')].reverse().find(x=>x.textContent.includes(${JSON.stringify(label)}));if(b){b.click();return true}return false})()`);
    if (!done) throw new Error('no button: ' + label);
    await sleep(150); await settled('after ' + label); await sleep(400);
  };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: PAGE });
  await waitFor(`typeof AXO_WALLET_LIVE==='object' && !!document.querySelector('.wl-row')`, 'wallet to load');

  console.log('demo mode');
  ok((await js(`modeBanner.textContent`)).startsWith('DEMO'), 'DEMO banner before sign-in');

  console.log('sign-in');
  await js(`document.querySelector('.wl-row').click()`);
  await waitFor(`[...document.querySelectorAll('#chat button')].some(b=>b.textContent.includes('Sign in to my wallet'))`, 'welcome');
  await click('Sign in to my wallet');
  await type('@amina');
  ok((await js(`txt.type`)) === 'password', 'PIN field is masked');
  await type('9999', 'wrong PIN');
  ok((await last()).includes('isn’t right'), 'wrong PIN is rejected');
  await click('Try again');
  await type('@amina');
  await type('1234', 'sign-in');
  await waitFor(`AXO_WALLET_LIVE.on`, 'signed in');
  ok((await js(`modeBanner.textContent`)).startsWith('CONNECTED'), 'CONNECTED banner after sign-in');
  ok(!(await js(`[...document.querySelectorAll('#chat .row.out')].some(r=>r.innerText.includes('1234'))`)), 'the PIN never appears in the chat');
  await shot('01-signed-in');

  const a0 = await balanceOf('@amina', '1234');
  const j0 = await balanceOf('@juma', '4321');

  console.log('send to @juma');
  await type('send 300 to @juma');
  await type('1234', 'send receipt');
  ok((await last()).includes('KES 300 sent'), 'receipt shows KES 300 sent', await last());
  ok(a0 - (await balanceOf('@amina', '1234')) === 300n, 'Amina is debited exactly 300');
  ok((await balanceOf('@juma', '4321')) - j0 === 300n, 'Juma is credited exactly 300');

  console.log('amounts');
  await type('send 12.50 to @juma');
  ok((await last()).includes('whole amount'), 'KES 12.50 is refused, not rounded');

  console.log('pay a Till');
  await click('Pay'); await click('Till'); await type('832909');
  ok((await js(`[...document.querySelectorAll('#chat .row.in .bub')].slice(-2).map(b=>b.innerText).join(' ')`)).includes('Java House'), 'shows the business name before paying');
  await type('200'); await type('1234', 'till receipt');
  ok((await last()).includes('Paid'), 'Till payment receipt');
  await shot('02-paid-till');

  console.log('a business request arrives and is paid');
  const owner = (await (await post('/auth/login', { email: 'owner@java.test', password: 'password123' })).json()).accessToken;
  const push = await post('/payment-requests', { amountMinor: '450', customerTag: '@amina', description: 'Coffee x3' }, owner);
  ok(push.status === 201, 'business sends a request to @amina');
  await waitFor(`[...document.querySelectorAll('#chat button')].some(b=>b.textContent.includes('Pay KES 450'))`, 'request to appear in the chat', 15000);
  ok(true, 'request appears in the chat by itself');
  await click('Pay KES 450'); await type('1234', 'request receipt');
  ok((await last()).includes('KES 450'), 'request paid');

  console.log('scan / paste a till code');
  const open = await (await post('/payment-requests', { amountMinor: '125', saleRef: 'W-' + Date.now() }, owner)).json();
  await click('Scan');
  await type(open.qr, 'resolve pasted code');
  await click('Pay KES 125'); await type('1234', 'pasted receipt');
  const state = await (await fetch(`${API}/payment-requests/${open.id}`, { headers: { authorization: `Bearer ${owner}` } })).json();
  ok(state.status === 'paid', 'the business sees the pasted request as paid', state.status);

  console.log('history and receive');
  await type('history');
  ok((await last()).includes('Recent activity'), 'history card');
  await type('my qr');
  ok(await js(`!![...document.querySelectorAll('#chat .card')].pop().querySelector('svg')`), 'receive shows a real QR');
  await shot('03-receive');

  console.log('totals');
  ok(a0 - (await balanceOf('@amina', '1234')) === 300n + 200n + 450n + 125n, 'Amina is debited exactly 1,075 in total');

  console.log('reload and sign-out');
  await send('Page.reload');
  await waitFor(`typeof AXO_WALLET_LIVE==='object' && AXO_WALLET_LIVE.on`, 'session to resume');
  ok(true, 'reload keeps the session');
  await js(`document.querySelector('.wl-row').click()`);
  await waitFor(`(document.querySelector('#chat')||{}).innerText?.includes('Welcome back')`, 'welcome back');
  await type('sign out', 'sign-out');
  ok((await js(`modeBanner.textContent`)).startsWith('DEMO') && !(await js(`AXO_WALLET_LIVE.on`)), 'sign-out returns to the demo');

  ok(errors.length === 0, 'no console errors', errors.join(' | '));
} catch (e) {
  failures++;
  console.log('  ✗', e.message);
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
