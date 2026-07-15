// publish.ts — publish a built game to sharky.gg under YOUR account.
//
//   bun scripts/publish.ts --html dist/index.html --title "My Game" \
//       [--game-id <existing id to update>] [--min-players 2] [--max-players 8] \
//       [--email <account email>] [--create-account] \
//       [--request-code | --verify-code <6-digit>]   (two-phase OTP when no terminal)
//
// CREDENTIALS (v2): first publish asks for your sharky.gg account email and a
// 6-digit code sent to it (use the SAME email your platform account shows in
// its settings — Apple "Hide My Email" accounts must use the relay address).
// The session is stored in ~/.config/sharky-online/session.json (override with
// SHARKY_SESSION_FILE) and refreshes itself; later publishes are zero-prompt.
// This is an independent session chain — it does NOT log you out of the
// sharky.gg website. The skill ships zero secrets: the embedded anon key below
// is the public client key served in every sharky.gg browser bundle.
//
// OPERATOR MODE (platform maintainers only): set SHARKY_ENV_FILE to a platform
// .env carrying SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SHARKY_USER_ID to
// write storage + user_games directly. --host preview / --game-url work only
// in this mode.
//
// HOSTING NOTE: storage serves HTML as text/plain (bucket policy), so
// game_url must point at a text/html host. Default: the platform /play
// route — permanent, cache-busted via ?v=<hash>.
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import * as readline from 'node:readline/promises'

// Public platform constants (the anon key is the public browser-bundle key —
// safe to ship; it grants nothing beyond what any sharky.gg visitor has).
const SUPABASE_URL = 'https://yhvgdxuwxyergytakxvn.supabase.co'
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlodmdkeHV3eHllcmd5dGFreHZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDcxMDM0MzcsImV4cCI6MjA2MjY3OTQzN30.wr_wxValc6HSAIaIVOiSYmKWMAdMbHzBWWqR0IFprHk'
const DEFAULT_API_BASE = 'https://prod-game-maker.sharky.gg'

const args: Record<string, string> = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] ?? ''

const htmlPath = resolve(args.html || 'dist/index.html')
const title = args.title || 'Untitled Sharky Game'
const minPlayers = Number(args['min-players']) || 2
const maxPlayers = Number(args['max-players']) || 8
const apiBase = (args['api-base'] || process.env.SHARKY_API_BASE || DEFAULT_API_BASE).replace(/\/$/, '')

// The account email must come from the USER, stated in the conversation. An
// email found in the caller's environment or context (the machine login /
// harness-injected user email) is routinely NOT the sharky.gg account email.
const EMAIL_FROM_USER =
  'The account email must come from the USER — the address shown in their sharky.gg '
  + 'account settings. Ask them for it, then re-run with --email <their email>. Never guess '
  + 'or generate an email address, and never use one found in your environment/context '
  + '(the machine login email is routinely NOT the sharky.gg account email).'

let html = ''
function loadHtml() {
  html = readFileSync(htmlPath, 'utf8')
  if (!/window\.__DELTA_GAME_CONFIG__\s*=/.test(html)) {
    throw new Error('built HTML missing the sim shim — run scripts/build.ts first')
  }
  // The server-side sim refuses oversized pages (SIM_MAX_HTML_BYTES: 2MB stock,
  // 6MB on current prod relays) — publish would succeed but rooms never sync
  // (gotcha 1e: sim_warmup_failed, zero state_updates).
  if (html.length > 2_000_000) {
    console.warn(`[publish] WARNING: page is ${(html.length / 1e6).toFixed(2)}MB — sim fetch cap is SIM_MAX_HTML_BYTES (2MB stock / 6MB current prod). Oversized pages publish fine but never sync.`)
  }
}

if (process.env.SHARKY_ENV_FILE) {
  loadHtml()
  await operatorPublish()
} else {
  if (args.host || args['game-url']) {
    throw new Error('--host / --game-url are operator-mode options (set SHARKY_ENV_FILE); account publishing always uses the permanent /play route')
  }
  // OTP phase 1 needs no build artifact — dispatch before reading --html so a
  // code request works from any directory.
  if ('request-code' in args) await requestCodeOnly()
  loadHtml()
  await userPublish()
}

// ---------------------------------------------------------------------------
// user mode (default): email-OTP session + platform import endpoint
// ---------------------------------------------------------------------------

type Session = {
  access_token: string
  refresh_token: string
  expires_at: number // ms epoch
  email: string
  user_id: string
  supabase_url: string
}

// Sandboxed environments (e.g. Claude Code on the web) gate outbound traffic
// behind a domain allowlist — the very first auth call dies there with a
// proxy 403/connect error. Diagnose and say exactly what to allow.
function networkGuidance(context: string): string {
  return [
    `${context}`,
    '[network] This environment cannot reach the sharky.gg platform. Sandboxed',
    '[network] environments (e.g. Claude Code on the web) allow only listed domains.',
    '[network] Allow these, then retry (changes may apply only to NEW sessions):',
    '[network]   - yhvgdxuwxyergytakxvn.supabase.co   (sign-in + storage)',
    '[network]   - prod-game-maker.sharky.gg          (import endpoint + /play hosting)',
    '[network]   - sharky.gg incl. subdomains         (game page, room bootstrap, relays)',
    '[network] claude.ai/code: environment settings -> Network access (allowlist or',
    '[network] Unrestricted). Fallback: publish from any machine with bun installed:',
    '[network]   bun <skill>/scripts/publish.ts --html dist/index.html --title "..." --email <account email>',
  ].join('\n')
}

// First-time sign-in path only (zero cost on the stored-session happy path).
async function preflight(): Promise<void> {
  const checks: Array<[string, string, Record<string, string>]> = [
    ['supabase auth', `${SUPABASE_URL}/auth/v1/settings`, { apikey: SUPABASE_ANON_KEY }],
    ['import api', `${apiBase}/api/health`, {}],
  ]
  const failed: string[] = []
  for (const [name, url, headers] of checks) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
      if (!r.ok) failed.push(`${name} -> HTTP ${r.status}`)
    } catch (e: any) {
      failed.push(`${name} -> ${e?.message ?? e}`)
    }
  }
  if (failed.length) throw new Error(networkGuidance(`[network] preflight failed: ${failed.join('; ')}`))
}

function sessionPath(): string {
  return process.env.SHARKY_SESSION_FILE || join(homedir(), '.config', 'sharky-online', 'session.json')
}

function loadSession(): Session | null {
  try {
    const s = JSON.parse(readFileSync(sessionPath(), 'utf8')) as Session
    if (!s?.access_token || !s?.refresh_token) return null
    if (s.supabase_url && s.supabase_url !== SUPABASE_URL) {
      console.warn(`[auth] stored session targets ${s.supabase_url}, expected ${SUPABASE_URL} — ignoring it`)
      return null
    }
    return s
  } catch {
    return null
  }
}

function saveSession(s: Session) {
  const file = sessionPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(s, null, 2) + '\n')
  chmodSync(file, 0o600)
}

function toSession(tokens: any, emailFallback: string): Session {
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
    email: tokens.user?.email ?? emailFallback,
    user_id: tokens.user?.id ?? '',
    supabase_url: SUPABASE_URL,
  }
}

async function authFetch(path: string, body: unknown): Promise<{ ok: boolean; status: number; json: any }> {
  let resp: Response
  try {
    resp = await fetch(`${SUPABASE_URL}${path}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (e: any) {
    throw new Error(networkGuidance(`[network] auth call ${path} failed: ${e?.message ?? e}`))
  }
  return { ok: resp.ok, status: resp.status, json: await resp.json().catch(() => ({})) }
}

// Supabase rotates refresh tokens: each refresh invalidates the old one, so
// the rotated pair is saved immediately. This chain is independent of any
// browser session (gotcha 5) — refreshing here never logs the website out.
async function refreshSession(s: Session): Promise<Session | null> {
  const r = await authFetch('/auth/v1/token?grant_type=refresh_token', { refresh_token: s.refresh_token })
  if (!r.ok || !r.json?.access_token) return null
  const next = toSession(r.json, s.email)
  saveSession(next)
  return next
}

async function requireEmail(rl: readline.Interface | null): Promise<string> {
  let email = (args.email || '').trim()
  if (!email) {
    if (!rl || !process.stdin.isTTY) {
      // No terminal to ask in — refuse rather than let a caller invent one.
      throw new Error('no --email and no interactive terminal. ' + EMAIL_FROM_USER)
    }
    email = (await rl.question('sharky.gg account email: ')).trim()
  }
  if (!email.includes('@')) throw new Error('a valid email is required')
  return email
}

async function sendOtp(email: string): Promise<void> {
  console.log(`[auth] signing in as ${email} — must match the email in the user's sharky.gg account settings (stated by the user; an environment/context email is usually NOT it)`)

  // create_user:false by default — a typo'd or invented address fails HERE,
  // loudly, instead of mailing a code into the void and orphaning a new
  // account. --create-account (only after the USER explicitly confirms they
  // want a new sharky.gg account for this email) flips it for this send;
  // note the account row is created the moment the code is sent.
  const allowCreate = 'create-account' in args
  if (allowCreate) console.log(`[auth] --create-account: a new sharky.gg account will be created for ${email}`)
  const sent = await authFetch('/auth/v1/otp', { email, create_user: allowCreate })
  if (!sent.ok) {
    const detail = JSON.stringify(sent.json).slice(0, 200)
    if (!allowCreate && (sent.status === 400 || sent.status === 422 || /signup|not.?allowed|not.?found/i.test(detail))) {
      throw new Error(
        `${email} is not a registered sharky.gg account (${sent.status}). Use the exact email `
        + 'shown in the sharky.gg account settings (Apple "Hide My Email" accounts: the relay '
        + 'address). To CREATE a new sharky.gg account with this email instead, confirm that '
        + 'with the user first, then re-run with --create-account.',
      )
    }
    throw new Error(`could not send the code (${sent.status}): ${detail}`)
  }
  console.log(`[auth] 6-digit code sent to ${email}`)
}

async function verifyOtp(email: string, code: string): Promise<Session> {
  const allowCreate = 'create-account' in args
  let v = await authFetch('/auth/v1/verify', { email, token: code, type: 'email' })
  if (!v.ok) {
    // older GoTrue versions only accept the pre-consolidation type names
    v = await authFetch('/auth/v1/verify', { email, token: code, type: 'magiclink' })
  }
  if (!v.ok && allowCreate) {
    v = await authFetch('/auth/v1/verify', { email, token: code, type: 'signup' })
  }
  if (!v.ok || !v.json?.access_token) {
    throw new Error(`code verification failed (${v.status}): ${JSON.stringify(v.json).slice(0, 200)}`)
  }
  const session = toSession(v.json, email)
  saveSession(session)
  console.log(`[auth] signed in as ${session.email} — session stored in ${sessionPath()}; later publishes need neither --request-code nor --verify-code`)
  return session
}

async function otpLogin(): Promise<Session> {
  await preflight()
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const email = await requireEmail(rl)
    await sendOtp(email)
    if (!process.stdin.isTTY) {
      console.warn('[auth] no terminal detected — if this hangs at the code prompt, use --request-code / --verify-code <code> instead')
    }
    const code = (await rl.question('6-digit code: ')).trim()
    return await verifyOtp(email, code)
  } finally {
    rl.close()
  }
}

// Two-phase OTP for callers without a terminal (e.g. agent-driven sessions):
// the interactive prompt needs a TTY, so --request-code sends the code and
// exits; a second run with --verify-code <code> --email <addr> signs in and
// goes straight into the publish. If both flags are passed, --request-code wins.
async function requestCodeOnly(): Promise<never> {
  await preflight()
  const email = await requireEmail(null)
  await sendOtp(email)
  console.log(`[auth] next: re-run the same command with --verify-code <code> --email ${email} (drop --request-code)`)
  process.exit(0)
}

async function verifyCodeLogin(rawCode: string): Promise<Session> {
  const code = rawCode.trim()
  if (!/^\d{6}$/.test(code)) {
    throw new Error('--verify-code expects the 6-digit code from the email (send one first with --request-code)')
  }
  await preflight()
  const email = await requireEmail(null)
  try {
    return await verifyOtp(email, code)
  } catch (e) {
    // OTP codes are single-use: re-running the same command after a success
    // (or after a post-auth publish failure) lands here — fall back to the
    // session the earlier verification already stored for this email.
    const stored = loadSession()
    if (stored && (stored.email || '').toLowerCase() === email.toLowerCase()) {
      if (stored.expires_at - 60_000 > Date.now()) {
        console.warn(`[auth] code rejected (single-use — already verified?) — using the stored session for ${email}`)
        return stored
      }
      const refreshed = await refreshSession(stored)
      if (refreshed) {
        console.warn(`[auth] code rejected (single-use — already verified?) — refreshed the stored session for ${email}`)
        return refreshed
      }
    }
    throw e
  }
}

async function ensureSession(): Promise<Session> {
  const existing = loadSession()
  if (existing) {
    if (existing.expires_at - 60_000 > Date.now()) return existing
    const refreshed = await refreshSession(existing)
    if (refreshed) return refreshed
    console.warn('[auth] stored session could not be refreshed — signing in again')
  }
  return otpLogin()
}

async function callImport(accessToken: string): Promise<{ status: number; json: any }> {
  let resp: Response
  try {
    resp = await fetch(`${apiBase}/api/v1/games/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        html,
        title,
        minPlayers,
        maxPlayers,
        ...(args['game-id'] ? { gameId: args['game-id'] } : {}),
        ...(args['cover-description'] ? { coverDescription: args['cover-description'] } : {}),
      }),
    })
  } catch (e: any) {
    throw new Error(networkGuidance(`[network] import call failed: ${e?.message ?? e}`))
  }
  const raw = await resp.text().catch(() => '')
  let json: any = {}
  try { json = JSON.parse(raw) } catch {}
  // A failing status with a non-JSON body is a gateway/proxy answering, not
  // the platform (the endpoint always speaks JSON) — say so.
  if (resp.status !== 200 && !json?.error) {
    throw new Error(networkGuidance(`[network] import endpoint answered ${resp.status} with a non-JSON body`))
  }
  return { status: resp.status, json }
}

async function userPublish() {
  // presence-routed (not truthiness): an empty-valued --verify-code must hit
  // the 6-digit guard, not silently fall into the interactive login.
  let session = 'verify-code' in args ? await verifyCodeLogin(args['verify-code'] ?? '') : await ensureSession()
  let result = await callImport(session.access_token)
  if (result.status === 401) {
    // token may have just expired mid-flight; refresh (or re-login) once
    session = (await refreshSession(session)) ?? (await otpLogin())
    result = await callImport(session.access_token)
  }
  if (result.status !== 200) {
    throw new Error(`publish failed (${result.status}): ${result.json?.error ?? JSON.stringify(result.json).slice(0, 200)}`)
  }

  const out = result.json
  if (out.warning) console.warn(`[publish] WARNING: ${out.warning}`)
  console.log(`\n✅ ${out.updated ? 'updated' : 'published'} — account: ${out.email || session.email}`)
  // Cover disposition (server rule: regenerate when a description is passed;
  // otherwise only fill a missing cover). Older servers omit coverPending.
  if (typeof out.coverPending === 'boolean') {
    const passedCover = 'cover-description' in args
    if (!out.coverPending) {
      console.log('[cover] existing cover kept (no --cover-description passed)')
    } else if (out.updated) {
      console.log(passedCover
        ? '[cover] regenerating from the new description — appears in ~seconds'
        : '[cover] backfilling a missing cover (game had none) — appears in ~seconds')
    } else {
      console.log(passedCover
        ? '[cover] generating from your description — appears in ~seconds'
        : '[cover] generating a title-only cover (no --cover-description passed)')
    }
  }
  printFooter(out.gameId)
}

// ---------------------------------------------------------------------------
// operator mode (SHARKY_ENV_FILE): direct storage + user_games writes
// ---------------------------------------------------------------------------

async function operatorPublish() {
  const envFile = process.env.SHARKY_ENV_FILE!
  const env: Record<string, string> = {}
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) env[m[1]] = m[2].trim()
  }
  const OP_SUPABASE_URL = env.SUPABASE_URL
  const KEY = env.SUPABASE_SERVICE_ROLE_KEY
  const BUCKET = env.STORAGE_BUCKET || 'game-apps'
  const OWNER = env.SHARKY_USER_ID
  if (!OP_SUPABASE_URL || !KEY || !OWNER) throw new Error(`missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SHARKY_USER_ID in ${envFile}`)

  const gameId = args['game-id'] || randomUUID()
  const isUpdate = !!args['game-id']
  const hash = createHash('sha256').update(html).digest('hex').slice(0, 12)

  async function uploadStorage(path: string, body: string, contentType: string) {
    const resp = await fetch(`${OP_SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, apikey: KEY, 'content-type': contentType, 'x-upsert': 'true' },
      body,
    })
    if (!resp.ok) throw new Error(`upload ${path} failed ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
    return `${OP_SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`
  }

  // 1. storage artifacts
  await uploadStorage(`${gameId}/index.html`, html, 'text/html; charset=utf-8')
  const now = new Date().toISOString()
  const sourceArtifact = {
    version: 1,
    codeStore: null,
    gameCode: html, // full HTML — the platform sim extracts the embedded config (old-pipeline convention)
    gameCodeHash: hash,
    designSpec: { title, description: 'Published via sharky-online skill (free-form HTML + sync bus).', minPlayers, maxPlayers },
    generatedAssets: {},
    metadataTrace: { source: 'sharky-online-skill', sourceVersion: hash },
    requestedCapabilities: [],
    sdkVersion: 'v3',
    sourceVersion: hash,
    bgmUrl: null,
    createdAt: now,
    updatedAt: now,
  }
  await uploadStorage(`${gameId}/source/latest.json`, JSON.stringify(sourceArtifact, null, 2), 'application/json')
  console.log('[storage] artifacts uploaded for', gameId)

  // 2. hosting (game_url must serve text/html — the sim reads the config from it)
  let gameUrl = args['game-url'] || ''
  if (!gameUrl && args.host === 'preview') {
    const prev = await fetch(`${DEFAULT_API_BASE}/api/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html }),
    })
    const pj: any = await prev.json()
    if (!pj.id) throw new Error('preview host failed: ' + JSON.stringify(pj).slice(0, 200))
    gameUrl = `${DEFAULT_API_BASE}/api/preview/${pj.id}`
    console.warn('[hosting] PREVIEW host — expires in ~30 minutes. Testing only.')
  }
  if (!gameUrl) {
    // ?v busts the sim's per-game_url source cache so re-publishes take effect
    // for new rooms immediately (the /play route ignores the query).
    gameUrl = `${DEFAULT_API_BASE}/play/${gameId}?v=${hash}`
    const check = await fetch(gameUrl, { method: 'GET' })
    if (!check.ok || !(check.headers.get('content-type') || '').includes('text/html')) {
      throw new Error(`play route not serving this game (${check.status}) — is /play deployed and the storage upload done?`)
    }
    console.log('[hosting] permanent /play route:', gameUrl)
  }

  // 3. user_games row
  const row: Record<string, unknown> = {
    user_id: OWNER,
    title,
    desc: `${title} — published via sharky-online skill`,
    app_prompt: `${title} (free-form HTML, sync-bus multiplayer)`,
    app_status: 'ready',
    mode: 'web_app',
    authority_mode: 'server_sim',
    min_players: minPlayers,
    max_players: maxPlayers,
    private: 0,
    deleted: 0,
    source: 'web',
    build_pipeline: 'nodejs_worker',
    game_url: gameUrl,
    source_version: hash,
  }
  const url = isUpdate
    ? `${OP_SUPABASE_URL}/rest/v1/user_games?id=eq.${gameId}`
    : `${OP_SUPABASE_URL}/rest/v1/user_games`
  const resp = await fetch(url, {
    method: isUpdate ? 'PATCH' : 'POST',
    headers: { Authorization: `Bearer ${KEY}`, apikey: KEY, 'content-type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(isUpdate ? row : { id: gameId, ...row }),
  })
  if (!resp.ok) throw new Error(`user_games ${isUpdate ? 'update' : 'insert'} failed ${resp.status}: ${(await resp.text()).slice(0, 300)}`)

  console.log(`\n✅ ${isUpdate ? 'updated' : 'published'} (operator mode)`)
  printFooter(gameId)
}

function printFooter(gameId: string) {
  console.log('GAME_ID=' + gameId)
  console.log('PLAY=https://sharky.gg/game/' + gameId)
  console.log('MULTIPLAYER: opening the game card starts a FRESH room — players join')
  console.log('together only via the Invite button / the full URL with its instance_id.')
  console.log('\nNext: bun scripts/room-test.ts --game-id ' + gameId + '   # automated 2-client room check')
}
