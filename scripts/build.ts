// build.ts — inject the Sharky online runtime into a free-form HTML game.
//
//   bun scripts/build.ts --game my-game.html --title "My Game" \
//       --min-players 2 --max-players 8 --out dist/index.html
//
// Injects, right after <body> (or before the first <script> if no <body>):
//   1. bridge.js          — platform identity/room/relay transport
//   2. shim game config   — inert here; executed by the server-side sim
//   3. sharky-net.js      — the ordered-op bus API the game code uses
//
// The game HTML stays fully free-form. Its only obligations:
//   await SharkyNet.ready(); use SharkyNet.send/on/setShared for ALL shared
//   state; never open your own sockets.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import vm from 'node:vm'

const args: Record<string, string> = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] ?? ''
}
const gamePath = args.game
if (!gamePath) {
  console.error('usage: bun build.ts --game <game.html> [--title T] [--min-players 2] [--max-players 8] [--out dist/index.html]')
  process.exit(1)
}

const skillRoot = resolve(import.meta.dir, '..')
const html = readFileSync(resolve(gamePath), 'utf8')
const bridge = readFileSync(resolve(skillRoot, 'assets/bridge.js'), 'utf8')
const net = readFileSync(resolve(skillRoot, 'assets/sharky-net.js'), 'utf8')
const shim = readFileSync(resolve(skillRoot, 'assets/shim-game.template.js'), 'utf8')
  .replaceAll('__TITLE__', (args.title || 'Untitled Sharky Game').replace(/'/g, "\\'"))
  .replaceAll('__MIN_PLAYERS__', String(Number(args['min-players']) || 2))
  .replaceAll('__MAX_PLAYERS__', String(Number(args['max-players']) || 8))

// Basic guards on the AUTHORED game code (before vendor expansion): the game
// must not carry its own network/game-config code.
if (/__DELTA_GAME_CONFIG__/.test(html)) throw new Error('game HTML must not define __DELTA_GAME_CONFIG__ (the build injects the shim)')
if (/new\s+WebSocket\s*\(/.test(html)) throw new Error('game HTML must not open raw WebSockets — use SharkyNet')

// Vendor inlining: `/*__VENDOR:<name>__*/` inside a <script> is replaced with
// assets/vendor/<name>.js — keeps games fully self-contained (no CDN).
const htmlWithVendors = html.replace(/\/\*__VENDOR:([A-Za-z0-9.\-]+)__\*\//g, (_, name: string) => {
  const p = resolve(skillRoot, 'assets/vendor', `${name}.js`)
  const body = readFileSync(p, 'utf8')
  console.log(`[build] inlined vendor ${name} (${body.length} bytes)`)
  return body
})

const runtime = `<script>/* sharky-online runtime: bridge */\n${bridge}\n</script>\n` +
  `<script>/* sharky-online runtime: sim shim (inert in browser) */\n${shim}\n</script>\n` +
  `<script>/* sharky-online runtime: net API */\n${net}\n</script>\n`

let out: string
if (/<body[^>]*>/i.test(htmlWithVendors)) {
  out = htmlWithVendors.replace(/<body[^>]*>/i, (m) => m + '\n' + runtime)
} else if (/<script/i.test(htmlWithVendors)) {
  out = htmlWithVendors.replace(/<script/i, runtime + '<script')
} else {
  out = runtime + htmlWithVendors
}

// --- sim-compatibility gate ---
// Mirrors the platform sim's loader (verified against sim-service source):
// extract inline <script> bodies (skipping src=), vm-execute each with
// sim-like globals (per-script errors ignored, like the sim does), then
// require window.__DELTA_GAME_CONFIG__ to exist. Catches unreplaced
// placeholders, scripts that clobber the config, and </script> splits.
async function simGate(html: string): Promise<{ ok: boolean; detail: string }> {
  if (/__(TITLE|MIN_PLAYERS|MAX_PLAYERS)__/.test(html)) {
    return { ok: false, detail: 'unreplaced template placeholder in output' }
  }
  const blocks: string[] = []
  const re = /<script(?:\s[^>]*)?>([^]*?)<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const openTag = m[0].slice(0, m[0].indexOf('>'))
    if (/\bsrc\s*=/i.test(openTag)) continue
    const body = (m[1] || '').trim()
    if (body) blocks.push(body)
  }
  if (blocks.length === 0) return { ok: false, detail: 'no inline scripts extracted' }
  const noop = () => {}
  const globals: Record<string, unknown> = {
    window: { __DELTA_GAME_CONFIG__: null },
    document: {}, navigator: {}, location: {},
    console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },
    Math, Object, Array, String, Number, Boolean, Date, RegExp, JSON, Error,
    RangeError, TypeError, ReferenceError, SyntaxError, URIError,
    Map, Set, WeakMap, WeakSet, Promise, Symbol, Proxy, Reflect,
    parseInt, parseFloat, isNaN, isFinite,
  }
  const context = vm.createContext(globals)
  // The sim kills sessions on unhandled rejections from game scripts —
  // treat any rejection surfacing here as a gate failure.
  const rejections: unknown[] = []
  const onRejection = (reason: unknown) => { rejections.push(reason) }
  process.on('unhandledRejection', onRejection)
  try {
    for (const body of blocks) {
      try {
        new vm.Script(body, { filename: 'game-inline.js' }).runInContext(context, { timeout: 1200 })
      } catch { /* the sim ignores per-script sync errors too */ }
    }
    // drain microtasks + a tick so async IIFEs settle
    await new Promise((r) => setTimeout(r, 20))
  } finally {
    process.off('unhandledRejection', onRejection)
  }
  if (rejections.length > 0) {
    return { ok: false, detail: `game scripts leaked ${rejections.length} unhandled rejection(s) in the sim sandbox (first: ${String(rejections[0]).slice(0, 80)}) — guard scripts with "if (typeof SharkyNet === 'undefined') return"` }
  }
  const cfg = (globals.window as any)?.__DELTA_GAME_CONFIG__ || (globals as any).__DELTA_GAME_CONFIG__
  if (!cfg || typeof cfg !== 'object') return { ok: false, detail: '__DELTA_GAME_CONFIG__ not set after vm execution' }
  for (const cb of ['initState', 'onAction', 'render', 'customActions']) {
    if (typeof cfg[cb] !== 'function') return { ok: false, detail: `config.${cb} missing after vm execution` }
  }
  return { ok: true, detail: `config ok (minPlayers=${cfg.minPlayers}, maxPlayers=${cfg.maxPlayers})` }
}

const gate = await simGate(out)
if (!gate.ok) {
  console.error(`[build] SIM GATE FAILED: ${gate.detail}`)
  process.exit(1)
}

const outPath = resolve(args.out || 'dist/index.html')
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, out, 'utf8')
console.log(`[build] ${outPath} (${out.length} bytes) — game ${gamePath} + sharky runtime`)
console.log(`[build] sim gate: ${gate.detail}`)
