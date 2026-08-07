// drive-probe.ts — is the kart actually driveable?
//
// The filmstrip showed a kart crawling at 18 km/h through a whole drive; a
// still frame cannot tell "pinned against a wall" from "this is how fast it
// goes". This samples speed and lap progress over time against the dev-serve
// mock room, which separates the two.
//
//   bun game/tools/drive-probe.ts --url http://127.0.0.1:5199/
import { chromium } from 'playwright-core'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const arg = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1] }
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
  for (const p of [pw && join(pw, 'chromium'), ...builds, '/usr/bin/chromium'].filter(Boolean) as string[]) {
    if (!existsSync(p)) continue
    try { return await chromium.launch({ headless: true, executablePath: p }) } catch {}
  }
  throw new Error('no chromium found')
}

const browser = await launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
await page.goto(URL, { waitUntil: 'domcontentloaded' })
const host = await (async () => {
  for (let i = 0; i < 100; i++) {
    const f = page.frames().find((x) => x.url().includes('p=1'))
    if (f && await f.evaluate(() => !!(window as any).__PLAYTEST__).catch(() => false)) return f
    await page.waitForTimeout(200)
  }
  throw new Error('host pane never booted')
})()

// speed/progress readout the probe needs but the game does not otherwise expose
await host.evaluate(() => {
  const P = (window as any).__PLAYTEST__
  ;(window as any).__SAMPLES__ = []
})
await host.evaluate(() => (document.getElementById('start-btn') as HTMLButtonElement).click())
for (let i = 0; i < 80; i++) {
  const s = await host.evaluate(() => (window as any).__PLAYTEST__.state())
  if (s.started) break
  await page.waitForTimeout(150)
}

const key = (type: string, k: string) =>
  host.evaluate(([t, kk]: string[]) => dispatchEvent(new KeyboardEvent(t as any, { key: kk })), [type, k])
const sample = async (t: number) => {
  const st = await host.evaluate(() => (window as any).__PLAYTEST__.state())
  const s = { t, kmh: Math.round(Math.abs(st.v) * 3.2), lap: st.lap, u: st.u, lat: st.lat, wall: st.wall, gas: st.gas }
  samples.push(s)
  return s
}
const samples: any[] = []

// phase 1 — full throttle, no steering. The circuit curves, so this ends in
// the wall on purpose: driving straight at a wall SHOULD cost speed.
await key('keydown', 'w')
let t = 0
for (let i = 0; i < 22; i++) { await page.waitForTimeout(400); t += 0.4; await sample(t) }
const openRoad = Math.max(...samples.map((s) => s.kmh))
const beforeSteer = samples[samples.length - 1]

// phase 2 — steer AWAY from the wall, throttle still held. This is the
// property that matters: a wall must cost speed, not end the race.
// Steering is only held long enough to peel off the wall — hold it for six
// seconds on a closed circuit and the kart simply U-turns, which reads as "no
// progress" for reasons that have nothing to do with the wall.
const away = beforeSteer.lat > 0 ? 'a' : 'd'
const phase2Start = samples.length
await key('keydown', away)
for (let i = 0; i < 4; i++) { await page.waitForTimeout(400); t += 0.4; await sample(t) }
await key('keyup', away)
for (let i = 0; i < 10; i++) { await page.waitForTimeout(400); t += 0.4; await sample(t) }
await key('keyup', 'w')

console.log('t(s)  km/h  lap      u    lat  wall  gas')
for (const s of samples.filter((_, i) => i % 2 === 0)) {
  console.log(`${s.t.toFixed(1).padStart(4)}  ${String(s.kmh).padStart(4)}  ${s.lap}  ${String(s.u).padStart(6)}  ${String(s.lat).padStart(5)}  ${s.wall ? 'YES ' : ' no '}  ${s.gas ? 'yes' : 'NO'}`)
}
const recovery = samples.slice(phase2Start)
const recovered = Math.max(...recovery.map((s) => s.kmh))
// forward progress, measured on the wrapped course coordinate
const du = recovery[recovery.length - 1].u - beforeSteer.u
const uMoved = ((du % 1) + 1.5) % 1 - 0.5
console.log(`\nopen-road peak=${openRoad} km/h  at wall=${beforeSteer.kmh} km/h  after steering away peak=${recovered} km/h  Δu=${uMoved.toFixed(3)}`)

const fails: string[] = []
if (openRoad < 140) fails.push(`open-road top speed too low (peak ${openRoad} km/h)`)
if (recovered < 110) fails.push(`no recovery after wall contact (peak ${recovered} km/h once steering away) — a graze ends the race`)
if (uMoved < 0.05) fails.push(`no forward progress after wall contact (Δu=${uMoved.toFixed(3)}) — the kart is wedged`)
if (beforeSteer.kmh > openRoad * 0.85) fails.push(`riding the wall (${beforeSteer.kmh} km/h) is barely slower than the racing line (${openRoad} km/h) — the wall is a rail`)

await browser.close().catch(() => {})
console.log(fails.length ? `\n❌ drive probe: ${fails.join('; ')}` : '\n✅ drive probe passed')
process.exit(fails.length ? 1 : 0)
