/* ============================================================================
   Axo Wallet — LIVE API MODE
   ----------------------------------------------------------------------------
   index.html is a chat-shaped demo with simulated money. This file connects the
   same chat to the real backend (backend/, the /customer/* routes) when a person
   signs in with their Axo tag and PIN:

     sign in   → /customer/auth/login        balance  → /customer/me
     send @tag → /customer/transfers         phone    → /customer/transfers/to-phone
     pay Till / Paybill → /customer/pay-numbers/resolve + /customer/payments/by-number
     scan / paste a code → /customer/scan    requests → /customer/payment-requests
     history → /customer/transfers           receive  → /customer/receive-qr.svg
     cash at an agent → /customer/agents/:code/withdraw   add money → /customer/cash/in

   Every debit asks for the PIN, and the server checks it again. The chat only
   ever reports what the server says happened: it never decides money moved.
   Creating a new wallet still happens over WhatsApp (REGISTER); the demo's
   sign-up here stays a demo and is labelled as one.
   ========================================================================== */
(function () {
  'use strict';

  var DEFAULT_API = 'http://localhost:4000';
  var STORE = 'axo.wallet.session';
  var API_STORE = 'axo.wallet.apiBase';

  var L = (window.AXO_WALLET_LIVE = {
    on: false, base: DEFAULT_API, token: null, refreshToken: null, me: null,
    awaiting: null, secret: false, poll: null, seenIn: null, seenReqs: {},
  });

  /* ---------------------------------------------------------------- storage */
  function store(v) { try { if (v) sessionStorage.setItem(STORE, JSON.stringify(v)); else sessionStorage.removeItem(STORE); } catch (e) {} }
  function loadStore() { try { return JSON.parse(sessionStorage.getItem(STORE) || 'null'); } catch (e) { return null; } }
  function apiBase() {
    try {
      var q = new URLSearchParams(location.search).get('api');
      if (q) { localStorage.setItem(API_STORE, q); return q; }
      return localStorage.getItem(API_STORE) || DEFAULT_API;
    } catch (e) { return DEFAULT_API; }
  }
  function persist() { store(L.on ? { base: L.base, token: L.token, refreshToken: L.refreshToken } : null); }

  /* ------------------------------------------------------------------ money */
  // Same rule as the backend: East African shillings are whole units, every
  // other currency (USD — Somalia — included) has cents.
  var ZERO_DECIMAL = { KES: 1, UGX: 1, TZS: 1, RWF: 1, SOS: 1 };
  function cur() { return (L.me && L.me.currency) || 'KES'; }
  function decimals(c) { return ZERO_DECIMAL[String(c || '').toUpperCase()] ? 0 : 2; }
  function fmtMinor(minor, c) {
    c = c || cur();
    var d = decimals(c), n;
    try { n = BigInt(minor == null ? 0 : minor); } catch (e) { return c + ' —'; }
    var neg = n < 0n; if (neg) n = -n;
    var s = n.toString().padStart(d + 1, '0');
    var whole = s.slice(0, s.length - d) || '0';
    return (neg ? '−' : '') + c + ' ' + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (d ? '.' + s.slice(s.length - d) : '');
  }
  function parseAmount(text, c) {
    var d = decimals(c || cur());
    var s = String(text || '').replace(/,/g, '').replace(/^[^\d]*/, '').trim();
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    var p = s.split('.'), frac = p[1] || '';
    if (frac.replace(/0+$/, '').length > d) return null; // never round: ask again instead
    var minor = BigInt((p[0] || '0') + (d ? (frac + '00').slice(0, d) : ''));
    return minor > 0n ? minor.toString() : null;
  }

  /* --------------------------------------------------------------- helpers */
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; });
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); crypto.getRandomValues(b);
    return Array.prototype.map.call(b, function (x) { return x.toString(16).padStart(2, '0'); }).join('');
  }
  function when(iso) {
    var d = new Date(iso), s = (Date.now() - d.getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' hr ago';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  function card(title, rows, opts) {
    opts = opts || {};
    var c = document.createElement('div'); c.className = 'card wide';
    c.innerHTML = '<div class="card-h"' + (opts.ok ? ' style="background:linear-gradient(135deg,#0e8a52,#0a5c39);color:#fff"' : '') + '>' + title + '</div><div class="card-b recpt">' +
      (opts.stamp ? '<div class="stamp">' + opts.stamp + '</div>' : '') +
      rows.map(function (r) { return '<div class="rr"><span>' + r[0] + '</span><span' + (r[2] ? ' class="big"' : '') + '>' + r[1] + '</span></div>'; }).join('') +
      (opts.extra || '') + '</div>';
    return raw(c);
  }
  async function say(html, ms) { await typing(ms || 450); inBub(html); }

  var MESSAGES = {
    invalid_credentials: 'That tag or PIN isn’t right.',
    wallet_locked: '🔒 Your wallet is locked after too many wrong PINs. Contact Axo support to unlock it.',
    no_pin_set: 'You haven’t set a PIN yet. On WhatsApp, send <b>SETPIN 1234</b> (your own 4–6 digits), then sign in here.',
    wrong_pin: 'Wrong PIN — nothing was sent.',
    network: 'I can’t reach Axo right now. Check your connection and try again.',
    recipient_not_found: 'I couldn’t find anyone with that Axo tag.',
    unknown_or_inactive_number: 'No Axo business uses that number.',
    unknown_account_line: 'That account isn’t recognised for this Paybill.',
    business_not_active: 'That business can’t take payments right now.',
    already_paid: 'That request has already been paid.',
    expired: 'That request has expired.',
    unknown_request: 'I can’t find that payment request.',
    bad_qr: 'That isn’t an Axo code.',
    ramp_unavailable: 'Adding money isn’t available in your country yet — there’s no funding partner connected.',
    bad_amount: 'That amount doesn’t look right.',
  };
  function errText(e) {
    if (e && MESSAGES[e.code]) return MESSAGES[e.code];
    if (e && e.status === 404 && e.code === 'Not Found') return 'This Axo server doesn’t support that yet. Nothing was charged.';
    // the money engine's own reasons are already plain sentences
    if (e && e.code && /\s/.test(e.code)) return esc(e.code.charAt(0).toUpperCase() + e.code.slice(1)) + '.';
    return 'Something went wrong' + (e && e.code ? ' (' + esc(e.code) + ')' : '') + '. Nothing was charged.';
  }

  /* -------------------------------------------------------------- API client */
  function ApiError(code, status) { this.code = code; this.status = status; }
  async function api(path, opts) {
    opts = opts || {};
    var h = Object.assign({}, opts.headers || {});
    if (L.token) h.authorization = 'Bearer ' + L.token;
    if (opts.body !== undefined) h['content-type'] = 'application/json';
    var res;
    try { res = await fetch(L.base + path, { method: opts.method || 'GET', headers: h, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined }); }
    catch (e) { throw new ApiError('network', 0); }
    if (res.status === 401 && L.refreshToken && !opts.retried && path.indexOf('/customer/auth/') !== 0) {
      if (await refresh()) return api(path, Object.assign({}, opts, { retried: true }));
      await signOut('Your session ended — please sign in again.');
      throw new ApiError('unauthorized', 401);
    }
    var text = await res.text(), data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) throw new ApiError((data && data.error) || 'http_' + res.status, res.status);
    return opts.raw ? text : data;
  }
  async function refresh() {
    try {
      var r = await fetch(L.base + '/customer/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: L.refreshToken }) });
      if (!r.ok) return false;
      L.token = (await r.json()).accessToken; persist(); return true;
    } catch (e) { return false; }
  }

  /* ------------------------------------------------- conversation primitives */
  // Masked entry for PINs: the field shows dots, and the reply is never echoed.
  function pinMode(on) {
    L.secret = on;
    txt.type = on ? 'password' : 'text';
    txt.inputMode = on ? 'numeric' : 'text';
    txt.placeholder = on ? 'Enter your PIN' : 'Tell Axo what you need…';
  }

  /** Ask a question and resolve with the typed answer, or null if cancelled. */
  function ask(html, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      (async function () {
        await say(html, 350);
        var chips = (opts.chips || []).map(function (c) { return { g: c.g, label: c.label, fn: function () { L.awaiting = null; pinMode(false); outBub(esc(c.label)); resolve(c.value); } }; });
        chips.push({ g: '✕', label: 'Cancel', dim: true, fn: function () { L.awaiting = null; pinMode(false); outBub('Cancel'); resolve(null); } });
        var acts = actions(chips, { center: true });
        L.awaiting = function (t) { acts.remove(); resolve(t); };
        pinMode(!!opts.secret);
        txt.focus();
      })();
    });
  }

  async function askAmount(prompt) {
    for (;;) {
      var a = await ask(prompt);
      if (a === null) return null;
      var m = parseAmount(a);
      if (m) return m;
      prompt = decimals(cur()) ? 'Please enter an amount like <b>12.50</b>.' : 'Please enter a whole amount in ' + esc(cur()) + ', like <b>500</b> — no cents.';
    }
  }

  async function askPin(summary) {
    for (;;) {
      var p = await ask(summary + '<br><br>🔐 Enter your <b>PIN</b> to confirm.', { secret: true });
      if (p === null) return null;
      p = p.replace(/\D/g, '');
      if (/^\d{4,6}$/.test(p)) return p;
      summary = 'Your PIN is 4–6 digits.';
    }
  }

  async function cancelled() { await say('Cancelled — nothing was sent. 👍'); menu(); }

  /* ------------------------------------------------------------- input hook */
  var demoHandle = window.handleText;
  window.handleText = function (v) {
    var t = String(v || '').trim();
    if (!t) return;
    if (L.awaiting) {
      var h = L.awaiting; L.awaiting = null;
      outBub(L.secret ? '••••' : esc(t));
      pinMode(false);
      h(t);
      return;
    }
    if (!L.on) return demoHandle(v);
    outBub(esc(t));
    freeText(t);
  };

  /* ------------------------------------------------------------------ boot */
  var demoBoot = window.boot;
  window.boot = async function () {
    reset();
    L.awaiting = null; pinMode(false);
    sys('Today'); sys('🔒 Messages are end-to-end encrypted.');
    if (L.on) { await say('Welcome back, <b>' + esc(L.me.displayName.split(' ')[0]) + '</b> 👋'); await showBalance(); return menu(); }
    await wait(300);
    await say('Welcome to <b>Axo</b> 👋<br>Money is a conversation.');
    actions([
      { g: '🔑', label: 'Sign in to my wallet', fn: function () { outBub('Sign in to my wallet'); signIn(); } },
      { g: '🧪', label: 'Try the demo (sample money)', dim: true, fn: function () { demoBoot(); } },
    ]);
    S.step = 'onboard';
  };

  async function signIn() {
    L.base = apiBase();
    var tag = await ask('What’s your <b>Axo tag</b>? (like <b>@amina</b>)<br><span style="font-size:11.5px;color:var(--txt-dim)">Server: ' + esc(L.base) + '</span>',
      { chips: [{ g: '⚙️', label: 'Change server', value: '__server' }] });
    if (tag === null) return window.boot();
    if (tag === '__server') {
      var b = await ask('Which Axo server? (e.g. http://localhost:4000)');
      if (b) { L.base = b.trim().replace(/\/+$/, ''); try { localStorage.setItem(API_STORE, L.base); } catch (e) {} }
      return signIn();
    }
    var pin = await askPin('Hi ' + esc(tag.trim()) + '.');
    if (pin === null) return window.boot();
    try {
      var r = await api('/customer/auth/login', { method: 'POST', body: { axoTag: tag.trim(), pin: pin } });
      L.token = r.accessToken; L.refreshToken = r.refreshToken;
      await start();
      await say('✅ You’re in, <b>' + esc(L.me.displayName.split(' ')[0]) + '</b>.');
      await showBalance();
      menu(true);
    } catch (e) {
      await say(errText(e));
      actions([{ g: '🔁', label: 'Try again', fn: function () { outBub('Try again'); signIn(); } }, { g: '🧪', label: 'Try the demo', dim: true, fn: function () { demoBoot(); } }], { center: true });
    }
  }

  async function start() {
    L.me = await api('/customer/me');
    L.on = true; S.verified = true;
    persist(); banner();
    await baseline();
    if (L.poll) clearInterval(L.poll);
    L.poll = setInterval(watch, 5000);
  }

  async function signOut(msg) {
    if (L.poll) clearInterval(L.poll);
    L.on = false; L.token = null; L.refreshToken = null; L.me = null; L.awaiting = null;
    pinMode(false); persist(); banner();
    if (msg) await say(msg);
    window.boot();
  }

  function banner() {
    var el = document.getElementById('modeBanner'); if (!el) return;
    if (!L.on) { el.className = 'mode-banner demo'; el.textContent = 'DEMO — sample money, not connected to Axo'; }
    else { el.className = 'mode-banner live'; el.textContent = 'CONNECTED · ' + L.base.replace(/^https?:\/\//, '') + ' · ' + (L.me ? L.me.currency : ''); }
  }

  /* ------------------------------------------------------------------- menu */
  var ACTIONS = [
    { g: '💸', label: 'Send', fn: function () { outBub('Send'); sendFlow(); } },
    { g: '🏪', label: 'Pay', fn: function () { outBub('Pay'); payFlow(); } },
    { g: '📷', label: 'Scan', fn: function () { outBub('Scan'); scanFlow(); } },
    { g: '💰', label: 'Balance', fn: async function () { outBub('Balance'); await showBalance(); menu(); } },
  ];
  var MORE = [
    { g: '📥', label: 'Requests', fn: function () { outBub('Requests'); requestsFlow(); } },
    { g: '🧾', label: 'History', fn: function () { outBub('History'); historyFlow(); } },
    { g: '📩', label: 'Receive', fn: function () { outBub('Receive'); receiveFlow(); } },
    { g: '📱', label: 'Send to a phone', fn: function () { outBub('Send to a phone'); phoneFlow(); } },
    { g: '🏧', label: 'Cash at an agent', fn: function () { outBub('Cash at an agent'); agentFlow(); } },
    { g: '➕', label: 'Add money', fn: function () { outBub('Add money'); addMoneyFlow(); } },
    { g: '🚪', label: 'Sign out', fn: function () { outBub('Sign out'); signOut('Signed out. 👋'); } },
  ];
  async function menu(first) {
    S.step = 'menu';
    await typing(first ? 450 : 200);
    if (first) inBub('Just tell me what you need — like <b>send 500 to @juma</b> or <b>pay till 832909 200</b>.');
    var w = document.createElement('div'); w.className = 'quick';
    ACTIONS.concat([{ g: '⋯', label: 'More', more: true }]).forEach(function (a) {
      var b = document.createElement('button'); b.className = 'qchip' + (a.more ? ' more' : '');
      b.innerHTML = '<span class="qg">' + a.g + '</span>' + a.label;
      b.onclick = function () { w.remove(); if (a.more) quickChips(MORE.concat(ACTIONS)); else a.fn(); };
      w.appendChild(b);
    });
    raw(w);
  }

  /* ---------------------------------------------------------------- balance */
  async function showBalance() {
    try {
      L.me = await api('/customer/me');
      var w = L.me.wallet || {};
      card('💰 Your Axo wallet', [
        ['Available', '<b style="color:var(--axo)">' + fmtMinor(w.spendableMinor) + '</b>', true],
        ['Being sent (reserved)', fmtMinor(w.reservedMinor)],
        ['Axo tag', esc(L.me.axoTag)],
      ]);
    } catch (e) { await say(errText(e)); }
  }

  /* ------------------------------------------------------------------- send */
  async function sendFlow(pre) {
    pre = pre || {};
    var tag = pre.tag || await ask('Who are you sending to? Type their <b>Axo tag</b>, like <b>@juma</b>.');
    if (tag === null) return cancelled();
    tag = '@' + tag.trim().replace(/^@/, '').toLowerCase();
    var amount = pre.amount || await askAmount('How much to <b>' + esc(tag) + '</b>? (' + esc(cur()) + ')');
    if (amount === null) return cancelled();
    var pin = await askPin('Send <b>' + fmtMinor(amount) + '</b> to <b>' + esc(tag) + '</b>. Axo-to-Axo is free.');
    if (pin === null) return cancelled();
    try {
      var r = await api('/customer/transfers', { method: 'POST', headers: { 'idempotency-key': uuid() }, body: { toTag: tag, amountMinor: amount, pin: pin, note: pre.note } });
      card('🧾 Sent', [['To', esc(r.toName) + ' · ' + esc(r.to)], ['Amount', fmtMinor(r.amountMinor, r.currency), true], ['Fee', fmtMinor(r.feeMinor, r.currency)], ['New balance', fmtMinor(r.balanceMinor, r.currency)], ['Reference', esc(r.transferId.slice(0, 8).toUpperCase())]],
        { ok: true, stamp: '✅ ' + fmtMinor(r.amountMinor, r.currency) + ' sent' });
      actions([{ g: '↩️', label: 'Undo (within 10 min)', dim: true, fn: function () { outBub('Undo'); undoFlow(r.transferId); } }], { center: true });
    } catch (e) { await say(errText(e)); }
    menu();
  }

  async function undoFlow(id) {
    var pin = await askPin('Take this payment back?');
    if (pin === null) return cancelled();
    try {
      await api('/customer/transfers/' + encodeURIComponent(id) + '/reverse', { method: 'POST', body: { pin: pin } });
      await say('↩️ Reversed — the money is back in your wallet.');
      await showBalance();
    } catch (e) { await say(errText(e)); }
    menu();
  }

  /* -------------------------------------------------------------------- pay */
  async function payFlow(pre) {
    pre = pre || {};
    var kind = pre.kind || await ask('Pay a <b>Till</b> (shops) or a <b>Paybill</b> (bills, rent, school)?', { chips: [{ g: '🛒', label: 'Till', value: 'till' }, { g: '🧾', label: 'Paybill', value: 'paybill' }] });
    if (kind === null) return cancelled();
    kind = /bill/i.test(kind) ? 'paybill' : 'till';
    var number = pre.number || await ask('What’s the ' + (kind === 'till' ? 'Till' : 'Paybill') + ' number?');
    if (number === null) return cancelled();
    number = number.replace(/\D/g, '');
    var account = pre.account;
    if (kind === 'paybill' && !account) { account = await ask('And the <b>account</b> number or reference?'); if (account === null) return cancelled(); }
    var biz;
    try {
      biz = await api('/customer/pay-numbers/resolve', { method: 'POST', body: { kind: kind, number: number, account: account } });
    } catch (e) { await say(errText(e)); return menu(); }
    await say('🏪 That’s <b>' + esc(biz.merchantName) + '</b>' + (biz.label ? ' — ' + esc(biz.label) : '') + '.');
    var amount = pre.amount || await askAmount('How much? (' + esc(biz.currency) + ')');
    if (amount === null) return cancelled();
    var pin = await askPin('Pay <b>' + fmtMinor(amount, biz.currency) + '</b> to <b>' + esc(biz.merchantName) + '</b>' + (account ? ' (a/c ' + esc(account) + ')' : '') + '.');
    if (pin === null) return cancelled();
    try {
      var r = await api('/customer/payments/by-number', { method: 'POST', headers: { 'idempotency-key': uuid() }, body: { kind: kind, number: number, account: account, amountMinor: amount, currency: biz.currency, pin: pin } });
      card('🧾 Payment receipt', [['Paid to', esc(r.merchantName)], [kind === 'till' ? 'Till' : 'Paybill', esc(number) + (account ? ' · a/c ' + esc(account) : '')], ['Amount', fmtMinor(r.amountMinor, r.currency), true], ['New balance', fmtMinor(r.balanceMinor, r.currency)], ['Reference', esc(r.transferId.slice(0, 8).toUpperCase())]],
        { ok: true, stamp: '✅ Paid' });
    } catch (e) { await say(errText(e)); }
    menu();
  }

  /* ---------------------------------------------------- payment requests */
  async function requestsFlow() {
    try {
      var rows = await api('/customer/payment-requests');
      if (!rows.length) { await say('No businesses are waiting on you right now. 👍'); return menu(); }
      await say('These businesses have asked you to pay:');
      for (var i = 0; i < rows.length; i++) offerRequest(rows[i]);
    } catch (e) { await say(errText(e)); menu(); }
  }

  function offerRequest(r) {
    L.seenReqs[r.ref] = true;
    card('💳 ' + esc(r.merchantName) + ' is requesting', [['Amount', fmtMinor(r.amountMinor, r.currency), true]].concat(
      r.description ? [['For', esc(r.description)]] : [], r.saleRef ? [['Sale', esc(r.saleRef)]] : [],
      [['Expires', new Date(r.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })]]));
    actions([
      { g: '✅', label: 'Pay ' + fmtMinor(r.amountMinor, r.currency), fn: function () { outBub('Pay'); payRequest(r); } },
      { g: '✕', label: 'Decline', dim: true, fn: function () { outBub('Decline'); declineRequest(r); } },
    ], { center: true });
  }

  async function payRequest(r) {
    var pin = await askPin('Pay <b>' + fmtMinor(r.amountMinor, r.currency) + '</b> to <b>' + esc(r.merchantName) + '</b>.');
    if (pin === null) return cancelled();
    try {
      var p = await api('/customer/payment-requests/' + encodeURIComponent(r.ref) + '/pay', { method: 'POST', body: { pin: pin } });
      card('🧾 Payment receipt', [['Paid to', esc(p.merchantName)], ['Amount', fmtMinor(p.amountMinor, p.currency), true]].concat(r.saleRef ? [['Sale', esc(r.saleRef)]] : [],
        [['New balance', fmtMinor(p.balanceMinor, p.currency)], ['Reference', esc(p.transferId.slice(0, 8).toUpperCase())]]), { ok: true, stamp: '✅ Paid' });
    } catch (e) { await say(errText(e)); }
    menu();
  }

  async function declineRequest(r) {
    try { await api('/customer/payment-requests/' + encodeURIComponent(r.ref) + '/decline', { method: 'POST', body: {} }); await say('Declined — nothing was charged.'); }
    catch (e) { await say(errText(e)); }
    menu();
  }

  /* ------------------------------------------------------------------- scan */
  async function scanFlow() {
    var canCamera = 'BarcodeDetector' in window && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
    var code = null, why = canCamera ? '' : 'This browser can’t scan with the camera. ';
    if (canCamera) {
      code = await cameraScan();
      if (code === undefined) return cancelled();
      if (code === null) why = 'I can’t use the camera here. ';
    }
    if (!code) {
      code = await ask(why + 'Paste the Axo code or payment link here (it starts with <b>axo://pay</b>).');
      if (code === null) return cancelled();
    }
    resolveCode(code.trim());
  }

  /** Camera + the browser's built-in QR reader. Resolves with the text, '' to fall back to pasting, or undefined if cancelled. */
  function cameraScan() {
    return new Promise(async function (resolve) {
      var stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); }
      catch (e) { resolve(null); return; } // no camera, or permission refused
      var c = document.createElement('div'); c.className = 'card wide';
      c.innerHTML = '<div class="card-h">📷 Point at the Axo QR</div><div class="card-b"><video playsinline muted style="width:100%;border-radius:10px;background:#000"></video></div>';
      raw(c);
      var video = c.querySelector('video'); video.srcObject = stream; await video.play().catch(function () {});
      var detector = new BarcodeDetector({ formats: ['qr_code'] });
      var done = false;
      function finish(v) { if (done) return; done = true; stream.getTracks().forEach(function (t) { t.stop(); }); acts.remove(); c.remove(); resolve(v); }
      var acts = actions([{ g: '⌨️', label: 'Paste a code instead', dim: true, fn: function () { finish(''); } }, { g: '✕', label: 'Cancel', dim: true, fn: function () { finish(undefined); } }], { center: true });
      (async function loop() {
        while (!done) {
          try { var found = await detector.detect(video); if (found.length) { finish(found[0].rawValue); return; } } catch (e) {}
          await wait(250);
        }
      })();
    });
  }

  async function resolveCode(code) {
    try {
      var r = await api('/customer/scan', { method: 'POST', body: { qr: code } });
      if (r.kind === 'request') {
        if (r.request.status !== 'pending') { await say('That request is <b>' + esc(r.request.status) + '</b> — nothing to pay.'); return menu(); }
        return offerRequest(r.request);
      }
      if (r.kind === 'till' || r.kind === 'paybill') {
        return payFlow({ kind: r.kind, number: r.number, account: r.account || undefined, amount: r.amountMinor || undefined });
      }
      if (r.kind === 'tag') return sendFlow({ tag: r.tag });
    } catch (e) { await say(errText(e)); }
    menu();
  }

  /* ---------------------------------------------------------------- history */
  async function historyFlow() {
    try {
      var rows = await api('/customer/transfers');
      if (!rows.length) { await say('No transactions yet.'); return menu(); }
      // Own rows rather than card(): a long note must wrap, never push the amount off.
      card('🧾 Recent activity', [], { extra: rows.slice(0, 10).map(function (t) {
        var amt = (t.direction === 'in' ? '+' : '−') + fmtMinor(t.amountMinor, t.currency);
        var what = t.note ? esc(t.note) : (t.direction === 'in' ? 'Received' : 'Sent');
        return '<div class="rr"><span style="flex:1 1 auto;min-width:0;overflow-wrap:anywhere">' + what +
          '<br><small style="color:var(--txt-dim)">' + when(t.createdAt) + (t.status !== 'completed' ? ' · ' + esc(t.status) : '') + '</small></span>' +
          '<span style="flex:none;white-space:nowrap;color:' + (t.direction === 'in' ? 'var(--axo)' : 'inherit') + '">' + amt + '</span></div>';
      }).join('') });
    } catch (e) { await say(errText(e)); }
    menu();
  }

  /* ---------------------------------------------------------------- receive */
  async function receiveFlow() {
    try {
      var svg = await api('/customer/receive-qr.svg', { raw: true });
      card('📩 Get paid', [['Your Axo tag', '<b>' + esc(L.me.axoTag) + '</b>', true]], {
        extra: '<div style="background:#fff;border-radius:12px;padding:8px;max-width:220px;margin:10px auto 4px">' + svg + '</div>' +
          '<div style="font-size:12px;color:var(--txt-dim);text-align:center">Anyone on Axo can scan this or send to ' + esc(L.me.axoTag) + '. They choose the amount and confirm with their PIN.</div>',
      });
    } catch (e) { await say(errText(e)); }
    menu();
  }

  /* -------------------------------------------------------- send to a phone */
  async function phoneFlow() {
    var phone = await ask('What’s their phone number? (with country code, like <b>+254 712 345 678</b>) — they don’t need Axo yet.');
    if (phone === null) return cancelled();
    var amount = await askAmount('How much? (' + esc(cur()) + ')');
    if (amount === null) return cancelled();
    var pin = await askPin('Send <b>' + fmtMinor(amount) + '</b> to <b>' + esc(phone) + '</b>. They’ll get a WhatsApp message to claim it.');
    if (pin === null) return cancelled();
    try {
      var r = await api('/customer/transfers/to-phone', { method: 'POST', headers: { 'idempotency-key': uuid() }, body: { recipientPhone: phone, amountMinor: amount, pin: pin } });
      card('📤 On its way', [['To', esc(phone)], ['Amount', fmtMinor(r.amountMinor, r.currency), true], ['Claim code', '<b>' + esc(r.code) + '</b>'], ['Status', 'Reserved until they claim it']], { ok: true });
      actions([{ g: '↩️', label: 'Recall it', dim: true, fn: async function () {
        outBub('Recall it');
        try { var x = await api('/customer/claims/' + encodeURIComponent(r.code) + '/recall', { method: 'POST', body: {} }); await say(x.ok ? '↩️ Recalled — the money is back in your wallet.' : 'It can’t be recalled now (' + esc(x.reason) + ').'); }
        catch (e) { await say(errText(e)); }
        menu();
      } }], { center: true });
    } catch (e) { await say(errText(e)); }
    menu();
  }

  /* --------------------------------------------------------- cash at agent */
  async function agentFlow(pre) {
    pre = pre || {};
    var code = pre.agent || await ask('Which agent? Type their <b>agent code</b> (it’s on their sign, like <b>AMRAN</b>).');
    if (code === null) return cancelled();
    code = code.trim().toUpperCase();
    var amount = pre.amount || await askAmount('How much cash? (' + esc(cur()) + ')');
    if (amount === null) return cancelled();
    var pin = await askPin('Withdraw <b>' + fmtMinor(amount) + '</b> in cash at agent <b>' + esc(code) + '</b>. Only confirm when you’re with the agent.');
    if (pin === null) return cancelled();
    try {
      await api('/customer/agents/' + encodeURIComponent(code) + '/withdraw', { method: 'POST', headers: { 'idempotency-key': uuid() }, body: { amountMinor: amount, pin: pin } });
      card('🏧 Cash withdrawal', [['Agent', esc(code)], ['Amount', fmtMinor(amount), true], ['Next', 'Collect your cash from the agent']], { ok: true, stamp: '✅ Approved' });
      await showBalance();
    } catch (e) { await say(e && e.status === 409 && /not found|No .*found/i.test(e.code) ? 'I can’t find agent ' + esc(code) + '.' : errText(e)); }
    menu();
  }

  /* -------------------------------------------------------------- add money */
  async function addMoneyFlow() {
    var amount = await askAmount('How much do you want to add? (' + esc(cur()) + ')');
    if (amount === null) return cancelled();
    var source = await ask('From which account or phone number?');
    if (source === null) return cancelled();
    try {
      var r = await api('/customer/cash/in', { method: 'POST', headers: { 'idempotency-key': uuid() }, body: { amountMinor: amount, source: source } });
      card('➕ Top-up started', [['Amount', fmtMinor(amount), true], ['From', esc(source)], ['Status', 'Waiting for the provider to confirm']], {});
      await say('Your wallet is credited the moment the provider confirms the money arrived — not before. I’ll tell you here.');
    } catch (e) { await say(errText(e)); }
    menu();
  }

  /* -------------------------------------------------------- free-text intents */
  async function freeText(t) {
    var low = t.toLowerCase().replace(/,/g, '');
    var m;
    if (/^axo:\/\/pay\?|^pr_[a-z0-9_-]{16,}$/i.test(t)) return resolveCode(/^pr_/i.test(t) ? 'axo://pay?k=request&r=' + t : t);
    if ((m = low.match(/(?:send|pay|give|transfer)\s+([\d.]+)\s+(?:to\s+)?@([a-z0-9_.]+)/)) || (m = low.match(/(?:send|pay|give|transfer)\s+@([a-z0-9_.]+)\s+([\d.]+)/))) {
      var tag = /^\d/.test(m[1]) ? m[2] : m[1], amt = parseAmount(/^\d/.test(m[1]) ? m[1] : m[2]);
      if (!amt) { await say(decimals(cur()) ? 'Please use an amount like 12.50.' : 'Please use a whole amount — ' + esc(cur()) + ' has no cents.'); return menu(); }
      return sendFlow({ tag: '@' + tag, amount: amt });
    }
    if ((m = low.match(/pay\s*bill\s+(\d+)\s+(?:a\/?c\s+|acct\s+|account\s+)?(\S+)\s+([\d.]+)/))) return payFlow({ kind: 'paybill', number: m[1], account: m[2].toUpperCase(), amount: parseAmount(m[3]) || undefined });
    if ((m = low.match(/(?:pay\s+)?(?:till|buy\s*goods)\s+(\d+)\s+([\d.]+)/))) return payFlow({ kind: 'till', number: m[1], amount: parseAmount(m[2]) || undefined });
    if ((m = low.match(/withdraw\s+([\d.]+)(?:\s+(?:at|from)\s+([a-z0-9]+))?/))) return agentFlow({ amount: parseAmount(m[1]) || undefined, agent: m[2] });
    if (/balance|how much do i have|my money/.test(low)) { await showBalance(); return menu(); }
    if (/history|statement|recent|transactions/.test(low)) return historyFlow();
    if (/request|asking me|waiting/.test(low)) return requestsFlow();
    if (/receive|get paid|my qr|my tag/.test(low)) return receiveFlow();
    if (/scan|qr/.test(low)) return scanFlow();
    if (/till|paybill|pay /.test(low)) return payFlow();
    if (/send|transfer/.test(low)) return sendFlow();
    if (/withdraw|cash/.test(low)) return agentFlow();
    if (/add money|top ?up|deposit/.test(low)) return addMoneyFlow();
    if (/sign ?out|log ?out/.test(low)) return signOut('Signed out. 👋');
    await say('I can help with that — try <b>send 500 to @juma</b>, <b>pay till 832909 200</b>, <b>balance</b> or <b>history</b>.');
    menu();
  }

  /* ------------------------------------------ incoming money & requests */
  async function baseline() {
    try {
      var rows = await api('/customer/transfers');
      L.seenIn = rows.length ? rows[0].createdAt : new Date(0).toISOString();
      (await api('/customer/payment-requests')).forEach(function (r) { L.seenReqs[r.ref] = true; });
    } catch (e) { L.seenIn = new Date(0).toISOString(); }
  }

  async function watch() {
    if (!L.on || L.awaiting) return; // never interrupt a question being answered
    try {
      var rows = await api('/customer/transfers');
      var fresh = rows.filter(function (t) { return t.createdAt > L.seenIn; });
      if (fresh.length) L.seenIn = fresh[0].createdAt;
      for (var i = fresh.length - 1; i >= 0; i--) {
        var t = fresh[i];
        if (t.direction === 'in' && t.status === 'completed') {
          await say('🔔 <b>Money received!</b>');
          card('🧾 Payment received', [['Amount', '<span style="color:var(--axo)">+' + fmtMinor(t.amountMinor, t.currency) + '</span>', true]].concat(t.note ? [['Note', esc(t.note)]] : [], [['Time', when(t.createdAt)]]), { ok: true });
        }
      }
      var reqs = await api('/customer/payment-requests');
      for (var j = 0; j < reqs.length; j++) {
        if (!L.seenReqs[reqs[j].ref]) { await say('🔔 <b>' + esc(reqs[j].merchantName) + '</b> sent you a payment request.'); offerRequest(reqs[j]); }
      }
    } catch (e) { /* transient; next tick retries */ }
  }

  /* ---------------------------------------------------------- resume session */
  var saved = loadStore();
  if (saved && saved.token) {
    L.base = saved.base; L.token = saved.token; L.refreshToken = saved.refreshToken;
    start().catch(function () { L.on = false; L.token = null; persist(); banner(); });
  }
  banner();
})();
