# Sharky Speedway

A 2–8 player 3D kart racer built on the **sharky-online** skill (this repo) —
three laps of a neon night circuit, real platform multiplayer over the
server-ordered sync bus.

```
game/
  sharky-speedway.html          the game — one free-form HTML file
  tools/pack-assets.mjs         GLB → inlinable vendor file (single-file hosting)
  tools/race-probe.ts           win-path probe: finish / flag / restart
  tools/drive-probe.ts          drive-feel probe: throttle, wall cost, recovery
  asset-sourcing-plan.json      3d-assets sourcing gate (confirmed)
  animation-plan.json           frozen action plan (all runtime-procedural)
  regeneration-plan.json        asset run plan
  public/regeneration.html      live asset progress page
  dist/index.html               built page (git-ignored; rebuild below)
```

## Build, play, check

```bash
# from the repo root
bun scripts/build.ts --game game/sharky-speedway.html --title "Sharky Speedway" \
    --min-players 2 --max-players 8 --out game/dist/index.html --smoke

bun scripts/dev-serve.ts --html game/dist/index.html      # two-pane mock room

bun scripts/playtest-gate.ts --html game/dist/index.html --two-client
bun scripts/playtest-gate.ts --html game/dist/index.html --filmstrip
bun game/tools/race-probe.ts   --url http://127.0.0.1:5199/
bun game/tools/drive-probe.ts  --url http://127.0.0.1:5199/
```

## Controls

`W`/`↑` throttle · `S`/`↓` brake · `A`/`D` or `←`/`→` steer · `Shift` drift.
On a phone, touch anywhere for throttle and touch the lower left/right half to
steer.

## How the multiplayer is wired

Everything shared crosses `SharkyNet`; nothing shared is inferred from local
state. The seam follows `references/hard-parts.md`:

- **Pose stream** — the latest pose on a 90ms *timer* (never per frame, never
  in the render loop). Own input echoes locally at once; other karts are
  reconstruction.
- **Ghosts** — created on first op, steered toward the latest pose, snapped when
  far (catch-up bursts), existence taken from `net.players()` rather than stream
  cadence, disposed on roster drop with a long-silence backstop.
- **Contact** — each client clamps *itself* out of ghost overlap, wall-style
  (§1: a velocity nudge is imperceptible at driving speed). Trailing a ghost
  closely in its heading gives a slipstream.
- **Shared clock** — the countdown, race timer and lap times are anchored to
  `state.clock` (MAX-sample anchor, advanced on local monotonic time,
  re-baselined only on a sim rewarm). Transitions latch and never un-fire.
- **Race lifecycle** — a race is a room verb: the host publishes one reliable,
  round-stamped event carrying the absolute start time and grid order, mirrored
  to shared KV so a joiner past the ~96-op log window rebuilds it.
- **Arbitration** — a `__SHARKY_RULES__` script runs in the platform sim and
  decides the two things that must not diverge: contested crystal pickups
  (first claim by *sender* time inside an 800ms window) and the finishing order
  (ranked on shared-clock race time, not arrival order). Clients preview
  optimistically and reconcile from `net.game()`.
- **Chequered flag** — 25s after the winner's time the race ends for everyone,
  derived from the finish list every client already has. Without it a trailing
  player never reaches the results screen.

## 3D Asset Pipeline

Asset work runs through the **3d-assets** skill. The sourcing gate was confirmed
and frozen in `asset-sourcing-plan.json`; `derive-asset-plans.mjs` produced
`regeneration-plan.json`, `animation-plan.json` and
`asset-generation-request.json`. Three slots were planned, all `generate_new`:

| slot | role | kind | route | animation |
| --- | --- | --- | --- | --- |
| `neon-kart` | player | vehicle | `gemini_reference` → `tripo` | runtime procedural (wheel spin, body roll) |
| `boost-crystal` | collectible | prop | `tripo` | runtime procedural (hover + spin) |
| `track-barrier` | hazard | prop | `tripo` | runtime procedural (impact shake) |

No character or creature is involved, so nothing needs rigging or retarget
clips — every action above is runtime motion, and `animation-plan.json` records
them as `source: "procedural"` rather than as Tripo clips.

**Current state: GLB generation is blocked upstream.** Every route
(`gemini_reference`, `tripo`, `auto`) fails inside the asset service's image
stage with `BabelArk image generation failed (400): invalid size '1:1':
expected WIDTHxHEIGHT`. That is a server-side provider mismatch — no client
parameter reaches it. The live gap review is in `animation-plan-progress.md`
and `public/regeneration-status.json`.

The game therefore ships on its **primitive fallbacks**, which the skill
prescribes for exactly this case, and the HUD says `ART primitive` so the
substitution is never silent. The GLB path is fully wired and waiting:

```bash
# when the asset service recovers
cd game
node ~/.claude/skills/3d-assets/scripts/game-assets-mcp.mjs generate --cwd . \
  --params "$(cat asset-generation-request.json | ...)"   # ids/prompts as planned
node tools/pack-assets.mjs --cwd .                        # GLB → vendor data: URIs
cd .. && bun scripts/build.ts --game game/sharky-speedway.html \
  --title "Sharky Speedway" --min-players 2 --max-players 8 --out game/dist/index.html
```

`pack-assets.mjs` reads `asset_manifest.json` as the semantic registry (assets
by id, never by file name), downsizes embedded textures when `sharp` is
available, and inlines each GLB as a `data:` URI into
`assets/vendor/speedway-assets.js` — the platform hosts a single HTML file and
separate asset files do not execute from storage. It fails the build if the
encoded payload would push the page past the sim's 12MB fetch cap.

At runtime `instantiate()` normalizes every GLB the same way: scale to a target
length, centre on X/Z, bottom at `y = 0`, then apply the ONE calibration
rotation recorded in `asset.orientation`.

### Orientation (3d-assets Gate 1)

No generated GLB exists yet, so no orientation audit has been performed and
none is claimed. The procedural kart's forward axis is not inferred — the mesh
is **authored** nose-first along `+Z`, and gameplay yaw comes from actual
horizontal velocity with the visual model as a child carrying a single
calibration rotation, so the audited path is already in place. When a kart GLB
lands, its native forward axis must be established independently
(`/regeneration.html?audit=neon-kart`, then `record-orientation.mjs`) before
`ASSETS['neon-kart'].orientation.calibrationYawDegrees` means anything;
until then it defaults to 0 and a mis-facing model would be visibly wrong
rather than silently wrong.

## Publishing

```bash
bun scripts/publish.ts --html game/dist/index.html --title "Sharky Speedway" \
    --min-players 2 --max-players 8 \
    --cover-description "..."
```

Two people who each open the game card land in two *separate* rooms — playing
together means one person opens it and shares the room's **Invite** link.
