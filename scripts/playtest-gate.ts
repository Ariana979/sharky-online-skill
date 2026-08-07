// playtest-gate.ts — deterministic render checks for built games ("the eyes").
//
//   bun scripts/playtest-gate.ts --html dist/index.html                # smoke (default), ~7-10s
//   bun scripts/playtest-gate.ts --html dist/index.html --two-client [--seam-only]
//                                     # bus seam. seam-verdict.json is written phase:"running" at
//                                     # start, phase:"seam" once the hard asserts are decided (~2-3s
//                                     # — the boot/KV waits are event-driven polls with the old flat
//                                     # sleeps as caps, so it stays scene-weight-insensitive), and
//                                     # phase:"final" when the artifact frames finish (~13-15s
//                                     # measured on light 2D and vendored-3D builds; heavy scenes
//                                     # stretch the artifact tail, not the seam; a crash still stamps
//                                     # a terminal "final", aborted:true) — a backgrounded run is
//                                     # consumable from that file as soon as phase:"seam" lands.
//                                     # --seam-only exits right on the seam verdict (~1-2s, stamps a
//                                     # terminal "final" with seamOnly:true): the inner-loop variant;
//                                     # the full artifact run (which also re-checks G1 across the
//                                     # drive) stays the pre-publish gate.
//   bun scripts/playtest-gate.ts --html dist/index.html --filmstrip [--viewport mobile]
//                                     # 3 viewports × drive run CONCURRENTLY: ~25-40s full measured
//                                     # (2D / vendored-3D; scoped --viewport ≈ ~18s)
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
//               ways. Repaint = warning (measured across the 2s artifact
//               drive; skipped under --seam-only). Two clients probe the N-player bus;
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
// Browser: --chrome <path> wins; else system Chrome (channel), then Edge,
// then playwright's own registry, then known executable locations (a
// pre-provisioned PLAYWRIGHT_BROWSERS_PATH build, common Linux/macOS paths).
// Deps: bare 'playwright-core' import — bun auto-install resolves it (cache
// hit after first machine use). Measured trap: a node_modules directory here
// or in any ancestor (bun add/install residue) DISABLES bun auto-install and
// breaks clean checkouts — a lone package.json does not; versioned import
// specifiers don't resolve either (bun 1.3.13). Bare import is the design.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
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
if (args.viewport && MODE !== 'filmstrip') {
  console.error(`--viewport only applies to --filmstrip; ${MODE} runs at a fixed viewport`)
  process.exit(1)
}

const gameHtml = readFileSync(htmlPath, 'utf8')
mkdirSync(outDir, { recursive: true })
// Reset the verdict file FIRST (before the browser even launches) so a
// poller can never read a previous run's result during this run's boot.
if (MODE === 'two-client') {
  writeFileSync(resolve(outDir, 'seam-verdict.json'), JSON.stringify({ phase: 'running', at: new Date().toISOString() }, null, 2))
}

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
// --viewport <name> scopes a filmstrip run to one viewport (a CSS fix at a
// single width rarely needs the full 3-viewport pass) — the full run stays
// the default: single-viewport reruns cannot see cross-viewport regressions.
const SELECTED_VIEWPORTS = (() => {
  if (!args.viewport) return VIEWPORTS
  const hit = VIEWPORTS.filter((v) => v.name === args.viewport)
  if (!hit.length) {
    console.error(`unknown --viewport '${args.viewport}' (use: ${VIEWPORTS.map((v) => v.name).join(' | ')})`)
    process.exit(1)
  }
  return hit
})()

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

// Event-driven wait: poll cond() every 100ms until truthy or capMs elapses.
// Replaces the open-loop boot/settle sleeps — the cap keeps each wait's old
// worst case, so a slow game is no worse off and a fast one stops waiting the
// moment the condition it was waiting for is actually observable.
async function pollUntil(page: any, cond: () => Promise<boolean>, capMs: number): Promise<boolean> {
  const t0 = Date.now()
  for (;;) {
    if (await cond().catch(() => false)) return true
    if (Date.now() - t0 >= capMs) return false
    await page.waitForTimeout(100)
  }
}

// Readiness probe for the single-iframe modes (smoke/filmstrip): the game's
// SharkyNet has booted and received at least one bus state.
const netReady = (page: any) => async () => {
  const f = page.frames().find((fr: any) => fr !== page.mainFrame())
  if (!f) return false
  return f.evaluate(() => {
    const n = (window as any).SharkyNet
    return !!(n && n.stats && n.stats().stateUpdates > 0)
  })
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
  // playwright's own registry (honors PLAYWRIGHT_BROWSERS_PATH) — the browser
  // `bunx playwright install chromium` provisions
  try { return await chromium.launch({ headless: true }) } catch (e) {}
  // Known executable locations. A pre-provisioned PLAYWRIGHT_BROWSERS_PATH
  // whose build revision differs from this playwright-core's pin (the normal
  // case in managed sandboxes) makes the registry probe above miss — probe
  // the path directly, then the usual Linux/macOS install locations.
  const pwPath = process.env.PLAYWRIGHT_BROWSERS_PATH || ''
  const pwBuilds = (() => {
    try {
      return readdirSync(pwPath).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()
        .map((d) => join(pwPath, d, 'chrome-linux', 'chrome'))
    } catch { return [] }
  })()
  const candidates = [
    process.env.CHROME_PATH,
    pwPath && join(pwPath, 'chromium'), // conventional symlink to the pinned build
    ...pwBuilds,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean) as string[]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try { return await chromium.launch({ headless: true, executablePath: p }) } catch (e) {}
  }
  console.error('[gate] no browser found: no system Chrome/Edge, no playwright-managed chromium, no --chrome path.')
  console.error('[gate] fix (once): bunx playwright install chromium   — or pass --chrome <path to a Chrome/Chromium binary>')
  throw new Error('no Chrome/Chromium/Edge executable found')
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
const SRC_DECODE = (v: string) => `new TextDecoder().decode(Uint8Array.from(atob("${v}"), c => c.charCodeAt(0)))`

// Teardown deadline: a wedged Chrome close must never hold finished results
// hostage — no unbounded close ever stands between finished results and the
// exit: every close below races 10s, all result writes are sync, each mode
// exits explicitly. Playwright's exit hook SIGKILLs the browser process
// group, so a timed-out close leaves no orphan (verified 2026-07-17:
// exit-with-open-browser → zero headless processes).
const closeQuiet = (closing: Promise<unknown>) =>
  Promise.race([closing.catch(() => {}), new Promise<void>((r) => setTimeout(r, 10_000))])

const browser = await launchBrowser()

// ================================================================== filmstrip
if (MODE === 'filmstrip') {
  const page_html = injectShim(MOCK)
  const report: any = { mode: MODE, html: htmlPath, seconds: SECONDS, scoped: args.viewport ?? null, viewports: [], pass: true }

  if (SELECTED_VIEWPORTS.length < VIEWPORTS.length) {
    console.log(`[filmstrip] scoped to '${args.viewport}' — cross-viewport regressions are unseen in a scoped run (the full 3-viewport pass stays the default)`)
  }
  // The viewports are independent (own page, own MOCK bus) — run them
  // concurrently on the one launched browser: wall-clock = the slowest
  // viewport instead of the sum (measured ~58s serial → ~22s parallel on a
  // light scene). Fixed waits dominate each run (browser work measured
  // ~0.4s/viewport), so cross-page contention stays small even for 3D.
  const runViewport = async (vp: (typeof VIEWPORTS)[number]) => {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dpr })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
    // base64 the game html — raw embedding would be cut by its own </script> tags
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0"><iframe id="g" style="width:100vw;height:100vh;border:0"></iframe><script>document.getElementById('g').srcdoc = ${SRC_DECODE(b64(page_html))}<\/script></body></html>`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await pollUntil(page, netReady(page), 2500)
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
    console.log(`[${vp.name}] errors=${errors.length} repaint=${vpResult.repaintTransitions} focus=${withHook.length} centered=${centeredRatio === null ? 'n/a' : (centeredRatio * 100).toFixed(0) + '%'}`)
    await closeQuiet(page.close())
    return vpResult
  }
  // Promise.all preserves input order, so report.viewports stays deterministic
  // even though the runs interleave.
  for (const vpResult of await Promise.all(SELECTED_VIEWPORTS.map(runViewport))) {
    if (!vpResult.checks.G1_noErrors || !vpResult.checks.G2_repainting || vpResult.checks.G3_focusCentered === false) report.pass = false
    report.viewports.push(vpResult)
  }

  // contact sheet — written before teardown so a wedged close costs 10s, not the report
  const sheet = `<!DOCTYPE html><html><body style="background:#111;color:#eee;font-family:monospace">
<h2>playtest filmstrip — ${new Date().toISOString()}</h2>
${SELECTED_VIEWPORTS.map((vp) => `<h3>${vp.name}</h3><div style="display:flex;gap:4px;overflow-x:auto">${Array.from({ length: 8 }, (_, i) => `<img src="${vp.name}-${i}.png" style="width:220px">`).join('')}</div>`).join('')}
</body></html>`
  writeFileSync(resolve(outDir, 'filmstrip.html'), sheet)
  // Per-mode report so modes can run concurrently against one outDir and an
  // earlier mode's verdict stays re-readable; report.json = last-run copy.
  writeFileSync(resolve(outDir, 'report-filmstrip.json'), JSON.stringify(report, null, 2))
  writeFileSync(resolve(outDir, 'report.json'), JSON.stringify(report, null, 2))

  console.log(`\nfilmstrip: ${resolve(outDir, 'filmstrip.html')}`)
  if (!report.pass) console.error('\n❌ PLAYTEST GATE FAILED — the filmstrip has the failing frames')
  else console.log('\n✅ playtest gate passed (filmstrip written for human eyes)')
  await closeQuiet(browser.close())
  process.exit(report.pass ? 0 : 1)
}

// ================================================================= two-client
if (MODE === 'two-client') {
  const verdictPath = resolve(outDir, 'seam-verdict.json') // reset to "running" at module top
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

  const probe = (f: any) => f && f.evaluate(() => {
    const n = (window as any).SharkyNet
    if (!n) return null
    return { stateUpdates: n.stats().stateUpdates, players: Object.keys(n.players() || {}).length, shared: n.shared() || {} }
  }).catch(() => null)

  // Event-driven boot: both panes booted and receiving bus state (the old
  // flat 2500ms sleep is now the cap; typical games are ready in <1s).
  await pollUntil(page, async () => {
    const [pa, pb] = await Promise.all([probe(page.frame({ name: 'client-a' })), probe(page.frame({ name: 'client-b' }))])
    return !!(pa && pb && pa.stateUpdates > 0 && pb.stateUpdates > 0)
  }, 2500)
  const fa = page.frame({ name: 'client-a' })!
  const fb = page.frame({ name: 'client-b' })!

  // seed a cross-KV write on each side, then poll the full seam condition —
  // two 150ms pump cycles typically satisfy it (the old flat 900ms is the cap)
  await fa.evaluate(() => (window as any).SharkyNet && (window as any).SharkyNet.setShared('__gate_ka', 'A')).catch(() => {})
  await fb.evaluate(() => (window as any).SharkyNet && (window as any).SharkyNet.setShared('__gate_kb', 'B')).catch(() => {})
  let a: any = null, b: any = null
  await pollUntil(page, async () => {
    ;[a, b] = await Promise.all([probe(fa), probe(fb)])
    return !!(a && b && a.stateUpdates > 0 && b.stateUpdates > 0 && a.players === 2 && b.players === 2 &&
      a.shared['__gate_kb'] === 'B' && b.shared['__gate_ka'] === 'A')
  }, 900)

  const shotSeam = await page.screenshot()
  writeFileSync(resolve(outDir, 'two-client.png'), shotSeam as Buffer)

  // Seam verdict — written the moment the hard asserts are computable, so a
  // backgrounded run can be consumed early (heavy double-pane 3D scenes take
  // minutes to render the artifact frames that follow; the seam answer does
  // not need them). Rewritten with phase:"final" when the run completes —
  // page errors thrown during the artifact drive still fail the final gate.
  // (The repaint warning is computed later, across the drive window.)
  const seam = {
    T1_bothBoot: !!(a && b && a.stateUpdates > 0 && b.stateUpdates > 0),
    T2_playersMutual: !!(a && b && a.players === 2 && b.players === 2),
    T3_kvCross: !!(a && b && a.shared['__gate_kb'] === 'B' && b.shared['__gate_ka'] === 'A'),
  }
  const seamPass = seam.T1_bothBoot && seam.T2_playersMutual && seam.T3_kvCross && errors.length === 0
  writeFileSync(verdictPath, JSON.stringify({ phase: 'seam', seamPass, checks: { ...seam, G1_noErrors: errors.length === 0 }, errorsSoFar: errors.length, at: new Date().toISOString() }, null, 2))
  console.log(`[two-client] SEAM ${seamPass ? 'PASS' : 'FAIL'} — boot=${seam.T1_bothBoot} players=${a?.players}/${b?.players} kvCross=${seam.T3_kvCross} errors=${errors.length}${args['seam-only'] ? '' : ' (artifact frames rendering…)'}`)

  // --seam-only: the inner-loop variant — exit on the seam verdict, skipping
  // the ~12s artifact tail (countdown + drive + host-freeze frames are for
  // eyes; on iterations nobody will read them they are pure wait). Stamps a
  // terminal phase:"final" so a poller never hangs on this run. The full
  // artifact run (which also re-checks G1 across the drive) stays the
  // pre-publish gate.
  if (args['seam-only']) {
    const checks = { ...seam, G1_noErrors: errors.length === 0 }
    writeFileSync(verdictPath, JSON.stringify({ phase: 'final', seamOnly: true, seamPass, checks, errorsSoFar: errors.length, at: new Date().toISOString() }, null, 2))
    const report = { mode: MODE, seamOnly: true, html: htmlPath, errors, a, b: b && { ...b, shared: undefined }, checks, pass: seamPass }
    writeFileSync(resolve(outDir, 'report-two-client.json'), JSON.stringify(report, null, 2))
    writeFileSync(resolve(outDir, 'report.json'), JSON.stringify(report, null, 2))
    if (!seamPass) console.error('\n❌ TWO-CLIENT SEAM CHECK FAILED — see report-two-client.json')
    else console.log('✅ two-client seam check passed (--seam-only: artifact frames skipped — run the full mode before publish)')
    await closeQuiet(browser.close())
    process.exit(seamPass ? 0 : 1)
  }

  // Artifact phase — fail closed: if a heavy-scene crash / screenshot timeout
  // throws in here, the seam PASSED but the run could not complete, so we
  // stamp a terminal phase:"final" verdict (pass:false, aborted) before
  // exiting non-zero. A poller thus never hangs on phase:"running"/"seam".
  try {
  // Mid-play artifact (no assertion): everything above happens in the lobby,
  // where round-lifecycle bugs (ghost gone after death, private rounds,
  // misaligned relative rendering) are invisible. Start via the host pane,
  // nudge both panes apart, shoot one frame of BOTH clients in play.
  await fa.evaluate(() => { const el = document.getElementById('start-btn') as any; if (el) el.click() }).catch(() => {})
  await page.waitForTimeout(3600) // countdown window, same as filmstrip
  // The gate presses exactly #start-btn — a start control under any other id
  // is silently not pressed and every playing-phase artifact shows the lobby.
  // Surface that as a warning so it is diagnosed from stdout, not from PNGs.
  // (Warning only: turn-based/no-start games legitimately have no #start-btn.)
  const busPhase = await page.evaluate(() => (window as any).state && (window as any).state._phase).catch(() => null)
  if (busPhase === 'lobby') console.log(`[two-client] warn: room still in lobby after the #start-btn press attempt — no #start-btn, or the game starts differently; playing-phase artifacts will show the lobby`)
  const shotDrive0 = await page.screenshot()
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
    await closeQuiet(pairPage.close())
  } catch (e) {}

  const guestFreezeDelta = pixelDelta(gFrozen1 as Buffer, gFrozen2 as Buffer)
  const checks = {
    ...seam,
    W_repaint: pixelDelta(shotDrive0 as Buffer, playShot as Buffer) > 0.5, // warning only — measured across the 2s drive window
    G1_noErrors: errors.length === 0, // recomputed: drive-phase errors count
    W_guestLiveDuringHostFreeze: guestFreezeDelta > 0.5, // warning only
  }
  const pass = checks.T1_bothBoot && checks.T2_playersMutual && checks.T3_kvCross && checks.G1_noErrors
  writeFileSync(verdictPath, JSON.stringify({ phase: 'final', seamPass: pass, checks, errorsSoFar: errors.length, at: new Date().toISOString() }, null, 2))
  const report = { mode: MODE, html: htmlPath, errors, a, b: b && { ...b, shared: undefined }, checks, playingFrame: 'two-client-playing.png', hostFrozenFrame: 'host-frozen.png', hostFrozenPair: 'host-frozen-pair.png', hostFrozenForMs: HOST_FROZEN_MS, guestPaneDeltaWhileHostFrozen: Number(guestFreezeDelta.toFixed(2)), pass }
  writeFileSync(resolve(outDir, 'report-two-client.json'), JSON.stringify(report, null, 2))
  writeFileSync(resolve(outDir, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`[two-client] boot=${checks.T1_bothBoot} players=${a?.players}/${b?.players} kvCross=${checks.T3_kvCross} errors=${errors.length}${checks.W_repaint ? '' : ' (warn: low repaint — static screen?)'}${checks.W_guestLiveDuringHostFreeze ? '' : ' (warn: guest pane static during host-freeze — host-rAF-wired world? or static scene)'}`)
  console.log(`[two-client] mid-play frame (human eyes): ${resolve(outDir, 'two-client-playing.png')}`)
  console.log(`[two-client] host-frozen pair (${HOST_FROZEN_MS}ms apart, one look: does the guest countdown advance?): ${resolve(outDir, 'host-frozen-pair.png')}`)
  if (!pass) console.error('\n❌ TWO-CLIENT SEAM CHECK FAILED — see report-two-client.json')
  else console.log('✅ two-client seam check passed')
  await closeQuiet(browser.close())
  process.exit(pass ? 0 : 1)
  } catch (e: any) {
    // Fail closed: stamp a terminal verdict so a poller never hangs on
    // phase:"running"/"seam"; artifacts are incomplete, so the run counts
    // as failed even when the seam asserts had passed.
    try {
      writeFileSync(verdictPath, JSON.stringify({ phase: 'final', seamPass: false, aborted: true, error: String(e?.message ?? e).slice(0, 300), errorsSoFar: errors.length, at: new Date().toISOString() }, null, 2))
    } catch { /* disk gone — stdout still tells the story */ }
    console.error(`\n❌ TWO-CLIENT artifact phase crashed after seam ${seamPass ? 'PASS' : 'FAIL'} — run counts as failed: ${String(e?.message ?? e).slice(0, 200)}`)
    await closeQuiet(browser.close())
    process.exit(1)
  }
}

// ====================================================================== smoke
if (MODE === 'smoke') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
  await page.setContent(`<!DOCTYPE html><html><body style="margin:0"><iframe id="g" style="width:100vw;height:100vh;border:0"></iframe><script>document.getElementById('g').srcdoc = ${SRC_DECODE(b64(injectShim(MOCK)))}<\/script></body></html>`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await pollUntil(page, netReady(page), 2500) // event-driven boot; 2500ms is the cap
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
  writeFileSync(resolve(outDir, 'report-smoke.json'), JSON.stringify(report, null, 2))
  writeFileSync(resolve(outDir, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`[smoke] errors=${errors.length} repaint=${liveTransitions}/${shots.length - 1}${checks.W_repaint ? '' : ' (warn: no repaint observed — static screen?)'}${focus ? ` focus=${JSON.stringify(focus)}` : ''}`)
  if (!report.pass) console.error('\n❌ SMOKE FAILED — page errors on the final build; see report.json')
  else console.log('✅ smoke passed (final build renders with zero page errors)')
  await closeQuiet(browser.close())
  process.exit(report.pass ? 0 : 1)
}
