#!/usr/bin/env node
// relay-room-check.mjs — real-room verification without a browser.
//
// scripts/room-test.ts drives two guest clients in Chromium. In a sandbox
// whose headless browser has no egress (every host, including example.com,
// resets), that check cannot run at all — but the relay handshake is only a
// wss URL with query params, so two guest sockets can be driven straight from
// Node. This asserts what actually breaks after a publish (gotchas 1a-1e):
// the sim loads THIS page, applies ops, ticks while playing, and broadcasts to
// every client in the room. It does NOT execute the game's rendering, so it is
// a complement to room-test.ts, not a replacement.
//
//   NODE_USE_ENV_PROXY=1 node game/tools/relay-room-check.mjs <game-id>
const gameId = process.argv[2];
if (!gameId) { console.error('usage: relay-room-check.mjs <game-id>'); process.exit(2); }
const inst = crypto.randomUUID();

const boot = async (name) => {
  const r = await fetch(`https://api.sharky.gg/api/v1/games/${gameId}/bootstrap-guest`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ guest_id: crypto.randomUUID(), display_name: name, client: {}, instance_id: inst }),
  });
  const j = await r.json();
  if (j.error_code) throw new Error('bootstrap failed: ' + JSON.stringify(j));
  return j.data;
};

const relayUrl = (bs) => {
  const c = bs.ws_config, p = new URLSearchParams();
  p.set('instance_id', bs.instance_id);
  p.set('room_key', bs.room_key || c.room_key);
  p.set('game_url', bs.game_url);
  p.set('user_id', bs.user_id);
  p.set('role', bs.role);
  p.set('name', bs.display_name);
  if (c.namespace) p.set('namespace', c.namespace);
  p.set('sync_mode', bs.sync_mode);
  const port = c.port === 443 ? '' : ':' + c.port;
  return `wss://${c.host}${port}${c.path || '/ws'}?${p}`;
};

const open = (bs, tag) => new Promise((res, rej) => {
  const ws = new WebSocket(relayUrl(bs));
  const st = { tag, ws, uid: bs.user_id, updates: 0, firstUpdateAt: 0, last: null, rtt: [] };
  ws.addEventListener('open', () => res(st));
  ws.addEventListener('error', () => rej(new Error(tag + ' socket error')));
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'state_update') {
      st.updates++;
      if (!st.firstUpdateAt) st.firstUpdateAt = Date.now();
      st.last = m.payload?.state ?? m.payload;
    }
    if (m.type === 'pong' && m.payload?.client_ts) st.rtt.push(Date.now() - m.payload.client_ts);
  });
  setTimeout(() => rej(new Error(tag + ' open timeout')), 25000);
});

const send = (st, type, payload) => st.ws.send(JSON.stringify({ type, payload: payload ?? {}, timestamp: Date.now() }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : -1);

const bsA = await boot('RoomCheck-A');
const bsB = await boot('RoomCheck-B');
console.log(`room_key  ${bsA.room_key}`);
console.log(`relay     ${bsA.ws_config.host} (${bsA.relay_pick_trace?.selected_relay_id}, ${bsA.relay_pick_trace?.default_reason})`);
console.log(`sync_mode ${bsA.sync_mode}`);
console.log(`page      ${bsA.game_url}\n`);

const A = await open(bsA, 'A');
const B = await open(bsB, 'B');
console.log('both guest sockets open');

// The first player_action triggers sim warmup. A room on a fresh publish can
// ride a cold start, so nudge until both sides are receiving.
const t0 = Date.now();
for (let i = 0; i < 60 && !(A.updates > 2 && B.updates > 2); i++) {
  send(A, 'player_action', { action: { type: 'SETKV', k: '__roomcheck_a', v: i } });
  send(A, 'ping', { client_ts: Date.now() });
  send(B, 'ping', { client_ts: Date.now() });
  await sleep(1000);
}
const warmMs = A.firstUpdateAt ? A.firstUpdateAt - t0 : -1;
const kvAfterA = A.last?.kvCount ?? 0;

// a KV write from B must show up in the state A receives — that is the bus
send(B, 'player_action', { action: { type: 'SETKV', k: '__roomcheck_b', v: 'hello' } });
await sleep(2500);
const crossKv = A.last?.kv?.__roomcheck_b === 'hello' && B.last?.kv?.__roomcheck_a !== undefined;

// START moves the room to playing; only then does the shim tick, which is what
// advances state.clock and initialises __SHARKY_RULES__ state (state.game).
send(A, 'player_action', { action: { type: 'START' } });
await sleep(2000);
const clock0 = A.last?.clock ?? 0;
const rulesInit = !!A.last?.game;
await sleep(6000);
const clock1 = A.last?.clock ?? 0;

console.log(`\nsim warmup       ${warmMs >= 0 ? warmMs + 'ms' : 'NEVER'}`);
console.log(`state_updates    A=${A.updates}  B=${B.updates}`);
console.log(`shared KV        kvCount=${A.last?.kvCount}  cross-client visible=${crossKv}`);
console.log(`room started     ${A.last?.started}`);
console.log(`shared clock     ${clock0}s -> ${clock1}s over ~6s`);
console.log(`__SHARKY_RULES__ state.game ${rulesInit ? 'initialised: ' + Object.keys(A.last.game).join('/') : 'ABSENT'}`);
console.log(`relay ping       A avg=${avg(A.rtt)}ms min=${Math.min(...A.rtt)}ms  B avg=${avg(B.rtt)}ms`);

const fails = [];
if (!A.updates || !B.updates) fails.push('a client received ZERO state_updates — sim warmup failed (gotcha 1a-1e)');
if (!kvAfterA) fails.push('ops never applied — kvCount stayed 0');
if (!crossKv) fails.push('shared KV did not cross between the two clients');
if (!A.last?.started) fails.push('START never moved the room to playing');
if (clock1 <= clock0) fails.push(`shared clock did not advance while playing (${clock0} -> ${clock1})`);
if (!rulesInit) fails.push('__SHARKY_RULES__ never initialised in the sim — the game would have no referee');

A.ws.close(); B.ws.close();
console.log(fails.length ? `\n❌ ${fails.join('; ')}` : '\n✅ real room verified: both guests in one room, sim warm, ops applied, KV crossing, clock ticking, rules script live');
process.exit(fails.length ? 1 : 0);
