# Retrofitting a finished HTML game — mapping existing code onto the seam

Read this only when converting an already-built game. The from-scratch flow
(SKILL.md steps 1–6) applies unchanged — build, gate, dev-serve, publish.
What differs is the starting material: a finished game already owns a main
loop, timers, random calls and a state machine, all written for ONE page.
The conversion surface is enumerable — four passes cover it.

What "make it multiplayer" means here: the default expectation behind the
request is playing TOGETHER — for narrative/quest material, a shared world:
story beats advance for the whole room, whoever triggers them. Measured: a
co-presence-only conversion of a quest game came back as "tasks don't sync"
within one playtest. Ghost-visible parallel solo stories are a different
product — a request users make by name.

## 1. Inventory the time sources

Targeted search, then classify every hit:

    requestAnimationFrame  Date.now  performance.now  setTimeout  setInterval
    elapsed  deltaTime  dt  timer  deadline  cooldown  roundStart  phaseStart

Each hit belongs to one of: pure rendering · local feel (input smoothing,
camera) · single-player state (own HP, own animation) · room-wide rules
(phases, countdowns, waves) · driver-private simulation (AI, spawners).
The first three classes are untaxed — they stay exactly as written. Only
the last two are seam work. Room-wide rules meet hard-parts §0 fact 8: a
deadline written on a page clock dies with its page; written as absolute
shared-clock time T (`net.on('update', st => st.clock)`, sim seconds —
anchoring recipe in §0 fact 6) it is recomputable on every client at any
moment.

## 2. Inventory the driver-private decisions

Host picks the disaster, decides NPC targets, rolls hidden outcomes,
chooses the next map — these can stay private (game rules often want them
private). What crosses the seam is the published decision, carrying
everything needed to execute without its author:

    net.sendReliable({ k: 'wave', type: 'earthquake', seed: 38172,
                       startsAt: clock + 3, endsAt: clock + 9 })

The ordered log replays it to latecomers; execution now survives the
decider's page. Where the rules want progression even with nobody deciding,
a seed derived from the round number gives every client the same default.

## 3. Strip room-wide progression out of the render loop

The shape that breaks (measured: one backgrounded driver froze every
countdown in the room — §0 fact 8):

    function hostLoop() {
      worldTime += dt; advance(worldTime); broadcast()
      requestAnimationFrame(hostLoop)
    }

The shape that survives any page's lifecycle:

    function deriveWorld(clock, ev) {        // pure — same answer everywhere
      if (clock < ev.startsAt) return 'waiting'
      if (clock < ev.endsAt)   return 'active'
      return 'finished'
    }

rAF only renders what deriveWorld says. One-shot presentation (banner,
alarm sound) fires on the local EDGE of the derived state — which also
makes double-firing races structurally impossible. The solo contract
differs: a single-player original pauses wholesale when its tab hides (rAF
freeze), while a clock-anchored world fast-forwards — observably different
in solo play (measured: unguarded anchoring also let a hidden page farm
score through replayed round-ends).

## 4. What still needs a live stream

Derivable from clock + seed (no stream needed): disaster phases,
countdowns, scheduled waves, periodic machinery, deterministic animation.
Not derivable (needs a driver stream): post-contact NPC poses, running
physics, live AI paths. For the streamed part, a simulation progress
counter inside the stream is the observable that distinguishes a live
simulation from a live socket (§0 fact 8) — and the takeover/freeze rule on
driver death is a game-rule decision, not a platform default.

## Narrative material: story beats as world events

A story retrofit shares BEATS, not effects: a reliable op carrying only a
node id, an id → effect registry on every client, and a done-set that makes
application idempotent. Fire the beat locally at the trigger edge, then
broadcast — the bus echo and any replay land in the same done-set, so
double-apply is structurally impossible (that is what makes consuming your
own echo safe — cf. hard-parts §0 facts 1–2). Replayed beats are CONSUMED,
replayed pose streams are dropped — opposite policies, two data classes.
But the ordered log is a transport WINDOW, not an archive (~96 ops; a 10Hz
pose stream evicts a beat in seconds — measured: a late joiner's replay
held 96 poses and zero of the story's beats). Durable beat state lives in
shared KV — one key per beat (`sn_<id>`, value = journey generation, so
keys never accumulate across restarts); a late joiner rebuilds by walking
the registry in authored order against the KV, and the log replay only
back-fills the recent tail. Round-reset games self-heal without this (each
round rebuilds the world — though phase state still takes §0 fact 2's KV
mirror); persistent-progression stories do not.
Catch-up splits in two: STATE applies immediately and silently — subtitles
skipped, the callbacks embedded in dialogue lines still execute, so doors
open and flags set; the missed pure-dialogue lines are presentation-layer
catch-up whose form is the game's own call (a self-paced recap/log is one
working shape). Two measured traps: a
synchronous quiet flag does NOT reach setTimeout chains — sounds, fades and
chapter cards fire seconds after the drain unless the delayed landing sites
re-check; and "skip my own ops" must exempt replay (skip only when
`meta.self && !meta.replayed`) or a rejoining player's own past beats are
swallowed and their flags desync from the room. Scene transitions take a
monotonic guard — index the stages, refuse backward moves; replay races and
stale timers otherwise drag the room back (orthogonal to §0 fact 8
deadlines:
one keeps time recomputable, the other keeps state from regressing).
The seam decides only WHAT is shared: beat triggers and their world
consequences reach every client, and the shared registry doubles as the
whitelist of what advances the story; personal flavor interactions (lore
peeks, side chats) can stay local. HOW a client presents a shared beat —
dialogue as broadcast or ambient, cutscene or event card, whose camera
moves — is presentation and stays the game's own call (one live-playtest
data point: a task that stole another player's camera read as broken).

## Other seam points of a finished original

External `<script src>` deps: the published page inlines everything —
vendor mechanism, SKILL.md step 1 (the original's exact CDN build, saved
into `assets/vendor/`, keeps rendering byte-identical). Pointer lock throws
`WrongDocumentError` inside iframes (wrap the call in try). AudioContexts
start suspended until a user gesture. Focus loss keeps keys held down
(gotcha 13c). Random calls split by class: fixed/synced seed for world
generation, round-seed rolls for shared events, plain `Math.random()`
stays for local FX.
