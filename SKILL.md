---
name: sharky-online
description: Build a free-form HTML game and publish it to sharky.gg with real platform multiplayer (accounts, rooms, server-ordered sync bus). Trigger when the user wants to make a game for sharky.gg, add sharky multiplayer to an HTML game, or publish/update a game on the platform.
---

# sharky-online — free-form HTML games with sharky.gg multiplayer

Game logic AND rendering stay 100% in the user's HTML — any tech, any loop,
any style. This skill contributes exactly one thing: the **platform online
socket** (identity, rooms, a server-ordered op bus + shared KV) and the
publish pipeline. Everything here was verified end-to-end in production.

**Jurisdiction (read first)**: the skill owns that platform seam and nothing
else. Design, write, verify and tune the game exactly as you would WITHOUT a
skill — play it live, trust your taste, iterate freely. The scripts below
are plumbing for the seam, not a prescription for how to create or how to
feel-test; the only hard demand is the game contract (below), and build.ts
rejects violations of it at build time.

## Architecture (30 seconds)

The published page carries three injected pieces next to the user's game:
`bridge.js` (identity/room/relay), an **inert shim game config** (the
platform's server-side sim extracts it from the page HTML and runs it as the
room authority — it is a generic ordered-op bus, no gameplay), and
`sharky-net.js` (the API the game calls). Every client's ops are ordered by
the sim and broadcast back in state updates: ordered, loss-free,
~400ms round trip. Local echo makes it feel instant.

## Game contract (the ONLY constraints on the HTML)

1. Do not define `__DELTA_GAME_CONFIG__` and do not open your own sockets
   (build.ts rejects both).
2. All shared state goes through `SharkyNet` — send ops, consume the ordered
   stream; never trust unshared local state for outcomes.
3. Respect budgets: ops ≤2KB, sharky-net throttles sends to ≤15/s (coalesce
   inputs — send the latest cursor pos, not every mousemove); discrete
   must-arrive ops (finish/score/event) → `net.sendReliable`.
4. Multiplayer feel: echo the player's own input locally at once; apply
   everyone's ops in bus order (see examples/cursor-arena.html).
5. **Sim hygiene**: the platform sim vm-executes every inline script of the
   page headlessly. Wrap each game script in an async IIFE that returns
   early when `typeof SharkyNet === 'undefined'` (a bare top-level `return`
   is a SyntaxError) so it no-ops there — an unhandled rejection in the sim
   kills the room session. One exception: a `__SHARKY_RULES__` script
   carries NO guard — it exists to run in the sim (hard-parts §2). The
   build's sim gate enforces this (fails on leaked rejections / missing
   config).

## API (assets/sharky-net.js)

```js
const net = await SharkyNet.ready();
net.me()            // { id, isHost, room }
net.isHost()        // host = the connection that CREATED the room (start
                     // privilege — not tied to game ownership); a live
                     // poll — real-page roles resolve async, seconds
                     // (gotcha 15c)
net.start()         // host only: lobby -> playing
net.send(op)        // ordered bus; false when throttled/oversized (streams: fine)
net.sendReliable(op) // queues instead of dropping — discrete must-arrive ops
                     // (finish/score/world event); keep pose streams on send()
net.on('op', (op, {seq, uid, self, replayed, staleMs}) => {})  // authoritative
                     // order, everyone; replayed = log history to a (re)joiner;
                     // staleMs = skew-immune sender-time age (catch-up backlog)
net.setShared(k, v) // shared KV (≤4KB/value, ≤128 keys)
net.shared(); net.players(); net.phase(); net.on('phase'|'players'|'update', fn)
net.claim(op, cb)   // sendReliable + confirm when YOUR op returns through the
                     // ordered log (its bus position = the arbitration): play
                     // a pending animation now, reveal on cb — the round trip
                     // hides inside the suspense window. cb(null, {timedOut})
                     // after 30s without an echo.
net.quality()       // {tier: good|degraded|critical, rttMs, updateAgeMs} —
                     // freshness-first with hysteresis; tier changes also emit
                     // on('connection', {kind:'quality', tier}). Measured
                     // bands: good = smoothed op RTT ≤1.1s, updates ≤1.8s
                     // fresh & relay ping ≤0.9s; critical = disconnected
                     // or world stale >3s.
net.connected()     // live link state; net.on('connection', ({kind}) => {})
                     // kind: open|closed|error|epoch|quality — surface it in the UI:
                     // a silent stall is otherwise indistinguishable from
                     // "the game broke" (epoch = sim generation flip; the
                     // client resyncs itself when needed)
net.stats()         // { sent, applied, lastRttMs, relayRttMs, connected,
                     //   epoch, stateUpdates, ... }
```

Worked adoption snippets for the quality chip, claim pending-then-reveal,
and replay/staleness guard sit in
`references/hard-parts.md` §0.9 — they demonstrate; the semantics above
stay canonical.

## Workflow

Commands below run from your game's directory; `<skill>` stands for this
skill's base directory (printed at the top when the skill loads).

**1. Write the game** — free-form HTML in one file, using the API above.
For any game with live presence, START by copying `examples/skeleton.html`:
the invariant platform seam (sim guard, presence rig, round lifecycle + KV
mirror, lobby legibility, degrade chip, playtest hooks) assembled and kept
green against build + gates — replace everything marked TASTE freely;
change SEAM lines with the hard-parts fact they cite open.
`examples/cursor-arena.html` is the minimal local-echo + ordered-apply
read; 3D/three.js games: study `examples/round-arena-3d.html` — the same
seam assembled in a full scene (world-event rounds, ghost lifecycle +
out-state legibility, role-resolution-safe start).
Vendored libs: put `/*__VENDOR:three-0.161.0.global.min__*/` inside a
`<script>` tag and the build inlines `assets/vendor/<name>.js` — the
placeholder name carries NO `.js` suffix (`ls assets/vendor/` to see what
ships). Any `<name>.js` added to that directory inlines the same way
(name chars A-Za-z0-9._-; an unexpanded placeholder fails the build) — the
shipped list is just what's pre-bundled (an existing game's exact CDN build,
saved there, keeps its rendering byte-identical).
Converting an existing single-file game? `references/retrofit.md` maps its
time sources and state onto this seam.

**2. Build** (injects the runtime):
```bash
bun <skill>/scripts/build.ts --game my-game.html --title "My Game" \
    --min-players 2 --max-players 8 --out dist/index.html
```
`--smoke` chains the smoke render check onto the same invocation — the
one-command inner loop (build + render check, combined exit code).

**2.5 Deterministic checks** — what the machines can assert on the fresh
build. Cadence (two tiers): the per-edit inner loop is build + smoke, plus
`--two-client --seam-only` (~2s) after any change touching the SharkyNet
seam (ops, shared KV, phase/start flow); the full `--two-client` (artifact
frames) and `--filmstrip` run on the final build before first publish —
they are independent, launch them concurrently (per-mode `report-*.json`
files don't collide) — and again only after look/layout/mobile-affecting
changes. Long runs background well: two-client's verdict file is
consumable the moment `"seam"` lands (below); keep working while it runs.
```bash
bun <skill>/scripts/playtest-gate.ts --html dist/index.html                # smoke, ~7-10s
bun <skill>/scripts/playtest-gate.ts --html dist/index.html --two-client [--seam-only]  # bus seam
bun <skill>/scripts/playtest-gate.ts --html dist/index.html --filmstrip    # 3 viewports × drive, concurrent
```
`--two-client` writes `dist/playtest/seam-verdict.json` in phases:
`"running"` at start, `"seam"` once the hard asserts are decided (~2-3s —
the boot/KV waits are event-driven, scene-weight-insensitive), `"final"`
when the trailing artifact frames and any late page errors are in (~13-15s
measured on light 2D and vendored-3D builds; heavy scenes stretch the
artifact tail, not the seam; a crashed artifact phase still stamps a
terminal `"final"` with `aborted:true`). A backgrounded run is consumable
from that file as soon as `"seam"` lands. `--seam-only` exits right on the
seam verdict (~1-2s, stamps a terminal `"final"` with `seamOnly:true`) —
the inner-loop variant; the full artifact run (which also re-checks zero
page errors across the drive) stays the pre-publish gate.
Smoke asserts zero page errors on the built bytes at one desktop viewport
(repaint is reported as a warning — static-by-design screens exist); in a
terminal-CLI session there is no preview tool, so smoke is the fastest
render check available there (the filmstrip below is the other ready-made
check). `--two-client` runs two mock clients on one local
bus and asserts the seam invariants: both boot and receive state,
`players()` shows both on both sides, shared-KV writes cross both ways —
two clients probe the N-player bus, they don't imply a 2-player game. It
then presses the host pane's `#start-btn` (when present), briefly drives
both panes and writes `dist/playtest/two-client-playing.png` — the only
automated view of both clients mid-play (artifact for eyes, no assertion) —
then holds the host pane's rAF ~5s (timers keep firing, like a backgrounded
tab) and writes `host-frozen-pair.png` — both frames side-by-side with the
Δt label: world progression wired to one client's render loop shows up as a
guest countdown identical across the panes (the gate also warns when the
guest pane stays pixel-static through the freeze; the frames are for eyes,
no hard assertion).
The gate finds a browser by itself: system Chrome/Edge, playwright's own
registry, then known executable locations incl. a pre-provisioned
`PLAYWRIGHT_BROWSERS_PATH` build (`--chrome <path>` overrides; a truly
browserless Linux box needs `bunx playwright install chromium` once — the
gate prints exactly that when nothing is found).
`--filmstrip` drives the game for 10s (turns + camera drag) and frames it
at three viewports (desktop / wide-retina / mobile 390×844@3x →
`dist/playtest/filmstrip.html`) — the only ready-made mobile/retina
frames among the shipped checks (the viewports run concurrently: ~25-40s
full measured on 2D and vendored-3D builds; `--viewport mobile` alone
~18s — a scoped run can't see cross-viewport regressions and report.json
records it as scoped). The desktop eye is the live preview
when one exists; these frames are the ready-made eyes everywhere else. A
game exposing `window.__PLAYTEST__.focusScreenPos()` (normalized {x,y} of
the main object) also gets the central-band assert (≥80% of samples).
Frames only verify what is compared against INTENT — they carry no signal
until an eye reads them.

**3. Iterate locally** — offline mock room with identical ordering semantics
(two players side by side, no credentials needed):
```bash
bun <skill>/scripts/dev-serve.ts --html dist/index.html   # room at / (and /dev — same page)
bun <skill>/scripts/dev-serve.ts --game my-game.html      # SOURCE mode: authoring loop
```
SOURCE mode injects the runtime per request (same code path as build.ts),
so the authoring loop is edit → reload — no command between; a contract
violation renders as a loud 500 in the pane. The vm sim gate only runs in
build.ts — build before the §2.5 checks and publish.

**3.4 Author-time live play** — most bugs get caught here rather than in
the checks (consistently measured): exploratory play reaches the
taste-level issues no scripted check will, and real inputs — ramming
props, leaving the play area, mid-session restarts, input spam — are
exactly what happy-path drives and autopilots never produce and the first
thing a real player does. A browser pointed at dev-serve lands inside the
mock room already (`/` and `/dev` are the same page; navigating away loses
page context). The Claude Preview panel is different: it only attaches to
servers it spawns itself from `.claude/launch.json` — it cannot adopt an
already-running dev-serve. dev-serve prints a ready-to-paste snippet whose
port is per-project-hashed and never its own, so the panel's instance and a
manually-started one coexist; a hand-written config on 5199 (the manual
default) collides with exactly that. The room's parent page exposes
`__MOCK_ROOM__.snapshot()` — visible/phase/seq/players plus per-frame
errors/focus/env in one eval, and every mock pane carries
`__ENV_HEALTH__` {rafHz, visibility}. The §2.5 checks assert declared
invariants, and discrete outcomes — finish, winner, round restart — are
state-assertable in the mock room in seconds (hard-parts §0.9 has the
worked probe; it rides the game's own `__PLAYTEST__` hooks). That takes
the wall-clock out of one check class — taste and the real-input bug
classes above stay with play. Environment fact: browsers freeze rAF and throttle
timers in hidden/background tabs — the room's top bar shows a live TAB
HIDDEN warning; a dead-looking game under a hidden tab is the instrument,
not the game (`__ENV_HEALTH__.rafHz` reads 0 there once the next ~1s
sample lands, -1 before it — one probe separates a frozen tab from broken
sync).

**4. Publish — only AFTER the user's acceptance.** When you would normally
call the game done, hand the user the dev-serve link **instead of
publishing**, and stop there until they confirm.
```bash
bun <skill>/scripts/publish.ts --html dist/index.html --title "My Game" \
    --min-players 2 --max-players 8 \
    --cover-description "actual scene, palette, render style (low-poly / pixel / cel-shaded / …), mood — 1–3 sentences"
```
Re-publish = the same command + `--game-id <id>` (omitting it creates a
NEW game row and orphans the old link); omit `--cover-description` on a
re-publish to keep the existing cover — pass it only when the look
changed. Every publish rewrites the whole game row: title and min/max
players come from THIS command each time. The first publish on a machine
signs into the user's own sharky.gg account with an emailed 6-digit code —
the email must come from the user, stated in this conversation (an address
found in your environment is routinely NOT the account email; publish
hard-errors rather than accept a guess). Read `references/publishing.md`
BEFORE the first publish on a machine, for any credential / cover /
hosting / sandbox-egress question, and on any publish error.

**5. Verify the real room** (automated, 2 guest clients, no token needed):
```bash
bun <skill>/scripts/room-test.ts --game-id <id>
```
Launch it in the background the moment publish returns and compose the
handoff message while it runs — nothing else blocks on it, and its
RTT/sync numbers are the handoff payload: append them when the run lands
(typical runs ~15-30s; the first room after a fresh publish can ride a
~1min cold start, which the script retries through by itself).
Then open `https://sharky.gg/game/<id>` — the game sits in the owner's
account list; invite/guest join/room chrome all come from the platform.

**6. Online two-client dev loop** against the published game:
```bash
bun <skill>/scripts/dev-serve.ts --html dist/index.html --game-id <id>
```

## What the agent should do when driving this skill

- Keep the creative loop local (steps 1–3). The user plays before the world
  does: deliver the local play link, publish on their word (workflow step 4).
  When you do publish, announce it in one line; honor any request to stay
  local. Publishing is repeatable — same `--game-id` overwrites, links stay.
- Genre guidance: party/turn-based/casual/co-op fit the 400ms bus natively;
  in twitch genres the tax falls on player-to-player interaction — your own
  input echoes locally at once (untaxed), other bodies are reconstruction,
  not gameplay-level prediction (the measured boundary: hard-parts §1).
- Lobby legibility: show the connected player count; when solo, tell the
  player friends join via the Invite link (see gotcha 15b — a fresh room
  otherwise reads as "multiplayer is broken"). `players()` carries each
  player's `name` (the shim's `initPlayer` fills it from the platform's
  display_name), so a named roster renders straight from it.
- Multiplayer QUALITY levers — read `references/hard-parts.md` before
  designing any real-time genre, scoped by its top-of-file map: §0's
  presence rig ships pre-assembled in `examples/skeleton.html` (don't
  re-derive it — §0's facts say what each SEAM line protects); ghost
  soft-contact (§1) buys back interaction feel with
  zero authority cost; a `__SHARKY_RULES__` script (§2) buys server-arbitrated
  fairness (pickups, finishes, scoring) with the optimistic+reconcile
  pattern. Ghosting alone reads as "passable" — these levers push past it.
- room-test.ts is the only automated signal that the published room actually
  syncs (2 guest clients, no token) — its numbers are what the user hears at
  handoff.
- Debugging anything network-ish: match the symptom in the index at the top
  of `references/gotchas.md` and read that section — every known failure
  mode is listed with its cause. Read the file whole before a handoff, not
  per incident.

## Known limits (v1, honest)

- Hosting, credential, and sandbox-egress limits live with the publish
  workflow in `references/publishing.md` (single-file/inline hosting rule,
  OTP session chain, domain allowlists for restricted sandboxes).
- **Anti-cheat / hidden info**: the bus shim orders but does not judge. For
  server-side rules, replace the shim with game-specific authoritative
  callbacks (advanced mode — same contract as platform-generated games).
- Feed presence not wired yet (game appears in the owner's list; `in_feeds`
  stays false).
