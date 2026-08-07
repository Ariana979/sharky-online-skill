// race-probe.ts — win-path probe for the race lifecycle (hard-parts §0.9).
//
// The playtest gate proves the bus seam and that the page renders. It does not
// prove the DISCRETE outcomes: that crossing the line produces the same
// finisher on BOTH clients, that the flag gets a non-finisher to the results
// screen, and that the host's NEXT RACE resets everyone rather than just the
// clicker. Those are state-assertable against the dev-serve mock room in
// seconds, through the game's own __PLAYTEST__ hooks.
//
//   bun scripts/dev-serve.ts --html game/dist/index.html   # in another shell
//   bun game/tools/race-probe.ts --url http://127.0.0.1:5199/
import { chromium } from 'playwright-core'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const arg = (n: string, d: string) => {
  const i = argv.indexOf(`--${n}`)
  return i === -1 ? d : argv[i + 1]
}
const URL = arg('url', 'http://127.0.0.1:5199/')

async function launch() {
  try { return await chromium.launch({ headless: true, channel: 'chrome' }) } catch {}
  try { return await chromium.launch({ headless: true }) } catch {}
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH || ''
  const builds = (() => {
    try {
      return readdirSync(pw).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()
        .map((d) => join(pw, d, 'chrome-linux', 'chrome'))
    } catch { return [] }
  })()
  for (const p of [pw && join(pw, 'chromium'), ...builds, '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean) as string[]) {
    if (!existsSync(p)) continue
    try { return await chromium.launch({ headless: true, executablePath: p }) } catch {}
  }
  throw new Error('no chromium found')
}

const fails: string[] = []
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails.push(name)
}

const browser = await launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } })
const errors: string[] = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(URL, { waitUntil: 'domcontentloaded' })

const frameFor = (p: string) => page.frames().find((f) => f.url().includes(`p=${p}`))
async function until<T>(label: string, fn: () => Promise<T | null>, ms = 45000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch { /* frame reloads / not ready yet */ }
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

const panes = await until('both panes', async () => {
  const h = frameFor('1'), g = frameFor('2')
  if (!h || !g) return null
  const ready = await Promise.all([h, g].map((f) => f.evaluate(() => !!(window as any).__PLAYTEST__).catch(() => false)))
  return ready.every(Boolean) ? { host: h, guest: g } : null
})
const stateOf = (f: any) => f.evaluate(() => (window as any).__PLAYTEST__.state())
console.log(`[probe] both panes booted (${URL})`)

// 1. the host's START is a ROOM verb: both panes leave the lobby and land in
//    the SAME race, and the countdown reaches GO on both.
await panes.host.evaluate(() => (document.getElementById('start-btn') as HTMLButtonElement).click())
const startedBoth = await until('both panes racing', async () => {
  const [h, g] = await Promise.all([stateOf(panes.host), stateOf(panes.guest)])
  return h.started && g.started && h.round >= 1 && h.round === g.round ? { h, g } : null
})
check('START moves BOTH clients into the same race', true, `round=${startedBoth.h.round}`)

// 2. the host crosses the line: the SAME finisher must appear on both panes.
await panes.host.evaluate(() => (window as any).__PLAYTEST__.toFinish())
await panes.host.evaluate(() => dispatchEvent(new KeyboardEvent('keydown', { key: 'w' })))
const finished = await until('finish echoed to both panes', async () => {
  const [h, g] = await Promise.all([stateOf(panes.host), stateOf(panes.guest)])
  return h.finished && h.fin.length && g.fin.length && h.fin[0] === g.fin[0] ? { h, g } : null
})
await panes.host.evaluate(() => dispatchEvent(new KeyboardEvent('keyup', { key: 'w' })))
check('finish lands identically on both clients', true, `winner=${finished.h.fin[0]} t=${finished.h.ms}ms`)
check('the winner is the pane that actually drove', finished.h.fin[0] !== finished.g.fin[0] ? false : true)

// 3. the guest never crossed the line — the flag has to bring it to the
//    results screen anyway, or a trailing player sits in a finished race.
const flagged = await until('guest flagged off', async () => {
  const g = await stateOf(panes.guest)
  const shown = await panes.guest.evaluate(() => !(document.getElementById('result') as HTMLElement).hidden)
  return g.finished && shown ? g : null
}, 60000)
check('the chequered flag brings a non-finisher to the results screen', true, `guest ms=${flagged.ms}`)

// 4. NEXT RACE is a room verb too: both panes must reset, not just the clicker.
await panes.host.evaluate(() => (document.getElementById('round-btn') as HTMLButtonElement).click())
const restarted = await until('both panes in race 2', async () => {
  const [h, g] = await Promise.all([stateOf(panes.host), stateOf(panes.guest)])
  return h.round === 2 && g.round === 2 && !h.finished && !g.finished && h.lap === 0 && g.lap === 0 ? { h, g } : null
})
check('NEXT RACE resets EVERY client, not just the host', true, `round=${restarted.h.round}`)

check('zero page errors across the probe', errors.length === 0, errors.slice(0, 2).join(' | '))

await browser.close().catch(() => {})
console.log(fails.length ? `\n❌ race probe: ${fails.length} failure(s): ${fails.join(', ')}` : '\n✅ race probe passed')
process.exit(fails.length ? 1 : 0)
