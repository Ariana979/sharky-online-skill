// Universal sync-bus shim — executed ONLY by the platform's server-side sim,
// which extracts window.__DELTA_GAME_CONFIG__ from the published page HTML.
// Inert in the player's browser (the page does not include game-sdk).
//
// Placeholders (filled by scripts/build.ts): __TITLE__, __MIN_PLAYERS__, __MAX_PLAYERS__

var OP_LOG_MAX = 96;
var OP_MAX_CHARS = 2048;
var KV_KEY_MAX = 64;
var KV_VAL_MAX_CHARS = 4096;
var KV_KEYS_MAX = 128;
var CLOCK_ACC = 0; // fractional clock accumulator (kept out of state on purpose)

function opSizeOk(v, cap) {
  try { return JSON.stringify(v).length <= cap; } catch (e) { return false; }
}

window.__DELTA_GAME_CONFIG__ = {
  title: '__TITLE__',
  subtitle: 'Free-form HTML game on the Sharky sync bus',
  instructions: ['Multiplayer state is ordered by the platform sim.'],
  minPlayers: __MIN_PLAYERS__,
  maxPlayers: __MAX_PLAYERS__,
  authorityMode: 'server_sim',
  syncMode: 'realtime',
  // Rooms run one game_url, so every client of this page understands delta
  // frames — the sim broadcasts increments (new log entries + dirty KV) with
  // periodic keyframes instead of the full 96-op window each tick. Legacy
  // pages lack this flag and keep full snapshots automatically.
  syncModel: 'delta-v1',
  capabilities: [],
  networkProfile: {
    class: 'confirm_only',
    actionRate: 'high',
    movementModel: 'continuous',
    remoteSmoothing: 'interpolate',
    interactionModel: 'contested',
    decisiveEventTolerance: 'high'
  },

  initState(ctx) {
    return { players: {}, seq: 0, log: [], kv: {}, kvCount: 0, clock: 0, started: false };
  },

  initPlayer(userId, info, ctx) {
    return { name: (info && (info.display_name || info.name)) || String(userId).slice(0, 8) };
  },

  customActions(input, ctx) {
    return null;
  },

  onAction(state, action, userId, ctx) {
    if (!action || typeof action !== 'object') return;
    if (action.type === 'START') { state.started = true; return; }
    if (action.type === 'OP') {
      if (!opSizeOk(action.op, OP_MAX_CHARS)) return;
      state.seq += 1;
      state.log.push({ s: state.seq, u: String(userId || ''), o: action.op, ct: Number(action.client_ts) || 0 });
      if (state.log.length > OP_LOG_MAX) state.log.splice(0, state.log.length - OP_LOG_MAX);
      // Optional game rules (authoritative): a pure-logic script on the page
      // may define window.__SHARKY_RULES__ = { init(game), onOp(game, op, uid),
      // onTick(game, dt) }. The sim executes every inline script, so the same
      // reducers run HERE as authority and on clients as optimistic preview.
      // Rules state lives in state.game and rides the state_update broadcast.
      var R = (typeof window !== 'undefined' && window.__SHARKY_RULES__) || null;
      if (R && typeof R.onOp === 'function') {
        if (!state.game) { state.game = {}; if (typeof R.init === 'function') { try { R.init(state.game); } catch (e) {} } }
        try { R.onOp(state.game, action.op, String(userId || '')); } catch (e) {}
      }
      return;
    }
    if (action.type === 'SETKV') {
      var key = String(action.k == null ? '' : action.k).slice(0, KV_KEY_MAX);
      if (!key) return;
      if (!opSizeOk(action.v, KV_VAL_MAX_CHARS)) return;
      if (!(key in state.kv)) {
        if (state.kvCount >= KV_KEYS_MAX) return;
        state.kvCount += 1;
      }
      state.kv[key] = action.v;
      return;
    }
  },

  onTick(state, dt, ctx) {
    // Whole-second clock steps: a per-tick float here made every snapshot's
    // JSON unique, defeating the sim's identical-state dedup — idle rooms
    // were broadcasting full state at full rate for nothing.
    CLOCK_ACC += dt;
    if (Math.floor(CLOCK_ACC) > state.clock) state.clock = Math.floor(CLOCK_ACC);
    var R = (typeof window !== 'undefined' && window.__SHARKY_RULES__) || null;
    if (R && typeof R.onTick === 'function') {
      if (!state.game) { state.game = {}; if (typeof R.init === 'function') { try { R.init(state.game); } catch (e) {} } }
      try { R.onTick(state.game, dt); } catch (e) {}
    }
  },

  isGameOver(state) {
    return false;
  },

  getScores(state, ctx) {
    var out = [];
    for (var uid in state.players) out.push({ userId: uid, score: 0 });
    return out;
  },

  render(c, state, ctx, phase, dt) {
    c.fillStyle = '#0b1120';
    c.fillRect(0, 0, ctx.W(), ctx.H());
    c.fillStyle = '#e2e8f0';
    c.font = '20px monospace';
    c.fillText('sync-bus shim (sim debug view)', 60, 80);
    c.fillText('seq=' + state.seq + ' kv=' + state.kvCount + ' clock=' + state.clock.toFixed(1), 60, 116);
  }
};
