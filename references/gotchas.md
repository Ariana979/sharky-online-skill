# Practice-derived gotchas (every one hit for real, 2026-07-02/03)

Numbers are stable IDs, not positions — entries sit in topic sections, so
a numeric hunt needs a text search, not a scroll.

## The sim sandbox (single most important section)

1a. **The sim's code source is the `game_url` HTML.** The sim (colocated with
   the sg relays, `/data/sim-service`, warmup triggered by the first
   `player_action`) fetches game_url — plain fetch, no host allowlist —
   extracts EVERY inline `<script>` (skips any tag with `src=`), and
   vm-executes each body with stub globals. It then requires
   `window.__DELTA_GAME_CONFIG__` to be a valid object.
1b. **Per-script sync errors are silently ignored** (`logger.debug` only). A
   script that throws before setting the config = config never set = relay
   logs `sim_warmup_failed: unable to load window.__DELTA_GAME_CONFIG__` and
   clients just see zero state_updates. One unreplaced `__MIN_PLAYERS__`
   placeholder cost us half a day — the build's sim gate now catches this.
1c. **Unhandled promise rejections KILL the sim session**
   (`session dead reason=unhandled_rejection`). An `await SharkyNet.ready()`
   that rejects in the sandbox is enough. Rule: every game script must no-op
   in the sim — start with `if (typeof SharkyNet === 'undefined') return;`
   (sharky-net itself exits early when `window.addEventListener` is missing).
   The build gate fails on leaked rejections.
1d. **Debugging**: relay+sim logs live in journald on the sg-relay hosts;
   `journalctl --since today | grep <gameId>` shows `sim join failed` /
   `sim_warmup_failed` with the exact fetch URL and error.
1e. **The sim's page fetch has a SIZE CAP** — `SIM_MAX_HTML_BYTES` in the
   sim-service `.env` (2,000,000 stock; prod sg-relays raised to 6,000,000
   on 2026-07-05). An oversized page (e.g. base64-embedded models) →
   `sim join failed status=500 "game html too large"` → `sim_warmup_failed`
   → clients see zero state_updates while everything else "works". Local
   build/publish pass fine — nothing client-side hints at it. A 4.65MB page
   warms in ~6s once under the cap. publish.ts warns above 2MB.

## Platform / publishing
2. **Supabase storage serves HTML as `text/plain` + nosniff** (bucket policy —
   the platform's own games hit this too; that's why Vercel deploys exist).
   `game_url` must point at a real text/html host. The preview host
   (`prod-game-maker.sharky.gg/api/preview`) works but expires in ~30 min.
3. **`user_games.authority_mode` is the sync-mode switch.** `server_sim` there →
   bootstrap hands every client `sync_mode: server_sim`. Rows can be created
   out-of-band (service key) and the platform honors them, including the
   private-game join guard.
4. **`private=1` blocks guest joins** ("only game owner can join private game").
5. **Platform sharky token: 1h TTL** (`exp-iat=3600`, standard Supabase JWT).
   The frontend refreshes on `error_code 10002` via `auth.refreshSession()`.
   Don't copy the browser's refresh token (rotation would log the user out) —
   a separate email-OTP session is the clean path (roadmap).
6. **guest_id must be a UUID** — other formats get `invalid guest id`.
17. **Cover changed after a logic-only re-publish** → `--cover-description`
    was passed; ANY passed description regenerates the cover, and image-gen
    is non-deterministic — omit the flag when the look didn't change (an
    existing cover is then kept: server-gated). **A cover appeared on a game
    that never had one** → the server backfills a missing cover on any
    publish, flag or not (games published before 2026-07-14 predate covers;
    one-time, self-healing).

## Relay / rooms

7. **player_action routing in host_client rooms is dead** (verified with
   elected-guest host AND owner-online host). Only server_sim rooms deliver
   client input (to the sim). Don't design anything on the host_client upstream.
8. **Relayed action payloads may lack user_id** — carry identity inside the op
   (sharky-net stamps `__tag`).
9. **Only the host connection may send `state_sync`** — anyone else gets an
   `error` frame back.
10. **Send the parent bootstrap postMessage ONCE.** Every
    `game:network-bootstrap` re-applies and reconnects the relay socket,
    leaving zombie room members that eat routing.
11. **Same account double-open = same user_id** — the relay may treat both as
    one seat. Use guest bootstraps for local two-client testing.
12. **Rate budget:** documented 20 action/s; a 40-op burst was accepted in
    practice. sharky-net throttles to ≤15/s — coalesce inputs (latest cursor
    pos, not every mousemove).

## Testing

13. **Background tabs freeze rAF games** (`document.hidden` → loop throttled).
    Use headless Playwright (pages report visible) for automated checks.
13b. **`players()` lists a client only after the room has seen ≥1 action from
    them — mock and real rooms behave the SAME** (real-room verified
    2026-07-07: two joined-but-silent guests both read an empty `players()`;
    the shim's `initPlayer` runs lazily on a client's first action, not on
    join). sharky-net self-registers on open with a system `SETKV`, so
    presence and lobby counts are correct before the game sends anything;
    the `__sys_presence` key never appears in `shared()`.
13c. **One keyboard, two panes: switching panes strands the previous pane's
    held keys** — the pane you leave never receives the keyup, so a
    `keys[...]` state map sticks and that character keeps moving on its own
    (reads as "both players respond to my input"). A `window` `blur` listener
    that clears the key map removes the class — real players alt-tab too.
    Single-keyboard testing in the two-pane mock room surfaces this within
    minutes.
14. **iframe URL matching in Playwright:** the parent URL can contain the game
    URL as a query param — match frames with `f !== page.mainFrame()`, not by
    substring alone.
15. **L1 lint scans raw source INCLUDING comments** — writing "localStorage"
    in a comment trips `forbidden_pattern` (matters if you also ship contract
    games; the shim template is already clean).
18. **A background command piped through a filter loses its banner.**
    `bun dev-serve.ts … | head` backgrounded: the server flushes its lines,
    but `head`'s own stdout is block-buffered off-tty and it exits only on
    enough input lines or EOF — a long-running server supplies neither, so
    the printed URL, chosen port and launch.json snippet sit in the
    filter's buffer indefinitely, which reads as "no output" and invites
    guessing the port from docs. Un-piped background output lands live.

## Platform room semantics (why "multiplayer doesn't work" reports happen)

15b. **Clicking a game card creates a FRESH instance (= a new room).** Two
    people who each open the game independently are in two separate
    single-player rooms — game code is not involved and cannot fix it.
    Playing together means sharing the room: the platform's Invite button,
    or the full URL with its `instance_id`. Consequences:
    - test multiplayer via the invite/instance URL, never two card-clicks;
    - games should make room-ness legible: show the connected player count
      in the lobby, and when solo, say "friends join via the invite link"
      (players otherwise read an empty room as broken multiplayer);
    - publish.ts prints this reminder next to the play link.

15c. **Real-page role/identity resolution is ASYNC (seconds); mock is
    instant.** The bridge defaults to `role:'client'` until the parent's
    `game:network-bootstrap` postMessage lands, and host determination can
    additionally wait for the relay to report `host_user_id` — during that
    window `net.isHost()` is false for EVERYONE and `me().id` can still be
    `'local'`. Mock rooms resolve identity synchronously, so the window is
    structurally invisible offline (real-page verified 2026-07-08: a START
    gated by a one-shot `isHost()` check silently swallowed clicks for ~3s
    and the game read as "stuck in lobby" — initially misdiagnosed as a
    camera bug). `isHost()`/`me()` are live polls — reading them per frame
    observes the flip; the bridge also emits `delta:role-changed` each time
    the answer changes.

## Verification shape

16. **Sightless verification ships sighted bugs.** Rules distilled from real
    misses (the founding one: a camera lerping its position in WORLD space
    loses the car in sustained turns — angle-space smoothing doesn't, and no
    single frame shows it): input scripts must include TURNS and camera drags;
    assert over TIME (frame sequences), not single frames; test the user's
    actual viewport class (wide retina ≠ 1280×720 headless default); and put
    a human eyeball on the filmstrip before handover. The playtest gate
    (scripts/playtest-gate.ts) encodes all four.

## Latency model (measured)

- Op round trip (send → back in state_update): **min ~350ms · median ~400ms ·
  p95 ~780ms**. state_update cadence is steady.
- Design rule: **local echo immediately, reconcile on op order.** Party /
  turn-based / casual games need nothing else; twitch games need
  gameplay-level prediction (your logic owns it).
