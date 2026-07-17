// room-test.ts — automated 2-client verification of a PUBLISHED game's room.
//
//   bun scripts/room-test.ts --game-id <id> [--chrome <path>]
//
// Signs two guest bootstraps, joins the real server_sim room with two headless
// clients loading the real game_url, then asserts the sync bus works:
// relay open → START → playing → cross-client ordered op delivery + RTT.
// playwright-core resolves by bare import (bun auto-installs it on first
// run, same as playtest-gate). Measured trap: a node_modules directory in
// the skill folder or any ancestor — e.g. bun add/install residue —
// DISABLES bun auto-install and breaks clean checkouts (a lone
// package.json does not; bun 1.3.13). Bare import is the design; the
// skill folder stays node_modules-free.
import { chromium } from 'playwright-core'

const args: Record<string, string> = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] ?? ''
const gameId = args['game-id']
if (!gameId) { console.error('usage: bun room-test.ts --game-id <published game id>'); process.exit(1) }
// browser discovery mirrors playtest-gate: system Chrome, then Edge, then
// the classic macOS path; --chrome <path> overrides everything.
async function launchBrowser() {
  if (args.chrome) return chromium.launch({ headless: true, executablePath: args.chrome })
  try { return await chromium.launch({ headless: true, channel: 'chrome' }) } catch (e) {}
  try { return await chromium.launch({ headless: true, channel: 'msedge' }) } catch (e) {}
  return chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
}

// 1. guest bootstraps (two per attempt, on one fresh instance per attempt)
async function guestBootstrap(inst: string, name: string) {
  const r = await fetch(`https://api.sharky.gg/api/v1/games/${gameId}/bootstrap-guest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ guest_id: crypto.randomUUID(), display_name: name, client: {}, instance_id: inst }),
  })
  const j: any = await r.json()
  if (j.error_code) throw new Error('bootstrap failed: ' + JSON.stringify(j))
  return j.data
}

// 2. two clients: iframe the real game_url, inject bootstrap via postMessage
const PARENT = (bs: any) => `<!DOCTYPE html><html><body style="margin:0">
<iframe id="g" src="${bs.game_url}" style="width:100vw;height:100vh;border:0"></iframe>
<script>
var bs = ${JSON.stringify(bs)};
document.getElementById('g').addEventListener('load', function () {
  setTimeout(function () {
    document.getElementById('g').contentWindow.postMessage(
      { ns: 'delta-bridge', action: 'game:network-bootstrap', payload: bs, timestamp: Date.now() }, '*');
  }, 400);
});
</script></body></html>`

// Launched lazily on first use so bootstrap failures (bad game-id, wrong
// sync_mode) never pay a Chrome start.
let browser: any = null
async function openClient(bs: any) {
  if (!browser) browser = await launchBrowser()
  const page = await browser.newPage({ viewport: { width: 900, height: 640 } })
  // 3D games can be ~1MB; first /play fetch may be a cold cache
  await page.setContent(PARENT(bs), { waitUntil: 'domcontentloaded', timeout: 90_000 })
  return page
}
const frame = (p: any) => p.frames().find((f: any) => f !== p.mainFrame())
async function inGame<T>(p: any, fn: () => T): Promise<T | undefined> {
  const f = frame(p)
  return f ? f.evaluate(fn).catch(() => undefined) : undefined
}

// 3. join: bootstrap + open both clients + wait for both relay sockets.
// The FIRST room after a fresh publish rides a cold chain (cold /play fetch
// + sim warmup); measured 2026-07-15: the server side warms in ~1-2s, but a
// client's cold page fetch can outlast this poll window — one in-script
// fresh-join retry absorbs exactly that case. A genuinely dead room still
// fails, just one attempt (~30s) later.
let A: any, B: any
async function joinOnce(): Promise<void> {
  const inst = crypto.randomUUID()
  const bsA = await guestBootstrap(inst, 'RoomTest-A')
  const bsB = await guestBootstrap(inst, 'RoomTest-B')
  if (bsA.sync_mode !== 'server_sim') throw new Error(`sync_mode is ${bsA.sync_mode}, expected server_sim — check user_games.authority_mode`)
  console.log('[ok] bootstraps signed · sync_mode=server_sim · game_url =', String(bsA.game_url).slice(-50))
  A = await openClient(bsA)
  B = await openClient(bsB)
  for (let i = 0; i < 40; i++) {
    const a = await inGame(A, () => !!(window as any).SharkyNet && (window as any).SharkyNet.stats().stateUpdates >= 0 && (window as any).__DELTA_BRIDGE__?.relaySocket?.readyState === 1)
    const b = await inGame(B, () => (window as any).__DELTA_BRIDGE__?.relaySocket?.readyState === 1)
    if (a && b) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('relay never opened on both clients')
}
try {
  await joinOnce()
} catch (e) {
  if (!String(e).includes('relay never opened')) throw e
  console.log('[cold start] first room after a fresh publish can take ~1min to warm — retrying with a fresh join')
  try { await A?.close() } catch {}
  try { await B?.close() } catch {}
  await joinOnce()
}
console.log('[ok] both clients connected to the room')

// 4. host starts; exchange ops
await inGame(A, () => (window as any).SharkyNet.start())
await new Promise((r) => setTimeout(r, 2000))
for (let i = 0; i < 10; i++) {
  await inGame(A, () => (window as any).SharkyNet.send({ k: 'roomtest', from: 'A' }))
  await inGame(B, () => (window as any).SharkyNet.send({ k: 'roomtest', from: 'B' }))
  await new Promise((r) => setTimeout(r, 150))
}
await new Promise((r) => setTimeout(r, 3000))

const sA = await inGame<any>(A, () => (window as any).SharkyNet.stats())
const sB = await inGame<any>(B, () => (window as any).SharkyNet.stats())
console.log('[A]', JSON.stringify(sA))
console.log('[B]', JSON.stringify(sB))
await browser.close()

if (!sA || !sB) throw new Error('SharkyNet stats unavailable — is the game built with scripts/build.ts?')
if (sA.stateUpdates === 0) throw new Error('sim never broadcast — check the published HTML contains the shim config')
if (sA.applied < sA.sent + 5) throw new Error('A did not receive both op streams')
if (sB.applied < sB.sent + 5) throw new Error('B did not receive both op streams')
console.log(`\n✅ ROOM OK — ordered bus verified · A rtt≈${sA.lastRttMs}ms B rtt≈${sB.lastRttMs}ms`)
