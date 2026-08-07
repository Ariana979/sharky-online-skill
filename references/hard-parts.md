# Hard parts, by genre — patterns that buy back multiplayer quality

The platform taxes exactly ONE thing: **player-to-player interaction density**
(the ~400ms ordered bus can't arbitrate real-time contact). Own-car feel,
visuals, audio, and solo content are untaxed — spend freely there. These
patterns claw back the taxed part. Use them; don't reinvent them mid-build.

Map — read the sections your build touches:
- **§0** presence rig: eight bus facts + the degrade contract — any game
  showing remote players (turn-based/async games skip it, per §0's note);
  `examples/skeleton.html` ships this rig pre-assembled and gate-verified.
- **§0.9** adoption skeletons: quality chip, claim pickup, replay guard,
  win-path probe — worked snippets for those four surfaces.
- **§1** ghost soft-contact, shove/impulse ops, the settlement op — any
  genre where players touch.
- **§2** `__SHARKY_RULES__` server arbitration — outcomes that must be fair
  under mixed latency (contested pickups, photo finishes, scoring).
- **§2.5** visual affordance: solid props + room-level verbs — every game.
- **§3** what not to fight — every real-time design.

## 0. The presence rig — eight bus facts every live-presence game handles

These follow from the transport itself (ordered log with replay, ≤15/s
throttle, ~400ms round trip), not from any genre — every game that shows
remote players re-derives the same answers (~200 lines each, measured
across three independent builds). The mechanics below are settled; the
entity style, interpolation feel, and all visuals remain entirely yours.
(Games with no live presence — turn-based, async — skip this section.)

1. **Self-echo**: your own ops come back through the ordered log.
   `if (meta.self) return` — you already echoed locally.
2. **Replayed history**: the log replays to (re)joiners — `meta.replayed`
   marks those ops. Streams carry "now" — skip them; world-*event* ops are
   the opposite: replay IS how latecomers catch up. A second staleness axis:
   a page frozen in the background drains its buffered updates in a burst on
   return — `meta.staleMs` (skew-immune sender-time age; offsets cancel,
   only clock rates matter) marks that backlog, so skipping stale stream ops
   lands the ghost at the LIVE position instead of replaying the missed
   trajectory. (Raw `Date.now() - op.__t` was the old cross-device trap:
   device clocks skew by seconds.) And the log is a transport WINDOW,
   not an archive: it holds ~96 ops, so a 10Hz pose stream evicts a
   discrete event in seconds — a joiner past the window replays 96
   poses and zero of the events that built the current phase (measured
   twice: a story retrofit lost every beat; live 2026-07-20 a late
   joiner missed the round-start op and sat locked out until the next
   transition, a wait that spans the rest of the round). Phase state a
   latecomer cannot play without — round number, the live deadline,
   the round's seeded roster (presence stays fact 4's
   `net.players()`) — is therefore ALSO mirrored to shared KV
   (`net.setShared`) at each transition: a joiner reconciles from KV,
   and the log replay only back-fills the recent tail. The mirror
   guards against window EVICTION, not room rebirth: KV lives exactly
   as long as the sim room and a rewarm starts empty (log included),
   so connected clients re-mint state at the next transition.
3. **Throttle drops**: `send()` drops when over budget — coalesce streams
   (latest pose, not every frame); discrete must-arrive ops (finish, score,
   world event) go through `net.sendReliable()` instead. Host the stream on
   a TIMER, not the render loop: hidden/occluded pages freeze rAF to 0Hz
   but only throttle timers (~1/s at first, down to ~1/min under prolonged
   backgrounding), so a covered window heartbeats instead
   of going silent (single-person two-window testing hits this constantly).
   In the mock room the freeze is readable in-band: the starved pane's
   `__ENV_HEALTH__.rafHz` reads 0 and the parent `snapshot()` reports
   `visible:false` — a ghost that stops moving under those readings is the
   tab, not the bus (measured: the misread costs minutes of forensics on a
   healthy build; the one-probe read costs seconds). The freeze also stops
   YOUR OWN physics when it lives in the render loop: network events still
   fire while hidden, so received impulses accumulate without integrating —
   to everyone else you are a statue that cannot be knocked out, which then
   replays the backlog on return (live-play measured 2026-07-17). A coarse
   timer step decays with the cadence itself (~1/min when the backgrounding
   is prolonged, per above), so the arm that survives is a catch-up
   integration on `visibilitychange` with the big dt clamped — the timer
   step only softens short hides.
4. **Ghost lifecycle**: map `uid → entity`; create on first op, steer toward
   the latest pose each frame — but SNAP when the target is far (a page
   unfrozen after backgrounding drains its buffered updates in a burst;
   without a snap threshold the ghost visibly replays the missed trajectory
   instead of standing at the live position). Dead-reckoning by the pose's
   velocity needs the mirror guard: a hidden sender keeps broadcasting a
   frozen pose (+stale velocity) at timer cadence — unclamped extrapolation
   slides the ghost out and yanks it back once a second (rubber-banding,
   live-play measured 2026-07-17). Clamp the extrapolation age, and freeze
   it entirely when the sender's cadence collapses — that catches a
   heartbeating hidden page; the ~10s full-silence idle mark below catches
   the rest. EXISTENCE comes from the
   server roster, not stream cadence: `net.players()` drops real leavers
   (relay grace ~5s) while an idle/backgrounded player stays listed — render
   them STANDING at the last pose (mark idle after ~10s of silence); dispose
   shortly after they leave the roster, plus a long-silence backstop
   (~150s; mock rosters are sticky). Background pages get timers
   throttled to as little as 1/min — the backstop sits above that
   heartbeat, and vanishing on silence turns every afk player into a
   "bug report".
5. **Lobby legibility**: show the connected count; when solo, say friends
   join via the Invite link (gotcha 15b — a fresh room otherwise reads as
   "multiplayer is broken").
6. **Shared world clock + platform-relative riders**: moving world objects
   (platforms, hazards, timed doors) must animate on ROOM time, not
   `performance.now()` — the local epoch is each page's load moment, so
   every client would render the same mover at a different phase.
   `state.clock` (whole-second steps; advances only while the room is
   PLAYING — stalled in lobby/result) rides every `'update'`;
   anchor NTP-style — offset = MAX(sample) ever seen (the fastest-delivered
   packet is closest to true room time), advance purely on local monotonic
   time, re-baseline only on a large backward move (sim rewarm). A stall a
   client witnesses becomes that client's permanent forward bias under an
   ever-MAX anchor (skew = difference in witnessed stall; live-measured
   2026-07-21: a 12s lobby stall → a steady ~10s cross-client skew).
   Re-anchoring on every arrival injects network jitter into the world
   as a visible once-a-second lurch. And replicate
   RIDERS platform-relative (mover id + local offset in the pose): a frozen/
   backgrounded page stops simulating, so its broadcast absolute coords go
   stale — receivers re-base the offset onto their own shared-clock mover
   and the rider stays glued to it on every screen regardless of the
   sender's cadence. The mock rigs carry the same clock: dev-serve
   advances `state.clock` by wall-clock elapsed; the playtest shim
   ticks +0.15s every 150ms (the real sim steps in whole seconds).
   There is no built-in
   room-clock helper — games read it off `'update'`.
7. **Identity display**: player names live in `net.players()[uid].name`
   (platform nicknames; they arrive/update via the `'players'` event —
   re-label ghosts when it fires). `op.__tag` / `net.tag` is a transport
   tag, NOT identity — never show it. Mock rooms only have placeholder
   identities, so a wrong name source is INVISIBLE offline: check names in
   the real room (room-test asserts delivery, not display — a session
   shipped transport tags as player names and no apparatus caught it).
   Names are also racy and presence-scoped (live-play measured
   2026-07-17): a peer's first pose can beat the roster entry carrying
   their nickname, and `players()` drops a client when they leave — so a
   canvas-texture label keeps whatever the lookup returned at draw time
   (raw-uid fragments read as garbage) and needs an explicit redraw on
   `'players'`; anything that outlives presence (scoreboards, tallies)
   needs a uid → name cache.
8. **Deadlines & the two clocks**: `state.clock` (fact 6) advances on the
   server and freezes for no page; rAF/`performance.now()` are
   page-lifecycle clocks. A hidden page freezes rAF to 0Hz while its timers
   keep beating, so a stream can stay alive while the simulation feeding it
   is dead — transport liveness ≠ simulation liveness (measured: a
   backgrounded driver's ~1Hz stream kept suppressing takeover while every
   countdown in the room stood still; a progress counter inside the stream
   is the observable that tells the two apart). A room-wide deadline written
   as an absolute shared-clock time T is recomputable on any client at any
   moment; written in page-clock terms it dies with its page. One edge
   on "recomputable": the shared-clock anchor is not monotonic — it
   re-bases BACKWARD when the sim room is reborn (fact 6's rewarm
   branch; idle rooms are recycled, so long sessions cross clock
   domains), stranding a T minted before the re-base in the dead
   domain's future. A readout re-derived per frame shows the yank and
   heals once the next T lands (it holds no stuck state); a one-shot
   transition gated by a live `now >= T` check un-fires — GO re-locks
   input mid-round, a timecap freezes, the room deadlocks
   (production-measured 2026-07-20; none of five audited
   builds latched by design) — and elapsed-time-derived quantities
   (a shrinking arena) run backward. What survives: a transition
   LATCHES the first time it fires (state, not a re-check), elapsed
   time keeps a monotonic high-water mark, and a T arriving via replay
   gets a domain check — a past T lands latecomers on the
   already-advanced world, trusted verbatim; a far-future one is
   re-derived locally (a stranded T otherwise locks every joiner).
   Driver-private decisions are fine (what happens is game rules) — once
   published as a reliable event with params/seed/deadline, execution no
   longer depends on the publisher's page: seed/param-derivable content
   unfolds identically everywhere with zero further traffic, and only
   non-derivable continuous simulation (live AI, contact physics) needs a
   stream plus a liveness rule.

```js
const ghosts = {};                                   // uid -> { entity, target, lastSeen }
net.on('op', (op, meta) => {
  if (op.k === 'pose') {                                     // stream op
    if (meta.self || meta.uid === net.me().id) return;       // 1: own stream already echoed
    if (meta.replayed || meta.staleMs > 3000) return;        // 2: history / catch-up backlog
    const g = ghosts[meta.uid] ||= { entity: makeGhostEntity(meta.uid) }; // 4
    // name it from net.players()[meta.uid]?.name, NOT op.__tag — see 7
    g.target = op; g.lastSeen = performance.now();
  }
  // world-event ops invert BOTH rules: the sender applies its own event from
  // the bus as well (a top-of-handler self-skip leaves the clicker in a
  // private round), and replayed events are consumed — see 2               // 1+2
});
function stepGhosts(dt) {                                     // 4: per frame
  for (const [uid, g] of Object.entries(ghosts)) {
    steerToward(g.entity, g.target, dt);   // lerp / dead-reckon — feel is yours
    const here = !!net.players()[uid];     // 4: existence = server roster
    g.entity.visible = here;               //    (afk ≠ gone; silence only stales motion)
    const silent = performance.now() - g.lastSeen;
    if ((!here && silent > 5000) || silent > 150000) { disposeEntity(g.entity); delete ghosts[uid]; }
  }
}
setInterval(() => net.send({ k: 'pose', ...latestPose }), 90); // 3: timer-hosted lossy stream
net.sendReliable({ k: 'finish', ms });               // 3: results must arrive
```

`makeGhostEntity` / `steerToward` / `disposeEntity` are deliberately not
provided — that's the creative half.

**Degrade contract** (`net.quality()` / `on('connection', {kind:'quality'})`,
tiers change with ~1.5s-in/~2s-out hysteresis so UI can bind directly):
- `degraded` (smoothed op RTT >1.1s, updates 1.8–3s stale, or relay ping
  avg >0.9s): widen
  interpolation buffers, damp cosmetic motion, lengthen claim suspense
  windows, show a subtle ⚠.
- `critical` (disconnected, or the world >3s stale): reconnect notice,
  gate hard-commit inputs, keep simulating locally.

## 0.9 Adoption skeletons (worked reference)

Worked reference for the quality, claim, replay-guard, and win-path-probe
surfaces. The snippets demonstrate; canonical semantics for the first
three stay in the SKILL.md API block and sharky-net.js — the probe's
semantics live in the Playwright API and the game's own `__PLAYTEST__`
contract. The ASSEMBLED version of the §0 rig plus the round lifecycle
(reliable round op + idempotence guard + KV mirror + round-stamped result
latch + host restart) is `examples/skeleton.html` — copy it instead of
transcribing these snippets when starting a new game; they stay here as
the reference for what each seam line protects.

**Quality chip + disconnect toast** — display the tier or the EMA
(`q.rttMs`), not raw single samples: a healthy long-haul link brushes the
p95 (~780ms) routinely, so a raw `lastRttMs` readout cries wolf on every
jitter spike.

```js
setInterval(() => {
  const q = net.quality();   // {tier, rttMs (EMA), updateAgeMs, connected}
  hudChip.textContent = q.tier === 'good' ? '🟢'
    : q.tier === 'degraded' ? '🟡 unstable link' : '🔴 connection lost';
}, 1000);
net.on('connection', (e) => {
  if (e.kind === 'closed' || e.kind === 'error') showToast('connection lost — reconnecting…');
});
```

**Contested pickup via claim** — the ordered log is the referee: the FIRST
claim op for an id (in bus order) wins, and everyone's op-apply marks it
taken. Ordering fact at confirm time: a LOSING claim sees the winner
already written into state (their earlier entry applied first); a WINNING
claim's own entry applies right after the confirm fires — so the reveal
test is "unset or mine", not "mine". The ~400ms round trip hides inside
the grab animation.

```js
// in the shared op-apply path (bus order, same for everyone, replay included):
//   if (op.k === 'grab' && !state.taken[op.id]) state.taken[op.id] = uid;
startGrabAnimation(coin);                        // local, instant
const queued = net.claim({ k: 'grab', id: coin.id }, (op) => {
  if (!op) return rollbackGrab(coin);            // 30s timeout — link died
  const winner = state.taken[coin.id];           // set only if someone beat you
  resolveGrab(coin, !winner || winner === net.me().id);
});
if (!queued) rollbackGrab(coin);                 // could not even queue
```

(Rules-script variant: when a `__SHARKY_RULES__` script owns the item,
reconcile from `net.game()` instead of local state, with a timeout rollback
that revives the item when it is neither taken nor pending.)

**Replay/staleness guard** — split state from effects. Streams (pose) skip
replayed wholesale; events & KV must APPLY during replay (that is how a
joiner rebuilds the world) — only one-shot effects are gated:

```js
net.on('op', (op, meta) => {
  if (op.k === 'pose') {                         // stream: ephemeral — full gate
    if (meta.self || meta.replayed || meta.staleMs > 3000) return;
    return updateGhost(op, meta);                // (self = your own echo; stale =
  }                                              //  catch-up backlog, land LIVE)
  applyToState(op);                              // events: every op, replay included
  if (meta.self || meta.replayed || meta.staleMs > 3000) return;
  playEffects(op);                               // sounds/flash/toasts: live only
});
```

**Win-path probe (state-jump, not playthrough)** — the round lifecycle
(finish → the same winner on every client → restart resets everyone) is
a discrete-outcome seam: it asserts in seconds against the dev-serve mock
room through the game's own `__PLAYTEST__` hooks (the `focusScreenPos`
opt-in family — read hooks ship in the build harmlessly; a state-WRITING
hook like teleport takes a mock gate, so it never ships live). A
real-time playthrough proves one extra thing — the course is beatable;
a static geometry check against the game's movement envelope (max jump
arc, speed) proves reachability of a static course without the
wall-clock.

```js
// game side: the read hook ships; the write hook exists only in the mock room
window.__PLAYTEST__ = { state: () => ({ phase, round, winner }) };
if (window.__SHARKY_LOCAL_BUS__)                  // present only under the mock harnesses
  __PLAYTEST__.teleport = i => respawnAt(i);      // (dev-serve / gate) — never on the live page
// probe side (playwright-core; dev-serve panes carry ?p=1 / ?p=2, no name attr)
const host  = page.frames().find(f => f.url().includes('p=1'));
const guest = page.frames().find(f => f.url().includes('p=2'));
await host.evaluate(i => __PLAYTEST__.teleport(i), LAST_STAGE); // args cross explicitly —
await host.evaluate(() =>                                       // evaluate carries no closures
  dispatchEvent(new KeyboardEvent('keydown', { key: 'w' })));   // one real input crosses the line
await until(async () => {
  const h = await host.evaluate(() => __PLAYTEST__.state());
  const g = await guest.evaluate(() => __PLAYTEST__.state());
  return h.winner && g.winner && sameState(h, g); // a winner EXISTS on both panes — and agrees
});
await host.evaluate(() => dispatchEvent(new KeyboardEvent('keyup', { key: 'w' })));
// then the host restart: round+1 and a reset world on BOTH panes — the
// class where a "start" that only cleared the clicker's own overlay shipped
```

## 1. Ghost soft-contact (zero platform involvement)

Remote players are dead-reckoned ghosts. You still get contact FEEL by
resolving collisions **locally only** — each client moves its own object
out of ghost overlap; nobody arbitrates, small divergence is fine for
casual play, and your own object stays locally authoritative so nothing
conflicts.

Measured (2026-07-07, kart racer built from the velocity-spring
snippet an earlier revision of this file carried): a velocity-only
nudge is imperceptible at
driving speed — peak push ≈3% of vehicle speed across the ~0.08s overlap
window reads as driving straight THROUGH the other player. Position
resolution (clamp yourself out of the overlap, exactly like a wall hit)
is the form that feels solid. Ghost poses lag ~0.4–0.5s behind the
remote's true position, so this is casual-fair rather than esports-exact
— the same trade the big kart games ship online.

```js
for (const uid in ghosts) {                        // per frame, per ghost — any player count
  const g = ghosts[uid], dx = me.x - g.x, dz = me.z - g.z;
  const d = Math.hypot(dx, dz), R = MY_R + GHOST_R;
  if (d > 1e-4 && d < R) {
    me.x = g.x + (dx / d) * R;  me.z = g.z + (dz / d) * R;  // clamp out, wall-style
    const vn = (me.vx * dx + me.vz * dz) / d;               // kill inward velocity
    if (vn < 0) { me.vx -= (dx / d) * vn; me.vz -= (dz / d) * vn; }
    bumpFeedback();                                 // shake/sfx — the point is feel
  }
}
// each client clamps ITSELF only — symmetric on every peer, zero authority conflict
// bonus: slipstream = speed boost when closely trailing a ghost's heading
```

Clamping stops interpenetration — it moves only YOU. No momentum crosses
to the other body: the clamp kills your own inward velocity, and pose
replication never carries your push, so a "shove" built from clamps
alone never lands. When the design needs your push to MOVE the other
player (sumo shoves, tackles, bumps that score), the impulse crosses the
wire as an op: the sender detects the contact and sends the impulse, the
receiver applies it to its own body — ownership stays local, still
nobody arbitrates positions. A reliable op — gated like any one-shot
effect (`meta.replayed`, so rejoin replay doesn't re-shove), round-stamped,
rate-limited per victim — covered it in ~15 lines (measured 2026-07-17,
sumo arena build).

Two pipeline consequences (live-measured 2026-07-17/18). First,
physics: an ADDED impulse is eaten by the victim's own momentum — in
a mutual ram, (impulse − closing speed)/friction can be near zero, so
the knockback barely exists. A knockback that must read has to SET
velocity at op arrival on the victim: v' = v − (v·n̂)n̂ + |J|n̂; real
displacement becomes impulse/friction regardless of approach speed.
Second, visibility: every other screen sees the shove MOVE the victim
only through the victim's own pose stream, throttled ~100ms and a
relay RTT behind (~0.5–1s live) — at contact time there is nothing
true a screen can move the victim's ghost with. Hit feedback that
carries no positional claim fires at the contact frame on the
detecting screen and at op arrival elsewhere — arriving truth cannot
contradict it; the build that had feedback only at op arrival, never
on the detecting screen, read there as hits doing nothing
(live-measured). One measured artifact on the victim's screen: the
knockback lands at op arrival while the attacker's ghost still
renders at a stale pre-contact pose, so it fires visibly off empty
air. The fix (measured 2026-07-18): a bounded snap of the
attacker's ghost to just-touching — the victim's position minus the
contact normal × the sum of the two radii — moving the rendered
transform AND the steer target (the latest-pose target) together,
since steering alone rubber-bands the snap back. Physics keeps
reading pose-stream positions throughout: contact detection or
clamps fed from a visually displaced render breed phantom contacts
that re-trigger and feed back (headless-harness measured,
2026-07-18). Across four live rounds of alternatives, what survived
claims no position, or only a KNOWN point at a KNOWN event — like
that snap. None of this is adjudicable in a mock room: at near-zero
RTT good and bad latency handling render identically; only the live
relay separates them — four consecutive builds shipped such
artifacts straight past green two-client gates.

One settlement fact (two builds carried holes of this family; found
in code audit, not yet reproduced live): every screen judges its OWN
body live but every other body through throttle-thinned ghost poses
~0.5–1s behind — and the decisive pose can be dropped at the sender
— so a verdict derived from what each screen currently sees can
settle on different winners in a photo finish. A single op in the
shared ordered log reads identically everywhere: the client that
detects ITS OWN loss sends one reliable, round-stamped `result` op
naming the winner, and every screen — sender included — latches the
first result per round (rounds count up, never reset — a replayed
result then cannot claim a fresh round); the faller sees its own
defeat an op echo later (~400ms). This op buys AGREEMENT; when the
contest is fairness between near-simultaneous claimants (who acted
first under mixed latency), that arbitration lives in §2's rules
script.

## 2. Authoritative rules script (`__SHARKY_RULES__`)

For outcomes that MUST be fair — first-come pickups, photo finishes,
scoring — ship a **pure-logic rules script** on the page (§1's result
op buys agreement; this buys the RIGHT winner under mixed latency):

```html
<script>
/* PURE logic: no DOM, no SharkyNet, deterministic. Runs BOTH in the
   platform sim (authoritative) and locally (optimistic preview). */
window.__SHARKY_RULES__ = {
  init(game) { game.ms = 0; game.pickups = {}; game.score = {}; },
  onTick(game, dt) { game.ms += dt * 1000; /* respawns, timers */ },
  onOp(game, op, uid) {
    // Fair first-claim under mixed latencies: raw bus order hands every
    // contested pickup to the lowest-RTT player. Arbitrate on sender time
    // instead — a later-ARRIVING claim may still win if it was SENT
    // earlier, within an 800ms decision window (≈p95 RTT). __t is the
    // sender's wall clock and nothing here can clamp it (onOp gets no
    // arrival time): the window caps WHICH contests a skewed or backdated
    // clock can steal — photo finishes only — not WHO wins inside them.
    if (op.k !== 'claim') return;
    const t = Number(op.__t) || 0;              // sharky-net stamps __t on send
    const cur = game.pickups[op.id];
    if (!cur) {
      game.pickups[op.id] = { uid, t, openUntil: game.ms + 800 };
      game.score[uid] = (game.score[uid] || 0) + 1;
    } else if (game.ms <= cur.openUntil && t && cur.t && t < cur.t) {
      game.score[cur.uid] -= 1;                 // photo-finish reversal
      game.score[uid] = (game.score[uid] || 0) + 1;
      cur.uid = uid; cur.t = t;
    }
  },
};
// Client side: pair with net.claim(op, cb) — play the grab animation as
// "pending" immediately, reveal the outcome when cb fires (and reconcile
// against net.game() in case a photo-finish reversal landed).
</script>
```

- The build's shim delegates OP/tick to it; rules state lives in
  `state.game` and reaches every client via `net.game()` (~400ms).
- **Pattern: optimistic + reconcile.** Apply the same rules locally the
  moment you send the op (instant feedback), then reconcile from
  `net.game()` — if the sim says someone else won the claim, roll back
  your local effect. Same code both sides = no drift in logic.
- Hygiene: the script must NOT carry the `typeof SharkyNet` guard (it must
  run in the sim), must not touch DOM/timers, keep state JSON-serializable
  and small (it rides every state_update).
- In mock rooms (dev-serve / gate) sharky-net runs the rules locally —
  ops in bus order, `onTick` on the mock state cadence — so `net.game()`
  behaves the same offline (timing frame-coarse, ~150ms).

## 2.5 Visual affordance: solid-looking props must act solid

Players WILL drive/walk into everything on screen. Anything with visual
mass either gets a collider or lives out of reach — pass-through solids
read as broken (real playtest report). Static props are trivial:

```js
// registration (at creation): OBSTACLES.push({ x, z, r: 0.9 })
// resolution (per physics step): push-out + impact-angle speed loss
for (const o of OBSTACLES) {
  const dx = me.x - o.x, dz = me.z - o.z, rr = o.r + MY_R, d2 = dx*dx + dz*dz;
  if (d2 >= rr*rr || d2 < 1e-6) continue;
  const d = Math.sqrt(d2), nx = dx/d, nz = dz/d;
  me.x = o.x + nx*rr; me.z = o.z + nz*rr;                    // never inside
  const impact = Math.max(0, -(fwdX*nx + fwdZ*nz));          // 1 = head-on
  me.v *= 1 - 0.75 * impact;                                 // hit feel
}
```

(Intentional pass-through — top-down puzzles — is fine when the
LOOK says so. The principle is affordance consistency, not "physics
everywhere".)

The same law covers **room-level verbs**: a control that LOOKS shared — a
start button, a countdown, a "new round" — acts on the ROOM
(`net.start()` / shared state) or reads as broken: a race-start button that only
dismissed the clicker's own intro overlay read as "start sync is broken" to
the other player (real two-player report).

## 3. What NOT to fight

- Don't build peer-to-peer physics consensus over the bus — 400ms makes it
  rubber-band garbage. Ghosts + local feel + rules arbitration is the
  correct trio.
- Don't hide latency with lockstep waits — never block the local loop on a
  bus confirm.
