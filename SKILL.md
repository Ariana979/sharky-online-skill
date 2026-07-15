---
name: sharky-online
description: Build a free-form HTML game in Claude Code and publish it to sharky.gg with real platform multiplayer (accounts, rooms, server-ordered sync bus). Trigger when the user wants to make a game for sharky.gg, add sharky multiplayer to an HTML game, or publish/update a game on the platform.
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
   page headlessly. Start each game script with
   `if (typeof SharkyNet === 'undefined') return;` so it no-ops there — an
   unhandled rejection in the sim kills the room session. The build's sim
   gate enforces this (fails on leaked rejections / missing config).

## API (assets/sharky-net.js)

```js
const net = await SharkyNet.ready();
net.me()            // { id, isHost, room }
net.isHost()        // host = game owner's connection (start privilege); a live
                     // poll — real-page roles resolve async, seconds (gotcha 15c)
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
                     // bands: good = smoothed op RTT ≤1.1s & updates ≤1.8s
                     // fresh; critical = disconnected or world stale >3s.
net.connected()     // live link state; net.on('connection', ({kind}) => {})
                     // kind: open|closed|error|epoch — surface it in the UI:
                     // a silent stall is otherwise indistinguishable from
                     // "the game broke" (epoch = sim generation flip; the
                     // client resyncs itself when needed)
net.stats()         // { sent, applied, lastRttMs, relayRttMs, connected,
                     //   epoch, stateUpdates, ... }
```

## Workflow

Commands below run from your game's directory; `<skill>` stands for this
skill's base directory (printed at the top when the skill loads).

**1. Write the game** — free-form HTML in one file, using the API above.
Study `examples/cursor-arena.html` for the local-echo + ordered-apply pattern;
`examples/round-arena-3d.html` is the 3D live-presence variant (world-event
rounds, ghost lifecycle + out-state legibility, role-resolution-safe start).
Vendored libs: put `/*__VENDOR:three-0.161.0.global.min__*/` inside a
`<script>` tag and the build inlines `assets/vendor/<name>.js` — the
placeholder name carries NO `.js` suffix (`ls assets/vendor/` to see what
ships). Any `<name>.js` added to that directory inlines the same way — the
shipped list is just what's pre-bundled (an existing game's exact CDN build,
saved there, keeps its rendering byte-identical).
Converting an existing single-file game? `references/retrofit.md` maps its
time sources and state onto this seam.

**2. Build** (injects the runtime):
```bash
bun <skill>/scripts/build.ts --game my-game.html --title "My Game" \
    --min-players 2 --max-players 8 --out dist/index.html
```

**2.5 Deterministic checks (~35s)** — what the machines can assert on the fresh build:
```bash
bun <skill>/scripts/playtest-gate.ts --html dist/index.html                # smoke, ~10s
bun <skill>/scripts/playtest-gate.ts --html dist/index.html --two-client   # bus seam, ~25s
```
Smoke asserts zero page errors on the built bytes at one desktop viewport
(repaint is reported as a warning — static-by-design screens exist); in a
terminal-CLI session there is no preview tool, so smoke is the only render
check available there. `--two-client` runs two mock clients on one local
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
The gate finds a system Chrome/Edge by itself (`--chrome <path>` overrides;
a browserless Linux box needs `bunx playwright install chromium` once).

**3. Iterate locally** — offline mock room with identical ordering semantics
(two players side by side, no credentials needed):
```bash
bun <skill>/scripts/dev-serve.ts --html dist/index.html   # room at / (and /dev — same page)
```

**3.4 Author-time live play** — most bugs get caught here rather than in
the checks (measured across every lab run): exploratory play reaches the
taste-level issues no scripted check will, and real inputs — ramming
props, leaving the play area, mid-session restarts, input spam — are
exactly what happy-path drives and autopilots never produce and the first
thing a real player does. Any live preview tool (e.g. Claude Preview / a
browser) pointed at dev-serve lands inside the mock room already (`/` and
`/dev` are the same page; navigating away loses page context). dev-serve
prints a ready-to-paste launch.json snippet, and the room's parent page
exposes `__MOCK_ROOM__.snapshot()` — visible/phase/seq/players plus
per-frame errors/focus in one eval. The §2.5 checks assert seam
invariants and zero page errors; they do not evaluate feel — feel only
shows up in play. Environment fact: browsers freeze rAF and throttle
timers in hidden/background tabs — the room's top bar shows a live TAB
HIDDEN warning; a dead-looking game under a hidden tab is the instrument,
not the game.

**3.5 Filmstrip (multi-viewport motion frames)**:
```bash
bun <skill>/scripts/playtest-gate.ts --html dist/index.html --filmstrip    # 3 viewports × drive, ~90s
```
Renders a 10s turning + camera-drag drive into 8 frames per viewport
(desktop / wide-retina / mobile 390×844@3x) plus
`dist/playtest/filmstrip.html` — the only source of mobile/retina frames;
in a terminal-CLI session, or when no live preview is usable, these frames
are the only eyes available. If the game exposes
`window.__PLAYTEST__.focusScreenPos()` → normalized {x,y} of the player's
main object, it additionally asserts the focus stays in the central band
≥80% of samples. (Frames only verify what is compared against INTENT —
put a human eye on them.)

**4. Publish — only AFTER the user's acceptance.** When you would normally
call the game done, hand the user the dev-serve link **instead of
publishing**, and stop there until they confirm.
**New game — first publish** (you just built it; you know its look):
```bash
bun <skill>/scripts/publish.ts --html dist/index.html --title "My Game" \
    --min-players 2 --max-players 8 \
    --cover-description "actual scene, palette, render style (low-poly / pixel / cel-shaded / …), mood — 1–3 sentences"
# no stored session + no terminal? --request-code --email <addr> sends the
# code; then re-run with --verify-code <code> --email <addr>.
```

**Re-publish a code/logic change, look unchanged** (bug fix, tuning):
```bash
bun <skill>/scripts/publish.ts --html dist/index.html --title "My Game" \
    --min-players 2 --max-players 8 \
    --game-id <id>
# no --cover-description → an existing cover is kept as-is
# (a game with no cover yet still gets one backfilled server-side)
```

**Re-publish because the look changed** (new art / palette / scene):
```bash
bun <skill>/scripts/publish.ts --html dist/index.html --title "My Game" \
    --min-players 2 --max-players 8 \
    --game-id <id> \
    --cover-description "the NEW look — scene, palette, style, mood"
```

Publishing goes to the signed-in account via the platform import endpoint;
hosting = the permanent /play route. The cover is a generated 16:9 image —
server-side, best-effort, appears seconds after publish; no imposed house
style; the title is drawn into the art. A first publish always gets a
cover — the description decides whether it shows the real game or a
title-only guess; a re-publish regenerates only when a description is
passed (gotcha 17 has the symptom map). Every publish rewrites the whole
game row: title and min/max players come from THIS command each time.

Credentials: the first publish on a machine asks for the user's sharky.gg
account email and a 6-digit code sent to it (the email shown in their
sharky.gg account settings); the session then lives in
`~/.config/sharky-online/session.json`, auto-refreshes, and later publishes
are zero-prompt. Games land in that user's own account. The email comes
from the user, stated in this conversation — an email found in your
environment/context (the machine's login identity) is routinely NOT the
sharky.gg account email. publish hard-errors rather than accept a guessed
one (no `--email` + no terminal = error), and an address with no sharky.gg
account is rejected before any code is sent; `--create-account` lifts that
only after the user explicitly confirms they want a NEW account under that
email. No terminal for the code prompt? `--request-code --email <addr>`
sends the code and exits; re-run with `--verify-code <code> --email <addr>`
to sign in and publish in one go.

**5. Verify the real room** (automated, 2 guest clients, no token needed):
```bash
bun <skill>/scripts/room-test.ts --game-id <id>
```
Then open `https://sharky.gg/game/<id>` — the game sits in the owner's
account list; invite/guest join/room chrome all come from the platform.

**6. Online two-client dev loop** against the published game:
```bash
bun <skill>/scripts/dev-serve.ts --html dist/index.html --game-id <id>
```

## What Claude should do when driving this skill

- Keep the creative loop local (steps 1–3). The user plays before the world
  does: deliver the local play link, publish on their word (workflow step 4).
  When you do publish, announce it in one line; honor any request to stay
  local. Publishing is repeatable — same `--game-id` overwrites, links stay.
- Genre guidance: party/turn-based/casual/co-op fit the 400ms bus natively;
  for twitch genres implement gameplay-level prediction (the game owns its
  logic — that freedom is the point of this path).
- Lobby legibility: show the connected player count; when solo, tell the
  player friends join via the Invite link (see gotcha 15b — a fresh room
  otherwise reads as "multiplayer is broken"). `players()` carries each
  player's display_name (the shim's `initPlayer` fills it), so a named
  roster renders straight from it.
- Multiplayer QUALITY levers — read `references/hard-parts.md` before
  designing any real-time genre: §0 presence rig is the settled seam
  plumbing (self-echo/replay/throttle/ghost lifecycle/identity naming/lobby
  legibility — don't re-derive it); ghost soft-contact buys back interaction feel with
  zero authority cost; a `__SHARKY_RULES__` script buys server-arbitrated
  fairness (pickups, finishes, scoring) with the optimistic+reconcile
  pattern. Ghosting alone reads as "passable" — these levers push past it.
- room-test.ts is the only automated signal that the published room actually
  syncs (2 guest clients, no token) — its numbers are what the user hears at
  handoff.
- Read `references/gotchas.md` before debugging anything network-ish — every
  known failure mode is listed there with its cause.

## Known limits (v1, honest)

- **Hosting**: the platform `/play` route (deployed 2026-07-03) hosts the
  published single-file HTML permanently. Separate asset files still don't
  execute from storage (text/plain + nosniff) — inline everything (that's
  what the vendor mechanism is for). `--host preview` expires in ~30 min.
- **Credentials**: publishing signs in with the user's sharky.gg account
  email (OTP code) — an independent session chain that never touches their
  browser login. The OTP email must be the one the sharky.gg account settings
  show (Apple "Hide My Email" accounts: the relay address). The skill ships
  zero secrets; the embedded anon key is the public browser-bundle value.
  Operator direct-write mode exists behind an explicit `SHARKY_ENV_FILE`.
- **Restricted-egress sandboxes** (e.g. Claude Code on the web): the default
  domain allowlist blocks the platform, so publish/room-test die on their
  first call. publish.ts preflights and prints the exact domains to allow
  (`sharky.gg` incl. subdomains + `yhvgdxuwxyergytakxvn.supabase.co`);
  claude.ai/code takes them under environment settings → Network access.
  Session files live in the ephemeral container HOME, so each new web
  session re-verifies by email once — never point `SHARKY_SESSION_FILE`
  into the repo (that would commit login tokens).
- **Anti-cheat / hidden info**: the bus shim orders but does not judge. For
  server-side rules, replace the shim with game-specific authoritative
  callbacks (advanced mode — same contract as platform-generated games).
- Feed presence not wired yet (game appears in the owner's list; `in_feeds`
  stays false).
