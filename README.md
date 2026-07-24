# sharky-online — multiplayer HTML games from a one-sentence prompt

An agent skill: describe a game in one sentence (or hand over an
existing single-file HTML game) and your AI coding agent builds it,
wires in real platform multiplayer, lets you playtest locally, and —
only after you say so — publishes it to [sharky.gg](https://sharky.gg)
under your own account. Real rooms, invite links, a server-ordered sync
bus (~400ms round trip; local echo makes it feel instant).

This repo IS the skill, ready to install. Everything it does is
documented in [SKILL.md](SKILL.md).

## Prerequisites

- An AI coding agent that supports the skills format (desktop app,
  terminal CLI, or web)
- `git` and [`bun`](https://bun.sh) (one-line install)
- A sharky.gg account (register first; remember the account email)
- Chrome or Edge on the machine (used by the automated checks; on a
  browserless Linux box run `bunx playwright install chromium` once)

## Install

Desktop app / terminal CLI — one command, installs once for the whole
machine (both see the same skills directory):

```bash
git clone https://github.com/Ariana979/sharky-online-skill ~/.claude/skills/sharky-online
```

Per-project alternative: clone into the project's
`.claude/skills/sharky-online/` instead.

Web-sandbox agents: the sandbox filesystem is ephemeral — vendor this
repo into your project repository at `.claude/skills/sharky-online/`
(copy or submodule) so it checks out together with the project.

## Use

Just talk to your agent — any language works:

- New game: “use sharky online to build a 4-player coin-grab party game”
- Convert an existing game: “use sharky online to make this finished
  HTML game platform-multiplayer without breaking its visuals or
  content” (attach your HTML file)

The agent hands you a local two-pane playtest link first; nothing goes
live until you say “publish”.

## What happens at publish

The first publish signs into YOUR sharky.gg account: the agent asks for
the account email (the one shown in your sharky.gg account settings —
Apple “Hide My Email” users: the relay address), the platform emails you
a 6-digit code, you paste it back. Later publishes on the same machine
are zero-prompt. The skill ships zero secrets; games land in your
account.

## Playing with friends (read this once)

Opening a game card starts a FRESH room — two people who each open the
game land in two separate rooms. To play together, one person opens the
game and shares the **Invite** link.

## Web sandbox note

Some web sandboxes block outside domains by default. If the first
publish hits a network error, the publish script prints the exact
domains to allow — add them under your environment’s network-access
settings.

## Upstream

This is a read-only release mirror — one commit per release, each
carrying its upstream source hash; release notes live in the annotated
tags. Issues/PRs are welcome: accepted changes land upstream first (they
go through a measurement protocol) and arrive here with the next
release.
