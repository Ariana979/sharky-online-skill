// inject.ts — the ONE runtime-injection path, shared by build.ts (which adds
// the vm sim gate on top) and dev-serve.ts --game mode (per-request authoring
// loop). Keeping a single implementation is what stops the two from
// diverging: contract guards, vendor expansion, and insertion order are
// load-bearing (the mock shim must precede bridge.js, which must precede the
// game's own scripts).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface InjectOpts {
  skillRoot: string
  title?: string
  minPlayers?: number
  maxPlayers?: number
  log?: (line: string) => void
}

// Throws on a game-contract violation (same messages as the build always
// printed); returns the page with bridge + shim config + sharky-net injected
// right after <body> (or before the first <script> if no <body>).
export function injectRuntime(html: string, opts: InjectOpts): string {
  const { skillRoot, log = () => {} } = opts
  const bridge = readFileSync(resolve(skillRoot, 'assets/bridge.js'), 'utf8')
  const net = readFileSync(resolve(skillRoot, 'assets/sharky-net.js'), 'utf8')
  const shim = readFileSync(resolve(skillRoot, 'assets/shim-game.template.js'), 'utf8')
    .replaceAll('__TITLE__', (opts.title || 'Untitled Sharky Game').replace(/'/g, "\\'"))
    .replaceAll('__MIN_PLAYERS__', String(Number(opts.minPlayers) || 2))
    .replaceAll('__MAX_PLAYERS__', String(Number(opts.maxPlayers) || 8))

  // Basic guards on the AUTHORED game code (before vendor expansion): the game
  // must not carry its own network/game-config code.
  if (/__DELTA_GAME_CONFIG__/.test(html)) throw new Error('game HTML must not define __DELTA_GAME_CONFIG__ (the build injects the shim)')
  if (/new\s+WebSocket\s*\(/.test(html)) throw new Error('game HTML must not open raw WebSockets — use SharkyNet')

  // Vendor inlining: `/*__VENDOR:<name>__*/` inside a <script> is replaced with
  // assets/vendor/<name>.js — keeps games fully self-contained (no CDN).
  const htmlWithVendors = html.replace(/\/\*__VENDOR:([A-Za-z0-9._\-]+)__\*\//g, (_, name: string) => {
    const p = resolve(skillRoot, 'assets/vendor', `${name}.js`)
    const body = readFileSync(p, 'utf8')
    log(`[build] inlined vendor ${name} (${body.length} bytes)`)
    return body
  })
  // A placeholder left unexpanded (name chars outside [A-Za-z0-9._-]) would
  // ship as a dead comment and only surface as a runtime ReferenceError.
  if (/\/\*__VENDOR:/.test(htmlWithVendors)) {
    throw new Error('unexpanded /*__VENDOR:<name>__*/ placeholder — vendor names take [A-Za-z0-9._-]')
  }

  const runtime = `<script>/* sharky-online runtime: bridge */\n${bridge}\n</script>\n` +
    `<script>/* sharky-online runtime: sim shim (inert in browser) */\n${shim}\n</script>\n` +
    `<script>/* sharky-online runtime: net API */\n${net}\n</script>\n`

  if (/<body[^>]*>/i.test(htmlWithVendors)) {
    return htmlWithVendors.replace(/<body[^>]*>/i, (m) => m + '\n' + runtime)
  }
  if (/<script/i.test(htmlWithVendors)) {
    return htmlWithVendors.replace(/<script/i, runtime + '<script')
  }
  return runtime + htmlWithVendors
}
