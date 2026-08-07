# Publishing to sharky.gg — commands, credentials, hosting, sandboxes

Read this before the first publish on a machine, for any credential /
cover / hosting / egress question, and on any publish error. The workflow
rule — publish only AFTER the user's acceptance — lives in SKILL.md
step 4 and stays in force here.

## Command variants

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
game row: title and min/max players come from THIS command each time —
and omitting `--game-id` on a re-publish creates a NEW game row, orphaning
the old link.

## Credentials

The first publish on a machine asks for the user's sharky.gg account email
and a 6-digit code sent to it (the email shown in their sharky.gg account
settings; Apple "Hide My Email" accounts: the relay address); the session
then lives in `~/.config/sharky-online/session.json`, auto-refreshes, and
later publishes are zero-prompt. Games land in that user's own account.
The email comes from the user, stated in the conversation — an email found
in your environment/context (the machine's login identity) is routinely
NOT the sharky.gg account email. publish hard-errors rather than accept a
guessed one (no `--email` + no terminal = error), and an address with no
sharky.gg account is rejected before any code is sent; `--create-account`
lifts that only after the user explicitly confirms they want a NEW account
under that email. No terminal for the code prompt?
`--request-code --email <addr>` sends the code and exits; re-run with
`--verify-code <code> --email <addr>` to sign in and publish in one go.

The OTP session is an independent chain that never touches the user's
browser login. The skill ships zero secrets; the embedded anon key is the
public browser-bundle value. Operator direct-write mode exists behind an
explicit `SHARKY_ENV_FILE`.

## Hosting

The platform `/play` route (deployed 2026-07-03) hosts the published
single-file HTML permanently. Separate asset files still don't execute
from storage (text/plain + nosniff) — inline everything (that's what the
vendor mechanism is for). `--host preview` expires in ~30 min.

## Restricted-egress sandboxes

(e.g. Claude Code on the web): the default domain allowlist blocks the
platform, so publish/room-test die on their first call. publish.ts
preflights and prints the exact domains to allow (`sharky.gg` incl.
subdomains + `yhvgdxuwxyergytakxvn.supabase.co`); claude.ai/code takes
them under environment settings → Network access. Session files live in
the ephemeral container HOME, so each new web session re-verifies by
email once — never point `SHARKY_SESSION_FILE` into the repo (that would
commit login tokens).

## Skill update notice

build.ts prints a short notice if a newer skill release exists (checked at
most once a day, 1.5s timeout, silent otherwise) — for git-clone installs
by comparing against origin/main, for git-less copies (ZIP download /
vendored) via the `.release` stamp the distribution repo ships. It never
updates anything itself — updating is the user's call (`git pull
--ff-only`, or re-downloading for git-less copies, after they say yes).
