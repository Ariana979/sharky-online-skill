// playtest-gate.ts — deterministic render checks for built games ("the eyes").
//
//   bun scripts/playtest-gate.ts --html dist/index.html                # smoke (default), ~10s
//   bun scripts/playtest-gate.ts --html dist/index.html --two-client   # bus seam, ~25s
//   bun scripts/playtest-gate.ts --html dist/index.html --filmstrip    # 3 viewports × drive window, ~90s
//
// Modes (facts):
//   smoke       one desktop viewport, load → start → ~4s observe. Asserts G1
//               (zero page errors) on the final built file; repaint is
//               reported as a WARNING only (static-by-design screens exist).
//               Writes smoke-*.png + report.json.
//   --two-client two mock clients on one local bus, one viewport. Asserts the
//               seam invariants, all hard: both clients boot and receive
//               state, players() shows both on both sides (presence
//               auto-registration regression), shared-KV writes cross both
//               ways. Repaint = warning. Two clients probe the N-player bus;
//               they do not imply a 2-player game. After the seam checks it
//               presses the host pane's #start-btn (if present), injects ~2s
//               of keys into both panes and writes two-client-playing.png —
//               the only automated mid-play view of two clients (artifact
//               only, no assertion; the seam checks all happen in the lobby,
//               where round-lifecycle bugs are invisible). Then holds the
//               host pane's rAF ~5s and writes host-frozen.png: render loop
//               dead, timers still firing (= backgrounded tab on the rAF
//               axis), so world progression wired to the host's render loop
//               shows as a guest countdown frozen between the two frames
//               (artifact pair, no assertion).
//   --filmstrip full run at desktop / wide-retina / mobile 390×844@3 with a
//               TURNING drive script + camera drag; asserts over time:
//               G1 no page errors, G2 canvas keeps repainting, and — via the
//               window.__PLAYTEST__.focusScreenPos() hook if the game exposes
//               it — the player's object stays in the central screen band
//               ≥80% of samples. Writes 8 frames/viewport + filmstrip.html.
//
// Browser: locates a system Chrome (channel), then Edge, then --chrome <path>.
// Deps: bare 'playwright-core' import — bun auto-install resolves it (cache
// hit after first machine use). Measured trap: adding a package.json here
// DISABLES bun auto-install and breaks clean checkouts; versioned import
// specifiers don't resolve either (bun 1.3.13). Bare import is the design.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'

const args: Record<string, string> = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue
  const k = argv[i].slice(2)
  if (argv[i + 1] && !argv[i + 1].startsWith('--')) { args[k] = argv[++i] } else { args[k] = 'true' }
}
const htmlPath = resolve(args.html || 'dist/index.html')
const SECONDS = Number(args.seconds) || 10
const outDir = resolve(args.out || 'dist/playtest')
const MODE = args['two-client'] ? 'two-client' : args.filmstrip ? 'filmstrip' : 'smoke'

const gameHtml = readFileSync(htmlPath, 'utf8')
mkdirSync(outDir, { recursive: true })

// ---------------------------------------------------------------- mock rooms
// Single-player mock room: local identity + loopback bus with sim-like ordering.
const MOCK = `<script>
(function () {
  var state = { players: { 'playtest-p1': { name: 'P1' } }, seq: 0, log: [], kv: {}, clock: 0, _phase: 'lobby' };
  window.__SHARKY_LOCAL_BUS__ = {
    send: function (action) {
      if (action.type === 'START') state._phase = 'playing';
      if (action.type === 'OP') { state.seq++; state.log.push({ s: state.seq, u: 'playtest-p1', o: action.op }); if (state.log.length > 96) state.log.splice(0, state.log.length - 96); }
      if (action.type === 'SETKV') state.kv[String(action.k).slice(0, 64)] = action.v;
      return true;
    },
    onState: function (cb) { setInterval(function () { cb(JSON.parse(JSON.stringify(state))); state.clock += 0.15; }, 150); },
    identity: function () { return { user_id: 'playtest-p1', isHost: true, room_id: 'playtest' }; },
  };
  window.__DELTA_BRIDGE__ = {
    getRoomInfo: function () { return { user_id: 'playtest-p1', room_id: 'playtest', role: 'host', sync_mode: 'server_sim' }; },
    isHost: function () { return true; },
    sendAction: function (a) { return window.__SHARKY_LOCAL_BUS__.send(a); },
  };
})();
</script>`

// Two-client shim: identity per frame, bus lives in the PARENT page (same
// ordering semantics as dev-serve's mock parent).
const SHIM2 = (p: number) => `<script>
(function () {
  var P = ${p};
  window.__SHARKY_LOCAL_BUS__ = {
    send: function (action) { parent.postMessage({ ns: 'sharky-local-bus', action: action }, '*'); return true; },
    onState: function (cb) { window.addEventListener('message', function (ev) {
      if (ev.data && ev.data.ns === 'sharky-local-bus' && ev.data.state) cb(ev.data.state); }); },
    identity: function () { return { user_id: 'gate-' + (P === 1 ? 'a' : 'b'), isHost: P === 1, room_id: 'gate-2c' }; },
  };
  window.__DELTA_BRIDGE__ = {
    getRoomInfo: function () { return { user_id: 'gate-' + (P === 1 ? 'a' : 'b'), room_id: 'gate-2c', role: P === 1 ? 'host' : 'client', sync_mode: 'server_sim' }; },
    isHost: function () { return P === 1; },
    sendAction: function (a) { return window.__SHARKY_LOCAL_BUS__.send(a); },
  };
})();
</script>`

const injectShim = (shim: string) => gameHtml.replace(/<body[^>]*>/i, (m) => m + shim)

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 720, dpr: 1 },
  { name: 'wide-retina', width: 2000, height: 1176, dpr: 2 },
  { name: 'mobile', width: 390, height: 844, dpr: 3 },
]

// Input script with TURNS and sustained circling ("donuts") — gentle inputs
// hide rotation bugs; sustained full-lock from low speed is the worst case.
async function driveScript(page: any, frame: any, totalMs: number) {
  const key = (type: 'keydown' | 'keyup', k: string) =>
    frame.evaluate(([t, kk]: string[]) => dispatchEvent(new KeyboardEvent(t as any, { key: kk })), [type, k]).catch(() => {})
  const seg = totalMs / 10
  await key('keydown', 'w'); await key('keydown', 'a')        // DONUTS from standstill ×3
  await page.waitForTimeout(seg * 3)                          // (low speed + full lock = worst case)
  await key('keyup', 'a')                                     // straight ×2
  await page.waitForTimeout(seg * 2)
  await key('keydown', 'd')                                   // full-lock right ×2
  await page.waitForTimeout(seg * 2)
  await key('keyup', 'd')
  await page.mouse.move(400, 300); await page.mouse.down()    // camera drag
  await page.mouse.move(700, 260, { steps: 12 }); await page.mouse.up()
  await page.waitForTimeout(seg * 2)
  await page.waitForTimeout(seg)                              // recover window
  await key('keyup', 'w')
}

function pixelDelta(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length)
  let diff = 0, samples = 0
  for (let i = 0; i < n; i += 997) { diff += Math.abs(a[i] - b[i]); samples++ }
  return diff / Math.max(1, samples)
}

async function launchBrowser() {
  if (args.chrome) return chromium.launch({ headless: true, executablePath: args.chrome })
  try { return await chromium.launch({ headless: true, channel: 'chrome' }) } catch (e) {}
  try { return await chromium.launch({ headless: true, channel: 'msedge' }) } catch (e) {}
  // last resort: the classic macOS path (a browserless Linux box needs
  // `bunx playwright install chromium` once, then --chrome that binary)
  return chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
const SRC_DECODE = (v: string) => `new TextDecoder().decode(Uint8Array.from(atob("${v}"), c => c.charCodeAt(0)))`

const browser = await launchBrowser()

// ================================================================== filmstrip
if (MODE === 'filmstrip') {
  const page_html = injectShim(MOCK)
  const report: any = { mode: MODE, html: htmlPath, seconds: SECONDS, viewports: [], pass: true }

  for (const vp of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dpr })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
    // base64 the game html — raw embedding would be cut by its own </script> tags
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0"><iframe id="g" style="width:100vw;height:100vh;border:0"></iframe><script>document.getElementById('g').srcdoc = ${SRC_DECODE(b64(page_html))}<\/script></body></html>`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(2500)
    const frame = page.frames().find((f: any) => f !== page.mainFrame())!

    // start (host) and let any countdown pass
    await frame.evaluate(() => { const b = document.getElementById('start-btn') as any; if (b) b.click() }).catch(() => {})
    await page.waitForTimeout(3600)

    const focusSamples: Array<{ x: number; y: number } | null> = []
    const shots: Buffer[] = []
    const sampler = setInterval(async () => {
      const fp = await frame.evaluate(() => {
        const h = (window as any).__PLAYTEST__
        return h && typeof h.focusScreenPos === 'function' ? h.focusScreenPos() : null
      }).catch(() => null)
      focusSamples.push(fp)
    }, 400)

    const driver = driveScript(page, frame, SECONDS * 1000)
    const frameEvery = (SECONDS * 1000) / 8
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(frameEvery)
      const buf = await page.screenshot()
      shots.push(buf as Buffer)
      writeFileSync(resolve(outDir, `${vp.name}-${i}.png`), buf as Buffer)
    }
    await driver
    clearInterval(sampler)

    // G2: repaint activity
    let liveTransitions = 0
    for (let i = 1; i < shots.length; i++) if (pixelDelta(shots[i - 1], shots[i]) > 0.5) liveTransitions++
    // G3: focus centered (only when the hook exists)
    const withHook = focusSamples.filter(Boolean) as Array<{ x: number; y: number }>
    const centered = withHook.filter((p) => p.x >= 0.28 && p.x <= 0.72 && p.y >= 0.3 && p.y <= 0.88)
    const centeredRatio = withHook.length ? centered.length / withHook.length : null

    const vpResult = {
      viewport: vp.name,
      errors,
      repaintTransitions: `${liveTransitions}/${shots.length - 1}`,
      focusSamples: withHook.length,
      centeredRatio,
      checks: {
        G1_noErrors: errors.length === 0,
        G2_repainting: liveTransitions >= Math.floor((shots.length - 1) * 0.6),
        G3_focusCentered: centeredRatio === null ? 'skipped (no __PLAYTEST__ hook)' : centeredRatio >= 0.8,
      },
    }
    if (!vpResult.checks.G1_noErrors || !vpResult.checks.G2_repainting || vpResult.checks.G3_focusCentered === false) report.pass = false
    report.viewports.push(vpResult)
    console.log(`[${vp.name}] errors=${errors.length} repaint=${vpResult.repaintTransitions} focus=${withHook.length} centered=${centeredRatio === null ? 'n/a' : (centeredRatio * 100).toFixed(0) + '%'}`)
    await page.close()
  }
  await browser.close()

  // contact sheet
  const sheet = `<!DOCTYPE html><html><body style="background:#111;color:#eee;font-family:monospace">
<h2>playtest filmstrip — ${new Date().toISOString()}</h2>
${VIEWPORTS.map((vp) => `<h3>${vp.name}</h3><div style="display:flex;gap:4px;overflow-x:auto">${Array.from({ length: 8 }, (_, i) => `<img src="${vp.name}-${i}.png" style="width:220px">`).join('')}</div>`).join('')}
</body></html>`
  writeFileSync(resolve(outDir, 'filmstrip.html'), sheet)
  writeFileSync(resolve(outDir, 'report.json'), JSON.stringify(report, null, 2))

  console.log(`\nfilmstrip: ${resolve(outDir, 'filmstrip.html')}`)
  if (!report.pass) {
    console.error('\n❌ PLAYTEST GATE FAILED — inspect the filmstrip before publishing')
    process.exit(1)
  }
  console.log('\n✅ playtest gate passed (filmstrip written for human eyes)')
}

// ================================================================= two-client
if (MODE === 'two-client') {
  const htmlA = b64(injectShim(SHIM2(1)))
  const htmlB = b64(injectShim(SHIM2(2)))
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
  // parent page IS the bus: registers a client on any message, orders ops,
  // broadcasts full state every 150ms (same semantics as dev-serve's mock).
  await page.setContent(`<!DOCTYPE html><html><body style="margin:0;background:#020617">
<div style="display:flex;height:100vh;gap:2px">
<iframe id="a" name="client-a" style="flex:1;border:0"></iframe>
<iframe id="b" name="client-b" style="flex:1;border:0"></iframe>
</div>
<script>
var state = { players: {}, seq: 0, log: [], kv: {}, clock: 0, _phase: 'lobby' };
var uids = ['gate-a', 'gate-b'];
window.addEventListener('message', function (ev) {
  if (!ev.data || ev.data.ns !== 'sharky-local-bus') return;
  var fs = [document.getElementById('a').contentWindow, document.getElementById('b').contentWindow];
  var idx = fs.indexOf(ev.source); if (idx < 0) return;
  state.players[uids[idx]] = { name: 'Gate-' + (idx ? 'B' : 'A') };
  var a = ev.data.action || {};
  if (a.type === 'START') state._phase = 'playing';
  if (a.type === 'OP') { state.seq++; state.log.push({ s: state.seq, u: uids[idx], o: a.op }); if (state.log.length > 96) state.log.splice(0, state.log.length - 96); }
  if (a.type === 'SETKV') state.kv[String(a.k).slice(0, 64)] = a.v;
});
setInterval(function () {
  var snap = JSON.parse(JSON.stringify(state));
  ['a', 'b'].forEach(function (id) { try { document.getElementById(id).contentWindow.postMessage({ ns: 'sharky-local-bus', state: snap }, '*') } catch (e) {} });
  state.clock += 0.15;
}, 150);
document.getElementById('a').srcdoc = ${SRC_DECODE(htmlA)};
document.getElementById('b').srcdoc = ${SRC_DECODE(htmlB)};
<\/script></body></html>`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(2500)

  const fa = page.frame({ name: 'client-a' })!
  const fb = page.frame({ name: 'client-b' })!
  const probe = (f: any) => f.evaluate(() => {
    const n = (window as any).SharkyNet
    if (!n) return null
    return { stateUpdates: n.stats().stateUpdates, players: Object.keys(n.players() || {}).length, shared: n.shared() || {} }
  }).catch(() => null)

  // seed a cross-KV write on each side, give the 150ms pump a moment
  await fa.evaluate(() => (window as any).SharkyNet && (window as any).SharkyNet.setShared('__gate_ka', 'A')).catch(() => {})
  await fb.evaluate(() => (window as any).SharkyNet && (window as any).SharkyNet.setShared('__gate_kb', 'B')).catch(() => {})
  await page.waitForTimeout(900)

  const shot1 = await page.screenshot()
  await page.waitForTimeout(1000)
  const shot2 = await page.screenshot()
  writeFileSync(resolve(outDir, 'two-client.png'), shot2 as Buffer)
  const a = await probe(fa), b = await probe(fb)

  // Mid-play artifact (no assertion): everything above happens in the lobby,
  // where round-lifecycle bugs (ghost gone after death, private rounds,
  // misaligned relative rendering) are invisible. Start via the host pane,
  // nudge both panes apart, shoot one frame of BOTH clients in play.
  await fa.evaluate(() => { const el = document.getElementById('start-btn') as any; if (el) el.click() }).catch(() => {})
  await page.waitForTimeout(3600) // countdown window, same as filmstrip
  const tap = (f: any, type: string, k: string) =>
    f.evaluate(([t, kk]: string[]) => dispatchEvent(new KeyboardEvent(t as any, { key: kk })), [type, k]).catch(() => {})
  await tap(fa, 'keydown', 'w'); await tap(fb, 'keydown', 'a')
  await page.waitForTimeout(2000)
  await tap(fa, 'keyup', 'w'); await tap(fb, 'keyup', 'a')
  const playShot = await page.screenshot()
  writeFileSync(resolve(outDir, 'two-client-playing.png'), playShot as Buffer)

  // Host-frozen artifact (no assertion): hold the host pane's rAF ~5s (queue
  // callbacks, don't run them), shoot both panes, then release the queue.
  // This reproduces a backgrounded host tab exactly on the rAF axis — render
  // loop dead, same-page timers still firing (a REAL background tab also
  // throttles timers to ~1/s; throttle-driven defect classes are outside
  // this frame's sight; display:none is useless here — a same-page iframe's
  // rAF follows the PARENT page's visibility). World progression wired to
  // the host's render loop shows up as a guest countdown frozen between
  // two-client-playing.png and this frame — judge the PAIR, not one frame.
  await fa.evaluate(() => {
    const w = window as any
    w.__rafOrig = w.requestAnimationFrame.bind(w); w.__rafQ = []
    w.requestAnimationFrame = (cb: any) => { w.__rafQ.push(cb); return 0 }
  }).catch(() => {})
  const HOST_FROZEN_MS = 5000
  // Guest-pane liveness sample across the freeze (warning only): the right
  // half is the guest iframe; pixel-static there while the host rAF is held
  // = world progression may be wired to the host's render loop — or a
  // static-by-design scene. The pair image stays the judge.
  const GUEST_CLIP = { x: 642, y: 0, width: 636, height: 718 }
  const gFrozen1 = await page.screenshot({ clip: GUEST_CLIP })
  await page.waitForTimeout(HOST_FROZEN_MS)
  const gFrozen2 = await page.screenshot({ clip: GUEST_CLIP })
  const frozenShot = await page.screenshot()
  writeFileSync(resolve(outDir, 'host-frozen.png'), frozenShot as Buffer)
  await fa.evaluate(() => {
    const w = window as any
    w.requestAnimationFrame = w.__rafOrig
    const q = w.__rafQ.splice(0); q.forEach((cb: any) => w.requestAnimationFrame(cb))
  }).catch(() => {})

  // Composite pair: both frames side-by-side with the Δt label — one Read
  // judges it (a countdown identical across the panes is the freeze tell).
  try {
    const pairPage = await browser.newPage()
    await pairPage.setViewportSize({ width: 1280, height: 400 })
    await pairPage.setContent(`<body style="margin:0;background:#111;color:#eee;font:12px monospace">
      <div style="display:flex;gap:4px;padding:4px">
        <div style="flex:1"><div style="padding:2px 6px">t=0 · two-client-playing</div>
          <img style="width:100%" src="data:image/png;base64,${(playShot as Buffer).toString('base64')}"></div>
        <div style="flex:1"><div style="padding:2px 6px">t=+${HOST_FROZEN_MS}ms · host rAF frozen — did the guest countdown advance?</div>
          <img style="width:100%" src="data:image/png;base64,${(frozenShot as Buffer).toString('base64')}"></div>
      </div></body>`)
    const pairShot = await pairPage.screenshot()
    writeFileSync(resolve(outDir, 'host-frozen-pair.png'), pairShot as Buffer)
    await pairPage.close()
  } catch (e) {}

  const guestFreezeDelta = pixelDelta(gFrozen1 as Buffer, gFrozen2 as Buffer)
  const checks = {
    T1_bothBoot: !!(a && b && a.stateUpdates > 0 && b.stateUpdates > 0),
    T2_playersMutual: !!(a && b && a.players === 2 && b.players === 2),
    T3_kvCross: !!(a && b && a.shared['__gate_kb'] === 'B' && b.shared['__gate_ka'] === 'A'),
    G1_noErrors: errors.length === 0,
    W_repaint: pixelDelta(shot1 as Buffer, shot2 as Buffer) > 0.5, // warning only
    W_guestLiveDuringHostFreeze: guestFreezeDelta > 0.5, // warning only
  }
  const pass = checks.T1_bothBoot && checks.T2_playersMutual && checks.T3_kvCross && checks.G1_noErrors
  const report = { mode: MODE, html: htmlPath, errors, a, b: b && { ...b, shared: undefined }, checks, playingFrame: 'two-client-playing.png', hostFrozenFrame: 'host-frozen.png', hostFrozenPair: 'host-frozen-pair.png', hostFrozenForMs: HOST_FROZEN_MS, guestPaneDeltaWhileHostFrozen: Number(guestFreezeDelta.toFixed(2)), pass }
  writeFileSync(resolve(outDir, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`[two-client] boot=${checks.T1_bothBoot} players=${a?.players}/${b?.players} kvCross=${checks.T3_kvCross} errors=${errors.length}${checks.W_repaint ? '' : ' (warn: low repaint — static screen?)'}${checks.W_guestLiveDuringHostFreeze ? '' : ' (warn: guest pane static during host-freeze — host-rAF-wired world? or static scene)'}`)
  console.log(`[two-client] mid-play frame (human eyes): ${resolve(outDir, 'two-client-playing.png')}`)
  console.log(`[two-client] host-frozen pair (${HOST_FROZEN_MS}ms apart, one look: does the guest countdown advance?): ${resolve(outDir, 'host-frozen-pair.png')}`)
  await browser.close()
  if (!pass) { console.error('\n❌ TWO-CLIENT SEAM CHECK FAILED — see report.json'); process.exit(1) }
  console.log('✅ two-client seam check passed')
}

// ====================================================================== smoke
if (MODE === 'smoke') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
  await page.setContent(`<!DOCTYPE html><html><body style="margin:0"><iframe id="g" style="width:100vw;height:100vh;border:0"></iframe><script>document.getElementById('g').srcdoc = ${SRC_DECODE(b64(injectShim(MOCK)))}<\/script></body></html>`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(2500)
  const frame = page.frames().find((f: any) => f !== page.mainFrame())!
  await frame.evaluate(() => { const b = document.getElementById('start-btn') as any; if (b) b.click() }).catch(() => {})

  const shots: Buffer[] = []
  let focus: any = null
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(1400)
    const buf = await page.screenshot()
    shots.push(buf as Buffer)
    writeFileSync(resolve(outDir, `smoke-${i}.png`), buf as Buffer)
    focus = await frame.evaluate(() => {
      const h = (window as any).__PLAYTEST__
      return h && typeof h.focusScreenPos === 'function' ? h.focusScreenPos() : null
    }).catch(() => null)
  }
  let liveTransitions = 0
  for (let i = 1; i < shots.length; i++) if (pixelDelta(shots[i - 1], shots[i]) > 0.5) liveTransitions++

  const checks = {
    G1_noErrors: errors.length === 0,
    W_repaint: liveTransitions >= 1, // warning only — static-by-design screens exist
    I_focus: focus, // informational, when the hook exists
  }
  const report = { mode: MODE, html: htmlPath, errors, repaintTransitions: `${liveTransitions}/${shots.length - 1}`, checks, pass: checks.G1_noErrors }
  writeFileSync(resolve(outDir, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`[smoke] errors=${errors.length} repaint=${liveTransitions}/${shots.length - 1}${checks.W_repaint ? '' : ' (warn: no repaint observed — static screen?)'}${focus ? ` focus=${JSON.stringify(focus)}` : ''}`)
  await browser.close()
  if (!report.pass) { console.error('\n❌ SMOKE FAILED — page errors on the final build; see report.json'); process.exit(1) }
  console.log('✅ smoke passed (final build renders with zero page errors)')
}
