// dev-serve.ts — local two-player harness for built games. No token needed.
//
//   bun scripts/dev-serve.ts --html dist/index.html [--port 5199] [--game-id <published id>]
//
// Modes:
//   MOCK (default)  — /dev shows two iframes; the parent page runs a local sim
//                     with the same ordering semantics as the platform
//                     (ordered log + KV). Fast gameplay iteration, offline.
//   ONLINE          — pass --game-id of a PUBLISHED game: the harness signs two
//                     guest bootstraps against the real platform and the two
//                     iframes join a real server_sim room (real relay, real
//                     ordering, real latency).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args: Record<string, string> = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] ?? ''
const htmlPath = resolve(args.html || 'dist/index.html')
const port = Number(args.port) || 5199
const gameId = args['game-id'] || ''

const MOCK_PARENT = `<!DOCTYPE html><html><head><title>sharky dev — mock room</title>
<style>html,body{margin:0;height:100%;background:#020617}
.wrap{display:flex;height:100%;gap:2px}iframe{flex:1;border:0;background:#0f172a}
#bar{position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:9;color:#e2e8f0;
font:12px ui-monospace;background:#1e293b;padding:4px 14px;border-radius:0 0 10px 10px}</style></head>
<body><div id="bar">MOCK room · local sim ordering · P1 (host) | P2</div>
<div class="wrap"><iframe id="a" src="/game.html?p=1"></iframe><iframe id="b" src="/game.html?p=2"></iframe></div>
<script>
// Local sim: same semantics as the platform shim (ordered log + KV + phases).
var state = { players: {}, seq: 0, log: [], kv: {}, kvCount: 0, clock: 0, _phase: 'lobby' };
var frames = [document.getElementById('a'), document.getElementById('b')];
var uids = ['local-p1', 'local-p2'];
function onAction(action, uid) {
  if (action.type === 'START') { state._phase = 'playing'; return; }
  if (action.type === 'OP') { state.seq++; state.log.push({ s: state.seq, u: uid, o: action.op }); if (state.log.length > 96) state.log.splice(0, state.log.length - 96); }
  if (action.type === 'SETKV') { state.kv[String(action.k).slice(0,64)] = action.v; }
}
window.addEventListener('message', function (ev) {
  if (!ev.data || ev.data.ns !== 'sharky-local-bus') return;
  var idx = frames.findIndex(function (f) { return f.contentWindow === ev.source; });
  state.players[uids[idx] || 'p'] = { name: 'P' + (idx + 1) };
  onAction(ev.data.action || {}, uids[idx] || 'p');
});
setInterval(function () {
  var snapshot = JSON.parse(JSON.stringify(state));
  frames.forEach(function (f) { try { f.contentWindow.postMessage({ ns: 'sharky-local-bus', state: snapshot }, '*'); } catch (e) {} });
  state.clock += 0.15;
}, 150);
// live instrument-state banner: in a hidden tab the browser freezes rAF and
// throttles timers (including this 150ms pump) — show it, don't make anyone
// deduce it from a dead-looking game.
var bar = document.getElementById('bar'), barText = bar.textContent;
function vis() {
  bar.textContent = document.hidden ? barText + ' · ⚠ TAB HIDDEN — rAF frozen, timers throttled' : barText;
  bar.style.background = document.hidden ? '#7f1d1d' : '#1e293b';
}
document.addEventListener('visibilitychange', vis); vis();
// standard probe for eval-driven checks — one call instead of a hand-written
// cross-iframe IIFE per question.
window.__MOCK_ROOM__ = {
  snapshot: function () {
    var out = { visible: !document.hidden, phase: state._phase, seq: state.seq,
                players: Object.keys(state.players).length, frames: [] };
    frames.forEach(function (f, i) {
      var o = { id: i === 0 ? 'a' : 'b' };
      try {
        var w = f.contentWindow;
        o.errors = (w.__ERRS__ || []).slice(-5);
        o.focus = (w.__PLAYTEST__ && typeof w.__PLAYTEST__.focusScreenPos === 'function') ? w.__PLAYTEST__.focusScreenPos() : null;
      } catch (e) { o.err = String(e).slice(0, 80); }
      out.frames.push(o);
    });
    return out;
  },
};
</script></body></html>`

// Injected before the game HTML in mock mode: local transport + fake identity.
const MOCK_SHIM = `<script>
(function () {
  var q = new URLSearchParams(location.search);
  var p = q.get('p') === '2' ? 2 : 1;
  // per-frame error ledger, read by the parent's __MOCK_ROOM__.snapshot()
  window.__ERRS__ = [];
  window.addEventListener('error', function (e) { window.__ERRS__.push(String(e.message || e).slice(0, 200)); });
  window.addEventListener('unhandledrejection', function (e) { window.__ERRS__.push('rejection: ' + String(e.reason).slice(0, 200)); });
  window.__SHARKY_LOCAL_BUS__ = {
    send: function (action) { parent.postMessage({ ns: 'sharky-local-bus', action: action }, '*'); return true; },
    onState: function (cb) { window.addEventListener('message', function (ev) {
      if (ev.data && ev.data.ns === 'sharky-local-bus' && ev.data.state) cb(ev.data.state); }); },
    // identity lives here, NOT on __DELTA_BRIDGE__: the real bridge.js loads
    // after this shim and rebuilds the bridge global (standalone-defaulting
    // everyone to host) — sharky-net prefers this when a mock is active.
    identity: function () { return { user_id: 'local-p' + p, isHost: p === 1, room_id: 'mock-room' }; },
  };
  window.__DELTA_BRIDGE__ = {
    getRoomInfo: function () { return { user_id: 'local-p' + p, room_id: 'mock-room', role: p === 1 ? 'host' : 'client', sync_mode: 'server_sim' }; },
    isHost: function () { return p === 1; },
    sendAction: function (a) { return window.__SHARKY_LOCAL_BUS__.send(a); },
  };
})();
</script>`

const ONLINE_PARENT = (bsName: string) => `<!DOCTYPE html><html><head><title>sharky dev — online</title>
<style>html,body{margin:0;height:100%}iframe{width:100%;height:100%;border:0}</style></head>
<body><iframe id="g" src="/game.html"></iframe>
<script>
fetch('/${bsName}').then(r => r.json()).then(function (j) {
  var bootstrap = j.data || j;
  var f = document.getElementById('g');
  setTimeout(function () {
    f.contentWindow.postMessage({ ns: 'delta-bridge', action: 'game:network-bootstrap', payload: bootstrap, timestamp: Date.now() }, '*');
  }, 400);
});
</script></body></html>`

let bootstraps: Record<string, string> = {}
if (gameId) {
  console.log('[online] signing two guest bootstraps for', gameId)
  const inst = crypto.randomUUID()
  for (const side of ['a', 'b']) {
    const resp = await fetch(`https://api.sharky.gg/api/v1/games/${gameId}/bootstrap-guest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ guest_id: crypto.randomUUID(), display_name: 'Dev-' + side.toUpperCase(), client: {}, instance_id: inst }),
    })
    const body = await resp.text()
    const parsed = JSON.parse(body)
    if (parsed.error_code) throw new Error('bootstrap-guest failed: ' + body.slice(0, 200))
    bootstraps['bs-' + side + '.json'] = body
  }
}

readFileSync(htmlPath, 'utf8') // fail fast on a bad --html path (requests re-read the file live)

const serveOpts = {
  hostname: '127.0.0.1',
  fetch(req: Request) {
    const url = new URL(req.url)
    const p = url.pathname
    if (p === '/' || p === '/dev') {
      if (!gameId) return new Response(MOCK_PARENT, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      return new Response(
        `<!DOCTYPE html><html><head><style>html,body{margin:0;height:100%}.wrap{display:flex;height:100%;gap:2px}iframe{flex:1;border:0}</style></head><body><div class="wrap"><iframe src="/online-a"></iframe><iframe src="/online-b"></iframe></div></body></html>`,
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      )
    }
    if (p === '/online-a') return new Response(ONLINE_PARENT('bs-a.json'), { headers: { 'content-type': 'text/html; charset=utf-8' } })
    if (p === '/online-b') return new Response(ONLINE_PARENT('bs-b.json'), { headers: { 'content-type': 'text/html; charset=utf-8' } })
    if (p === '/game.html') {
      // HOT: re-read the file on every request — after a rebuild, just
      // reload the page; no server restart. A read can race build's write,
      // so tell the client to retry instead of serving a torn file.
      let raw: string
      try { raw = readFileSync(htmlPath, 'utf8') } catch { return new Response('rebuilding — reload in a moment', { status: 503 }) }
      const body = gameId ? raw : raw.replace(/<body[^>]*>/i, (m) => m + MOCK_SHIM)
      return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
    }
    if (bootstraps[p.slice(1)]) return new Response(bootstraps[p.slice(1)], { headers: { 'content-type': 'application/json' } })
    return new Response('not found', { status: 404 })
  },
}

// If the requested port is taken (a stale server from an earlier session,
// another game), walk to the next free one — the printed URL is the truth.
let chosenPort = port
let started = false
for (let i = 0; i < 20; i++) {
  chosenPort = port + i
  try {
    Bun.serve({ ...serveOpts, port: chosenPort })
    started = true
    break
  } catch (e) {
    const inUse = (e as any)?.code === 'EADDRINUSE' || /EADDRINUSE|in use/i.test(String(e))
    if (!inUse) throw e
  }
}
if (!started) throw new Error(`[dev-serve] ports ${port}-${port + 19} are all busy`)
if (chosenPort !== port) console.log(`[dev-serve] port ${port} busy → using ${chosenPort}`)
// Snippet port: hashed from the html's absolute path (stable per project,
// distinct across projects/chats) and never equal to THIS instance's port —
// the Claude Preview panel only attaches to servers it spawned itself, so
// the snippet must point the panel at a port this process isn't holding.
let snippetPort = 5200 + (Array.from(htmlPath).reduce((h, c) => ((h * 31 + c.charCodeAt(0)) >>> 0), 0) % 200)
if (snippetPort === chosenPort) snippetPort = 5200 + ((snippetPort - 5200 + 7) % 200)

console.log(`[dev-serve] http://127.0.0.1:${chosenPort}/ — ${gameId ? 'ONLINE room (real relay+sim)' : 'MOCK room (offline local sim)'} (/ and /dev serve the same room — a fresh preview lands inside it, no navigation needed)`)
console.log(`[dev-serve] pid ${process.pid} — stop: kill ${process.pid}`)
console.log(`[dev-serve] hot: the --html file is re-read on every request — rebuild, then just reload the page (no restart needed)`)
console.log(`[dev-serve] live-play it (author-time eyes): open the room in a browser; if wiring the Claude Preview panel, it spawns its OWN instance from this snippet (this process stays separate):`)
console.log(`  { "name": "sharky-dev", "runtimeExecutable": "bun", "runtimeArgs": ["${process.argv[1]}", "--html", "${htmlPath}", "--port", "${snippetPort}"], "port": ${snippetPort} }`)
if (!gameId) console.log(`[dev-serve] the room's parent page exposes __MOCK_ROOM__.snapshot() — visible/phase/seq/players + per-frame errors/focus in one eval; the top bar shows a live TAB HIDDEN warning when the tab is backgrounded (rAF frozen, timers throttled)`)
