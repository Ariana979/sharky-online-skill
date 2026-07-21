// sharky-net.js — thin multiplayer client for free-form HTML games on sharky.gg.
//
// Transport model (verified in production 2026-07-03):
//   - Every client sends {type:'OP', op} actions; the server-side sim (running
//     the shim game config extracted from this page) orders them into
//     state.log and broadcasts state_update to everyone.
//   - Ordered delivery, no loss observed; op round-trip ≈ 350-500ms. Do local
//     echo for your own inputs; treat onOp as the authoritative ordering.
//   - Shared KV via {type:'SETKV', k, v} — value ≤ 4KB, ≤128 keys (shim caps).
//   - players() lists a client only after the room has seen ≥1 action from
//     them (mock and real rooms alike; the sim registers lazily on first
//     action, not on join). sharky-net self-registers on open with a system
//     SETKV so presence is correct before the game sends anything.
//   - The ordered log replays to (re)joiners; ops from that history carry
//     meta.replayed=true (horizon = the log already present in the first
//     state_update seen after open).
//
// Requires bridge.js to be loaded BEFORE this file (the build script does it).
// In local dev, a harness can set window.__SHARKY_LOCAL_BUS__ before this file
// to swap the transport for an in-page mock with identical semantics.
(function () {
  'use strict';

  // In the platform sim's sandbox (headless vm that executes every inline
  // script) there is no event-capable window — exit silently so this script
  // is a no-op there. Game scripts must likewise guard on typeof SharkyNet.
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;

  var listeners = { op: [], phase: [], players: [], update: [], open: [], connection: [] };
  var state = {
    open: false,
    phase: 'lobby',
    epoch: null, // sim generation id (_epoch), see applyState
    lastSeq: 0,
    shared: {},
    players: {},
    game: null, // authoritative __SHARKY_RULES__ state (sim-run; mock runs it locally)
    stats: { sent: 0, dropped: 0, applied: 0, replayedApplied: 0, deltaApplied: 0, selfEcho: 0, stateUpdates: 0, lastRttMs: 0 },
  };
  var SEND_MIN_INTERVAL_MS = 66; // ≤15 msg/s — under the relay budget with headroom
  var OP_MAX_CHARS = 2048;
  var lastSentAt = 0;
  var readyResolvers = [];
  var mock = null;
  var replayWatermark = null; // seq horizon at join: entries at/below it are replayed history

  // Mock-only rules ticker: the real sim drives __SHARKY_RULES__.onTick
  // from its own loop (~30 ticks/s, dt in seconds); offline nothing else
  // would, so tick-driven rules state (timers, decision windows) froze at
  // init and net.game() silently diverged from the live room. Ticked once
  // per mock state frame (~150ms), dt wall-anchored so a throttled tab
  // catches up on total time, not frame count.
  var mockRulesTickAt = 0;
  function mockRulesTick() {
    if (!mock) return;
    var R = window.__SHARKY_RULES__ || null;
    if (!R || typeof R.onTick !== 'function') return;
    if (!state.game) { state.game = {}; if (typeof R.init === 'function') { try { R.init(state.game); } catch (e) {} } }
    var now = Date.now();
    if (!mockRulesTickAt) { mockRulesTickAt = now; return; }
    var dt = (now - mockRulesTickAt) / 1000;
    mockRulesTickAt = now;
    if (dt <= 0) return;
    try { R.onTick(state.game, dt); } catch (e) {}
  }

  function bridge() { return window.__DELTA_BRIDGE__ || window.__DELTA_RUNTIME__ || null; }

  // Mock transport (dev harness). The real bridge.js loads after the harness
  // shim and rebuilds window.__DELTA_BRIDGE__, so identity must come from the
  // mock itself — never from the clobbered bridge — when a mock is active.
  function mockBus() { return window.__SHARKY_LOCAL_BUS__ || null; }
  function mockIdentity() {
    var m = mockBus();
    return m && typeof m.identity === 'function' ? m.identity() : null;
  }

  function emit(name, a, b) {
    var arr = listeners[name] || [];
    for (var i = 0; i < arr.length; i++) {
      try { arr[i](a, b); } catch (e) { console.warn('[sharky-net] listener error:', e); }
    }
  }

  function me() {
    var mid = mockIdentity();
    if (mid) return { id: String(mid.user_id || 'local'), isHost: !!mid.isHost, room: mid.room_id || 'mock-room' };
    var b = bridge();
    var info = (b && b.getRoomInfo && b.getRoomInfo()) || {};
    return {
      id: String(info.user_id || 'local'),
      isHost: !!(b && b.isHost && b.isHost()),
      room: info.room_id || null,
    };
  }

  function sendRaw(action) {
    if (!mock && mockBus()) { mock = mockBus(); mock.onState(applyState); markOpen(); }
    if (mock) return mock.send(action);
    var b = bridge();
    if (!b || typeof b.sendAction !== 'function') return false;
    action.user_id = String((b.getRoomInfo() || {}).user_id || '');
    action.client_ts = Date.now();
    return b.sendAction(action);
  }

  // Sim generations: `_epoch` (the sim session id) rides every snapshot.
  // A rewarmed sim normally CONTINUES seq (server-side ms-seeding), so an
  // epoch flip alone is informational; if seq did regress (older sims),
  // resync — drop the monotonic dedup floor and let this frame's log
  // re-enter as join history. Epochs are only ever honored once (seen-set):
  // a late frame from the previous socket cannot flip us back.
  var seenEpochs = {};

  // P1-8 link-quality tiers. Freshness (time since the last state_update)
  // is the primary signal — a ping can look fine while the world has
  // stopped arriving; smoothed op RTT is secondary. Thresholds are measured
  // platform bands: healthy op RTT median ~400ms / p95 ~780ms — a NORMAL
  // long-haul link brushes 800, so good runs to 1100 (EMA cushion past p95);
  // the 3s line matches the staleMs drop threshold and the keyframe
  // insurance interval. Hysteresis: enter a worse tier after ~1.5s sustained,
  // return after ~2s of better readings — jitter must not flap the tier.
  var QUALITY_RTT_DEGRADED_MS = 1100;
  var QUALITY_FRESH_DEGRADED_MS = 1800; // idle rooms tick ~1/s (sim clock) — 1000 sat on the beat edge
  var QUALITY_FRESH_CRITICAL_MS = 3000;
  var quality = { tier: 'good', candidate: 'good', candidateSince: 0, rttEma: 0, lastUpdateAt: 0 };
  function computeTierNow() {
    if (!api.connected()) return 'critical';
    var age = quality.lastUpdateAt ? (performance.now() - quality.lastUpdateAt) : 0;
    if (age > QUALITY_FRESH_CRITICAL_MS) return 'critical';
    if (age > QUALITY_FRESH_DEGRADED_MS) return 'degraded';
    if (quality.rttEma > QUALITY_RTT_DEGRADED_MS) return 'degraded';
    var b = bridge();
    if (b && b._rtt && b._rtt.avg > 900) return 'degraded'; // smoothed, matching the EMA philosophy — a single slow ping must not flip the tier
    return 'good';
  }
  var TIER_RANK = { good: 0, degraded: 1, critical: 2 };
  function stepQuality() {
    // claims that never echo (link died for good) time out with op=null
    var cutoff = Date.now() - 30000;
    for (var ck in pendingClaims) {
      if (pendingClaims[ck].at < cutoff) {
        var timedOut = pendingClaims[ck];
        delete pendingClaims[ck];
        try { timedOut.fn(null, { timedOut: true }); } catch (e) {}
      }
    }
    var now = performance.now();
    var t = computeTierNow();
    if (t === quality.candidate) {
      var held = now - quality.candidateSince;
      var need = TIER_RANK[t] > TIER_RANK[quality.tier] ? 1500 : 2000; // worse: 1.5s sustained, better: 2s
      if (t !== quality.tier && held >= need) {
        quality.tier = t;
        emit('connection', { kind: 'quality', tier: t });
      }
    } else {
      quality.candidate = t;
      quality.candidateSince = now;
    }
  }
  setInterval(stepQuality, 500);
  // P1-5 delta frames: increments (new log entries + changed KV keys) with
  // periodic full keyframes (_key). Deltas are meaningless without this
  // epoch's keyframe baseline — skip them until one arrives (joins force an
  // immediate keyframe server-side, so the wait is ~one frame).
  var sawKeyframeEpoch = null;

  function applyState(st) {
    if (!st || typeof st !== 'object') return;
    state.stats.stateUpdates++;
    quality.lastUpdateAt = performance.now();
    if (st._epoch && st._epoch !== state.epoch && !seenEpochs[st._epoch]) {
      seenEpochs[st._epoch] = 1;
      var prevEpoch = state.epoch;
      state.epoch = st._epoch;
      var resync = false;
      if (prevEpoch && Array.isArray(st.log) && st.log.length) {
        var head = Number(st.log[st.log.length - 1].s) || 0;
        if (head > 0 && head <= state.lastSeq) {
          state.lastSeq = 0;
          replayWatermark = null;
          resync = true;
        }
      }
      if (prevEpoch) {
        announceSelf(); // rewarmed sims start with an empty KV — refresh receipts
        emit('connection', { kind: 'epoch', epoch: state.epoch, resync: resync });
      }
    }
    var isDelta = !!st._delta;
    var frameEpoch = String(st._epoch || 'none');
    if (!isDelta) {
      // the keyframe authorizes deltas of ITS OWN epoch only (a late
      // keyframe from a previous sim generation must not arm the current
      // generation's deltas)
      sawKeyframeEpoch = frameEpoch;
    } else if (frameEpoch !== sawKeyframeEpoch || frameEpoch !== String(state.epoch || 'none')) {
      return; // stale-generation or pre-baseline delta
    } else if (typeof st._base === 'number' && st._base > state.lastSeq) {
      // continuity gap: we missed frames (disconnect) — applying this delta
      // would jump lastSeq past the hole and bury the missed ops forever;
      // wait for the keyframe the sim sends on reconnect
      return;
    }
    if (isDelta) state.stats.deltaApplied++;
    if (st._phase && st._phase !== state.phase) { state.phase = st._phase; emit('phase', state.phase); }
    if (st.kv && typeof st.kv === 'object') {
      if (isDelta) {
        // delta frames carry only CHANGED keys — merge (the shim contract
        // has no key deletion, so merge is exact)
        for (var dk in st.kv) { if (dk.indexOf('__sys_') !== 0) state.shared[dk] = st.kv[dk]; }
      } else {
        var hasSys = false;
        for (var sk in st.kv) { if (sk.indexOf('__sys_') === 0) { hasSys = true; break; } }
        if (hasSys) {
          state.shared = {};
          for (var fk in st.kv) { if (fk.indexOf('__sys_') !== 0) state.shared[fk] = st.kv[fk]; }
        } else {
          state.shared = st.kv;
        }
      }
    }
    if (st.players && typeof st.players === 'object') { state.players = st.players; emit('players', st.players); }
    if (st.game && typeof st.game === 'object') state.game = st.game; // authoritative rules state (sim)
    if (Array.isArray(st.log)) {
      // Everything already in the log when we first see state is history
      // being replayed to us, not "now" — mark it so games can tell.
      if (replayWatermark === null) {
        var lastLogged = st.log.length ? st.log[st.log.length - 1] : null;
        replayWatermark = lastLogged ? Number(lastLogged.s) || 0 : 0;
      }
      for (var i = 0; i < st.log.length; i++) {
        var entry = st.log[i];
        if (!entry || entry.s <= state.lastSeq) continue;
        state.lastSeq = entry.s;
        state.stats.applied++;
        var replayed = entry.s <= replayWatermark;
        if (replayed) state.stats.replayedApplied++;
        var self = entry.o && entry.o.__tag === TAG;
        if (self) {
          state.stats.selfEcho++;
          if (entry.o.__t) {
            state.stats.lastRttMs = Date.now() - entry.o.__t;
            quality.rttEma = quality.rttEma
              ? quality.rttEma * 0.7 + state.stats.lastRttMs * 0.3
              : state.stats.lastRttMs;
          }
          if (entry.o.__c && pendingClaims[entry.o.__c]) {
            var pc = pendingClaims[entry.o.__c];
            delete pendingClaims[entry.o.__c];
            try { pc.fn(entry.o, { seq: entry.s, rttMs: state.stats.lastRttMs }); } catch (e) {}
          }
        }
        // Mock rooms have no sim — run the game's rules locally (ops in
        // bus order here, onTick per state frame below) so net.game()
        // behaves the same offline.
        if (mock && typeof window.__SHARKY_RULES__ === 'object' && window.__SHARKY_RULES__ && typeof window.__SHARKY_RULES__.onOp === 'function') {
          if (!state.game) { state.game = {}; if (typeof window.__SHARKY_RULES__.init === 'function') { try { window.__SHARKY_RULES__.init(state.game); } catch (e) {} } }
          try { window.__SHARKY_RULES__.onOp(state.game, entry.o, String(entry.u || '')); } catch (e) {}
        }
        var staleMs = staleMsFor(String(entry.u || ''), entry.o && entry.o.__t, performance.now());
        emit('op', entry.o, { seq: entry.s, uid: String(entry.u || ''), self: !!self, replayed: replayed, staleMs: staleMs });
      }
    }
    mockRulesTick();
    emit('update', st);
  }

  var TAG = Math.random().toString(36).slice(2, 8);

  // P1-2 optimistic claims: pending ops awaiting their authoritative echo.
  // Confirmation = your op coming back through the ordered log (bus order IS
  // the arbitration position); the callback fires with the echoed op + rtt.
  var pendingClaims = {};
  var claimSeq = 0;

  // Skew-immune stream freshness (composes with meta.replayed): per-sender
  // "now" is estimated from the newest sender timestamp seen plus receiver
  // monotonic elapsed time — clock OFFSETS between devices cancel out, only
  // rates matter (and those match). meta.staleMs is how old a delivered op
  // is in sender time: after a backgrounded/frozen page drains its buffered
  // updates in a burst, the backlog reads as stale instead of replaying the
  // missed trajectory. (Raw wall-clock comparison was the old cross-device
  // trap this replaces.)
  var senderClocks = {}; // uid -> { estNow, atPerf }
  function staleMsFor(uid, t, nowPerf) {
    if (typeof t !== 'number' || !(t > 0)) return 0;
    var c = senderClocks[uid];
    if (!c) { senderClocks[uid] = { estNow: t, atPerf: nowPerf }; return 0; }
    var est = c.estNow + (nowPerf - c.atPerf);
    if (t > est) est = t;
    c.estNow = est; c.atPerf = nowPerf;
    return Math.max(0, Math.round(est - t));
  }

  // The sim adds a client to players[] only when it sees an action from them,
  // so a joined-but-silent client is invisible to everyone's players()/lobby
  // count (real-room verified 2026-07-07). Self-register once on open; the
  // key is stripped from shared() below.
  var SYS_PRESENCE_KEY = '__sys_presence';

  // Presence + capability receipt. Idempotent, and re-posted on every
  // reconnect and on sim generation flips: a rewarmed sim starts with an
  // empty KV, and without a fresh receipt it would (safely but wastefully)
  // keep the room on full snapshots forever.
  function announceSelf() {
    sendRaw({ type: 'SETKV', k: SYS_PRESENCE_KEY, v: 1 });
    sendRaw({ type: 'SETKV', k: '__sys_caps_' + me().id, v: 'delta-v1' });
  }

  function markOpen() {
    if (state.open) return;
    state.open = true;
    announceSelf();
    emit('open');
    for (var i = 0; i < readyResolvers.length; i++) readyResolvers[i](api);
    readyResolvers.length = 0;
  }

  window.addEventListener('delta:relay-open', markOpen);
  // Link-state surface: games otherwise have no way to tell "network stall"
  // from "game broke" (state.open latches true forever by design).
  window.addEventListener('delta:relay-open', function () {
    if (state.open) announceSelf(); // reconnect: refresh presence + caps
    emit('connection', { kind: 'open' });
  });
  window.addEventListener('delta:relay-close', function () {
    // deltas across a link gap are not trustworthy (we may have missed
    // frames, and the relay may replay a cached delta on reconnect) — drop
    // the baseline; the sim's reconnect keyframe re-arms us
    sawKeyframeEpoch = null;
    emit('connection', { kind: 'closed' });
  });
  window.addEventListener('delta:relay-error', function () { emit('connection', { kind: 'error' }); });
  window.addEventListener('delta:state-update', function (ev) {
    var d = ev.detail || {};
    applyState(d.state || d);
  });

  var api = {
    /** Resolves once the room transport is open (or immediately in mock mode). */
    ready: function () {
      if (window.__SHARKY_LOCAL_BUS__ && !mock) {
        mock = window.__SHARKY_LOCAL_BUS__;
        mock.onState(applyState);
        markOpen();
      }
      if (state.open) return Promise.resolve(api);
      return new Promise(function (res) { readyResolvers.push(res); });
    },

    me: me,
    isHost: function () { return me().isHost; },
    /** Live link state (bridge socket readiness); mock rooms: always true. */
    connected: function () {
      if (mockBus()) return true;
      var b = bridge();
      var s = b && b.relaySocket;
      return !!(s && s.readyState === 1);
    },
    phase: function () { return state.phase; },
    players: function () { return state.players; },
    shared: function () { return state.shared; },
    tag: TAG,

    /** Host-only: move the room from lobby to playing. */
    start: function () { return sendRaw({ type: 'START' }); },

    /**
     * Send an op onto the ordered bus. Returns false if throttled/oversized —
     * coalesce your inputs (e.g. send latest cursor pos, not every event).
     */
    send: function (op) {
      // Queued reliable ops own the next free slot: a saturated stream
      // (per-frame sends) otherwise starves the 90ms drain timer forever —
      // the rAF cadence grabs every slot the moment it opens (measured).
      if (reliableQ.length) { state.stats.dropped++; return false; }
      return sendOp(op);
    },

    /**
     * send() that queues instead of dropping when throttled. For DISCRETE
     * must-arrive ops (finish, score, world event). NOT for streams — a late
     * pose is worse than a lost one; keep poses on send(). Order among
     * reliable ops is preserved. Returns false only when the op is oversized
     * or the queue is full (both mean the caller is misusing it for a stream).
     */
    sendReliable: function (op) {
      // __r marks a discrete must-arrive result op: the sim answers these
      // with an immediate (budgeted) snapshot instead of the next snapshot
      // interval, so outcome feedback does not inherit pose-stream cadence.
      op = Object.assign({}, op, { __r: 1 });
      try { if (JSON.stringify(op).length > OP_MAX_CHARS - 64) return false; } catch (e) { return false; }
      if (api.send(op)) return true;
      if (reliableQ.length >= RELIABLE_Q_MAX) return false;
      reliableQ.push(op);
      return true;
    },

    /** Set a key in the shared KV (≤4KB per value, ≤128 keys). */
    setShared: function (key, value) { return sendRaw({ type: 'SETKV', k: key, v: value }); },

    /**
     * Optimistic claim: sendReliable + a confirm callback that fires when
     * YOUR op returns through the ordered log (its bus position is the
     * authoritative arbitration). Pattern: play the "pending" presentation
     * immediately, reveal the outcome on confirm — the round trip hides
     * inside the suspense window instead of reading as lag. Returns false
     * if the op could not even be queued.
     */
    claim: function (op, onConfirm) {
      var c = ++claimSeq;
      var marked = Object.assign({}, op, { __c: c });
      if (!api.sendReliable(marked)) return false;
      if (typeof onConfirm === 'function') pendingClaims[c] = { fn: onConfirm, at: Date.now() };
      return true;
    },

    /**
     * Link-quality tier: 'good' | 'degraded' | 'critical' (hysteresis
     * built in; thresholds are measured platform bands — see SKILL.md).
     * Also emitted as on('connection', {kind:'quality', tier}) on change.
     */
    quality: function () {
      return {
        tier: quality.tier,
        rttMs: Math.round(quality.rttEma),
        updateAgeMs: quality.lastUpdateAt ? Math.round(performance.now() - quality.lastUpdateAt) : -1,
        connected: api.connected(),
      };
    },

    /**
     * Authoritative rules state (when the game ships a __SHARKY_RULES__
     * script): server-arbitrated, ~400ms confirm. Render optimistically from
     * your local mirror, reconcile from this.
     */
    game: function () { return state.game; },

    on: function (name, fn) {
      (listeners[name] = listeners[name] || []).push(fn);
      return api;
    },

    stats: function () {
      var s = JSON.parse(JSON.stringify(state.stats));
      s.pendingReliable = reliableQ.length;
      s.connected = api.connected();
      s.epoch = state.epoch || null;
      var b = bridge();
      if (b && b._rtt) { s.relayRttMs = b._rtt.latest || 0; s.relayRttAvgMs = b._rtt.avg || 0; }
      return s;
    },
    _applyState: applyState, // exposed for the local mock harness
  };

  // The throttle itself, shared by streams and the reliable drain. The
  // interval adapts to the measured op RTT: on a queued/saturated link,
  // pushing more poses only deepens the very queue everyone's ops (own
  // results included) are sitting in.
  function sendMinIntervalMs() {
    var rtt = state.stats.lastRttMs;
    if (rtt > 2000) return 200;
    if (rtt > 800) return 150;
    if (rtt > 400) return 100;
    return SEND_MIN_INTERVAL_MS;
  }
  function sendOp(op) {
    var now = Date.now();
    if (now - lastSentAt < sendMinIntervalMs()) { state.stats.dropped++; return false; }
    var wrapped = Object.assign({}, op, { __tag: TAG, __t: now });
    try { if (JSON.stringify(wrapped).length > OP_MAX_CHARS) { state.stats.dropped++; return false; } }
    catch (e) { return false; }
    var ok = sendRaw({ type: 'OP', op: wrapped });
    if (ok) { lastSentAt = now; state.stats.sent++; } // a FAILED send must not burn the slot
    return ok;
  }

  // Drain queued reliable ops through the same throttle, oldest first —
  // shares the ≤15/s budget with live send() calls but takes priority for
  // the next slot (see send()); reliable ops are discrete and rare, so a
  // stream loses at most a slot or two per queued op.
  var reliableQ = [];
  var RELIABLE_Q_MAX = 256; // ~17s of backlog at full budget; more = stream misuse
  setInterval(function () {
    if (reliableQ.length && sendOp(reliableQ[0])) reliableQ.shift();
  }, 90);

  window.SharkyNet = api;
})();
