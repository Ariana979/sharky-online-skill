// Sharky platform bridge (vendored build artifact)
// namespace: delta-bridge · kernel sdkVersion: ea309f7b7585 · generated: 2026-07-03
// Regenerate: bun skills/sharky-online/scripts/regen-bridge.ts
(function () {
  const NS = "delta-bridge";
  const VERSION = "1.0.0";
  const BRIDGE_KEY = "__DELTA_BRIDGE__";
  const RUNTIME_KEY = "__DELTA_RUNTIME__";
  const SHOULD_SEND_INIT = true;
  const IS_EMBEDDED = !!(window.parent && window.parent !== window);
  const TARGET_ORIGIN = (() => {
    try {
      const o = document.referrer ? new URL(document.referrer).origin : "";
      return o && o !== "null" ? o : "*";
    } catch {
      return "*";
    }
  })();

  const existingBridge =
    window[BRIDGE_KEY] && typeof window[BRIDGE_KEY] === "object"
      ? window[BRIDGE_KEY]
      : {};
  const existingRuntime =
    window[RUNTIME_KEY] && typeof window[RUNTIME_KEY] === "object"
      ? window[RUNTIME_KEY]
      : {};
  const bridge = {
    ...existingRuntime,
    ...existingBridge,
    ns: NS,
    version: VERSION,
    bootstrap:
      existingBridge.bootstrap || existingRuntime.bootstrap || null,
    wsConfig:
      existingBridge.wsConfig || existingRuntime.wsConfig || null,
    relaySocket:
      existingBridge.relaySocket || existingRuntime.relaySocket || null,
    __injectedByWorker: true,
    locale: (function () {
      try {
        var lang = (navigator.language || "en").toLowerCase();
        if (lang.startsWith("zh")) return "zh-CN";
        if (lang.startsWith("ja")) return "ja";
        if (lang.startsWith("ko")) return "ko";
        if (lang.startsWith("de")) return "de";
        if (lang.startsWith("es")) return "es";
        if (lang.startsWith("pt")) return "pt";
        return "en";
      } catch (e) { return "en"; }
    })(),
  };
  window[BRIDGE_KEY] = bridge;
  window[RUNTIME_KEY] = bridge;
  const pendingRelayMessages =
    existingBridge._pendingRelayMessages ||
    existingRuntime._pendingRelayMessages ||
    [];
  bridge._pendingRelayMessages = pendingRelayMessages;

  function emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    } catch (err) {
      console.warn("[delta-bridge] event dispatch failed:", err);
    }
  }

  function normalizeBootstrapPayload(payload) {
    if (!payload || typeof payload !== "object") return null;
    if (
      payload.type === "network_bootstrap" &&
      payload.payload &&
      typeof payload.payload === "object"
    ) {
      return payload.payload;
    }
    if (
      payload.action === "game:network-bootstrap" &&
      payload.payload &&
      typeof payload.payload === "object"
    ) {
      return payload.payload;
    }
    if (
      payload.data &&
      typeof payload.data === "object" &&
      payload.data.room &&
      payload.data.network
    ) {
      return payload.data;
    }
    return payload;
  }

  function decodeBase64Url(input) {
    if (!input) return "";
    const normalized = String(input)
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const padding =
      normalized.length % 4 === 0
        ? ""
        : "=".repeat(4 - (normalized.length % 4));
    return atob(normalized + padding);
  }

  function inferGameIdFromLocation() {
    const fromPath = String(window.location.pathname || "").match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i
    );
    if (fromPath && fromPath[0]) return fromPath[0];
    const hash = String(window.location.hash || "");
    const fromHash = hash.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i
    );
    if (fromHash && fromHash[0]) return fromHash[0];
    return null;
  }

  function inferBootstrapEndpoint(params) {
    const explicit =
      params.get("bootstrap_endpoint") ||
      window.__DELTA_BOOTSTRAP_ENDPOINT__ ||
      "";
    if (explicit) return String(explicit);
    const origin = String(window.location.origin || "").trim();
    if (!origin || origin === "null") return null;
    return `${origin}/functions/v1/game_bootstrap`;
  }

  function getRoomValue(bootstrap, key) {
    if (!bootstrap || typeof bootstrap !== "object") return undefined;
    if (bootstrap[key] !== undefined && bootstrap[key] !== null)
      return bootstrap[key];
    const room = bootstrap.room;
    if (
      room &&
      typeof room === "object" &&
      room[key] !== undefined &&
      room[key] !== null
    )
      return room[key];
    return undefined;
  }

  function getUserValue(bootstrap, key) {
    if (!bootstrap || typeof bootstrap !== "object") return undefined;
    if (bootstrap[key] !== undefined && bootstrap[key] !== null)
      return bootstrap[key];
    const user = bootstrap.user;
    if (
      user &&
      typeof user === "object" &&
      user[key] !== undefined &&
      user[key] !== null
    )
      return user[key];
    return undefined;
  }

  function getCurrentRole() {
    const bootstrap = bridge.bootstrap;
    const role =
      getUserValue(bootstrap, "role") || bootstrap?.role || "client";
    return String(role).toLowerCase() === "host" ? "host" : "client";
  }

  function getCurrentSyncMode() {
    const bootstrap = bridge.bootstrap || {};
    const syncMode =
      bootstrap?.sync_mode ||
      bootstrap?.syncMode ||
      bootstrap?.network?.sync_mode ||
      bootstrap?.network?.syncMode ||
      null;
    return syncMode ? String(syncMode).toLowerCase() : "relay";
  }

  function getRoomInfo() {
    const bootstrap = bridge.bootstrap || {};
    const syncMode = getCurrentSyncMode();
    return {
      room_id:
        getRoomValue(bootstrap, "room_id") ||
        getRoomValue(bootstrap, "id") ||
        null,
      room_key: getRoomValue(bootstrap, "room_key") || null,
      instance_id: getRoomValue(bootstrap, "instance_id") || null,
      game_url: getRoomValue(bootstrap, "game_url") || null,
      role: getCurrentRole(),
      user_id:
        getUserValue(bootstrap, "user_id") ||
        getUserValue(bootstrap, "id") ||
        null,
      host_user_id:
        bootstrap?.host_user_id || bootstrap?.user?.host_id || null,
      sync_mode: syncMode,
      authority_mode:
        bootstrap?.authority_mode ||
        bootstrap?.authorityMode ||
        bootstrap?.network?.authority_mode ||
        bootstrap?.network?.authorityMode ||
        (syncMode === "server_sim" ? "server_sim" : "host_client"),
      requested_sync_mode:
        bootstrap?.requested_sync_mode ||
        bootstrap?.requestedSyncMode ||
        bootstrap?.network?.requested_sync_mode ||
        bootstrap?.network?.requestedSyncMode ||
        null,
      sync_mode_downgraded:
        !!(
          bootstrap?.sync_mode_downgraded ||
          bootstrap?.syncModeDowngraded ||
          bootstrap?.network?.sync_mode_downgraded ||
          bootstrap?.network?.syncModeDowngraded
        ),
      sync_mode_downgrade_reason:
        bootstrap?.sync_mode_downgrade_reason ||
        bootstrap?.syncModeDowngradeReason ||
        bootstrap?.network?.sync_mode_downgrade_reason ||
        bootstrap?.network?.syncModeDowngradeReason ||
        null,
    };
  }

  function emitRoleChanged(reason, extra) {
    emit("delta:role-changed", {
      reason: reason || "update",
      ...getRoomInfo(),
      ...(extra && typeof extra === "object" ? extra : {}),
    });
  }

  function normalizeWsConfig(bootstrap) {
    if (!bootstrap || typeof bootstrap !== "object") return null;
    const raw =
      bootstrap.ws_config ||
      bootstrap.ws ||
      bootstrap.relay ||
      bootstrap?.network?.ws_config ||
      null;
    if (!raw || typeof raw !== "object") return null;
    const portNumber = Number(raw.port);
    return {
      host: raw.host || null,
      port: Number.isFinite(portNumber) ? portNumber : undefined,
      path: raw.path || "/miniapp-ws",
      secure: typeof raw.secure === "boolean" ? raw.secure : undefined,
      namespace:
        raw.namespace ||
        raw.networkNamespace ||
        bootstrap?.network_namespace ||
        bootstrap?.networkNamespace ||
        bootstrap?.room?.namespace ||
        "app",
      instance_id:
        raw.instance_id ||
        raw.instanceId ||
        bootstrap?.instance_id ||
        bootstrap?.instanceId ||
        bootstrap?.room?.instance_id ||
        bootstrap?.room?.instanceId ||
        undefined,
      room_key:
        raw.room_key ||
        raw.roomKey ||
        bootstrap?.room_key ||
        bootstrap?.roomKey ||
        bootstrap?.room?.room_key ||
        bootstrap?.room?.roomKey ||
        undefined,
      sync_mode:
        raw.sync_mode ||
        raw.syncMode ||
        bootstrap?.sync_mode ||
        bootstrap?.syncMode ||
        bootstrap?.network?.sync_mode ||
        bootstrap?.network?.syncMode ||
        undefined,
      game_url:
        raw.game_url ||
        raw.gameUrl ||
        bootstrap?.game_url ||
        bootstrap?.gameUrl ||
        bootstrap?.game?.game_url ||
        bootstrap?.game?.gameUrl ||
        bootstrap?.network?.game_url ||
        bootstrap?.network?.gameUrl ||
        undefined,
      runtime_ai_url:
        raw.runtime_ai_url ||
        raw.runtimeAiUrl ||
        bootstrap?.runtime_ai_url ||
        bootstrap?.runtimeAiUrl ||
        bootstrap?.network?.runtime_ai_url ||
        bootstrap?.network?.runtimeAiUrl ||
        undefined,
      runtime_ai_flavor_url:
        raw.runtime_ai_flavor_url ||
        raw.runtimeAiFlavorUrl ||
        bootstrap?.runtime_ai_flavor_url ||
        bootstrap?.runtimeAiFlavorUrl ||
        bootstrap?.network?.runtime_ai_flavor_url ||
        bootstrap?.network?.runtimeAiFlavorUrl ||
        undefined,
      url: typeof raw.url === "string" ? raw.url : undefined,
    };
  }

  function relayCandidateKey(candidate) {
    if (!candidate || typeof candidate !== "object") return "";
    const endpointKey = [
      candidate.host || "",
      candidate.port || "",
      candidate.path || "",
      candidate.namespace || "",
      candidate.room_key || "",
      candidate.url || "",
    ].join("|");
    if (endpointKey.replace(/\|/g, "")) return `endpoint:${endpointKey}`;
    if (candidate.id) return `id:${candidate.id}`;
    return "";
  }

  function normalizeRelayCandidate(raw, bootstrap, fallback) {
    if (!raw || typeof raw !== "object") return null;
    const portNumber = Number(raw.port ?? fallback?.port);
    const cfg = {
      id: raw.id || raw.relay_id || raw.relayId || fallback?.id || null,
      region: raw.region || fallback?.region || null,
      host: raw.host || fallback?.host || null,
      port: Number.isFinite(portNumber) ? portNumber : fallback?.port,
      path: raw.path || fallback?.path || "/miniapp-ws",
      secure:
        typeof raw.secure === "boolean"
          ? raw.secure
          : fallback?.secure,
      namespace:
        raw.namespace ||
        fallback?.namespace ||
        bootstrap?.network_namespace ||
        bootstrap?.networkNamespace ||
        bootstrap?.room?.namespace ||
        "app",
      instance_id:
        raw.instance_id ||
        raw.instanceId ||
        fallback?.instance_id ||
        bootstrap?.instance_id ||
        bootstrap?.instanceId ||
        bootstrap?.room?.instance_id ||
        bootstrap?.room?.instanceId ||
        undefined,
      room_key:
        raw.room_key ||
        raw.roomKey ||
        fallback?.room_key ||
        fallback?.roomKey ||
        bootstrap?.room_key ||
        bootstrap?.roomKey ||
        bootstrap?.room?.room_key ||
        bootstrap?.room?.roomKey ||
        undefined,
      sync_mode:
        raw.sync_mode ||
        raw.syncMode ||
        fallback?.sync_mode ||
        fallback?.syncMode ||
        bootstrap?.sync_mode ||
        bootstrap?.syncMode ||
        bootstrap?.network?.sync_mode ||
        bootstrap?.network?.syncMode ||
        undefined,
      game_url:
        raw.game_url ||
        raw.gameUrl ||
        fallback?.game_url ||
        fallback?.gameUrl ||
        bootstrap?.game_url ||
        bootstrap?.gameUrl ||
        bootstrap?.game?.game_url ||
        bootstrap?.game?.gameUrl ||
        bootstrap?.network?.game_url ||
        bootstrap?.network?.gameUrl ||
        undefined,
      runtime_ai_url:
        raw.runtime_ai_url ||
        raw.runtimeAiUrl ||
        fallback?.runtime_ai_url ||
        fallback?.runtimeAiUrl ||
        bootstrap?.runtime_ai_url ||
        bootstrap?.runtimeAiUrl ||
        bootstrap?.network?.runtime_ai_url ||
        bootstrap?.network?.runtimeAiUrl ||
        undefined,
      runtime_ai_flavor_url:
        raw.runtime_ai_flavor_url ||
        raw.runtimeAiFlavorUrl ||
        fallback?.runtime_ai_flavor_url ||
        fallback?.runtimeAiFlavorUrl ||
        bootstrap?.runtime_ai_flavor_url ||
        bootstrap?.runtimeAiFlavorUrl ||
        bootstrap?.network?.runtime_ai_flavor_url ||
        bootstrap?.network?.runtimeAiFlavorUrl ||
        undefined,
      url: typeof raw.url === "string" ? raw.url : fallback?.url,
      priority: Number.isFinite(Number(raw.priority))
        ? Number(raw.priority)
        : fallback?.priority,
      role: raw.role || fallback?.role || "candidate",
    };
    if (!cfg.url && !cfg.host) return null;
    return cfg;
  }

  function relayFailoverEnabledForBootstrap(bootstrap) {
    const role = String(
      getUserValue(bootstrap, "role") || bootstrap?.role || "client"
    ).toLowerCase();
    if (role !== "host") return false;

    const trace =
      bootstrap?.relay_pick_trace ||
      bootstrap?.relayPickTrace ||
      bootstrap?.network?.relay_pick_trace ||
      bootstrap?.network?.relayPickTrace ||
      null;
    if (trace && typeof trace === "object") {
      if (typeof trace.client_failover_enabled === "boolean") {
        return trace.client_failover_enabled;
      }
      if (typeof trace.clientFailoverEnabled === "boolean") {
        return trace.clientFailoverEnabled;
      }
    }
    return true;
  }

  function normalizeRelayCandidates(bootstrap, defaultCfg) {
    const out = [];
    const seen = {};
    function push(candidate) {
      const normalized = normalizeRelayCandidate(candidate, bootstrap, defaultCfg);
      if (!normalized) return;
      const key = relayCandidateKey(normalized);
      if (!key || seen[key]) return;
      seen[key] = true;
      out.push(normalized);
    }

    if (defaultCfg) {
      push({ ...defaultCfg, priority: 0, role: "default" });
    }

    const raw =
      bootstrap?.relay_candidates ||
      bootstrap?.relayCandidates ||
      bootstrap?.network?.relay_candidates ||
      bootstrap?.network?.relayCandidates ||
      [];
    if (Array.isArray(raw)) {
      raw
        .slice()
        .sort((a, b) => Number(a?.priority || 999) - Number(b?.priority || 999))
        .forEach(push);
    }

    // Only the host may try alternate relays. A non-host joining another relay
    // would create a second physical room with the same logical room_key.
    if (!relayFailoverEnabledForBootstrap(bootstrap)) {
      return out.slice(0, 1);
    }
    return out;
  }

  function prioritizeRelayCandidate(candidates, preferred) {
    if (!preferred || !Array.isArray(candidates) || candidates.length <= 1) {
      return Array.isArray(candidates) ? candidates.slice() : [];
    }
    const preferredKey = relayCandidateKey(preferred);
    if (!preferredKey) return candidates.slice();

    const out = [];
    const seen = {};
    const normalizedPreferred = normalizeRelayCandidate(
      preferred,
      bridge.bootstrap,
      bridge.wsConfig || bridge.defaultWsConfig
    );
    if (normalizedPreferred) {
      const key = relayCandidateKey(normalizedPreferred);
      if (key) {
        seen[key] = true;
        out.push({ ...normalizedPreferred, role: normalizedPreferred.role || "last_successful" });
      }
    }

    for (const candidate of candidates) {
      const key = relayCandidateKey(candidate);
      if (!key || seen[key]) continue;
      seen[key] = true;
      out.push(candidate);
    }
    return out;
  }

  function rotateRelayCandidates(candidates, startIndex) {
    if (!Array.isArray(candidates) || candidates.length <= 1) {
      return Array.isArray(candidates) ? candidates.slice() : [];
    }
    const offset = Math.abs(Number(startIndex) || 0) % candidates.length;
    if (!offset) return candidates.slice();
    return candidates.slice(offset).concat(candidates.slice(0, offset));
  }

  function appendRelayParamsToConfiguredUrl(rawUrl, params) {
    try {
      const raw = String(rawUrl);
      const parsed = new URL(raw, window.location.href);
      params.forEach((value, key) => {
        if (!parsed.searchParams.has(key)) {
          parsed.searchParams.set(key, value);
        }
      });
      if (!/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(raw)) {
        return `${parsed.pathname}${parsed.search}${parsed.hash}`;
      }
      return parsed.toString();
    } catch {
      return String(rawUrl);
    }
  }

  function buildRelayUrl(cfg, bootstrap) {
    const params = new URLSearchParams();
    const roomId =
      getRoomValue(bootstrap, "room_id") ||
      getRoomValue(bootstrap, "id");
    const instanceId =
      getRoomValue(bootstrap, "instance_id") || cfg.instance_id;
    const roomKey =
      getRoomValue(bootstrap, "room_key") || cfg.room_key;
    const userId =
      getUserValue(bootstrap, "user_id") ||
      getUserValue(bootstrap, "id");
    const gameUrl =
      cfg.game_url ||
      cfg.gameUrl ||
      getRoomValue(bootstrap, "game_url") ||
      bootstrap?.game_url ||
      bootstrap?.gameUrl ||
      bootstrap?.game?.game_url ||
      bootstrap?.game?.gameUrl ||
      bootstrap?.network?.game_url ||
      bootstrap?.network?.gameUrl;
    const role = getUserValue(bootstrap, "role");
    const displayName =
      getUserValue(bootstrap, "display_name") ||
      getUserValue(bootstrap, "name") ||
      getUserValue(bootstrap, "nickname");
    if (roomId) params.set("room_id", String(roomId));
    if (instanceId) params.set("instance_id", String(instanceId));
    if (roomKey) params.set("room_key", String(roomKey));
    if (gameUrl) params.set("game_url", String(gameUrl));
    if (userId) params.set("user_id", String(userId));
    if (role) params.set("role", String(role));
    if (displayName) params.set("name", String(displayName));
    if (cfg.namespace) params.set("namespace", String(cfg.namespace));
    const syncMode =
      cfg.sync_mode ||
      bootstrap?.sync_mode ||
      bootstrap?.syncMode ||
      bootstrap?.network?.sync_mode ||
      bootstrap?.network?.syncMode;
    if (syncMode) params.set("sync_mode", String(syncMode));
    const runtimeAIURL =
      cfg.runtime_ai_url ||
      cfg.runtimeAiUrl ||
      bootstrap?.runtime_ai_url ||
      bootstrap?.runtimeAiUrl ||
      bootstrap?.network?.runtime_ai_url ||
      bootstrap?.network?.runtimeAiUrl;
    const runtimeAIFlavorURL =
      cfg.runtime_ai_flavor_url ||
      cfg.runtimeAiFlavorUrl ||
      bootstrap?.runtime_ai_flavor_url ||
      bootstrap?.runtimeAiFlavorUrl ||
      bootstrap?.network?.runtime_ai_flavor_url ||
      bootstrap?.network?.runtimeAiFlavorUrl;
    if (runtimeAIURL) params.set("runtime_ai_url", String(runtimeAIURL));
    if (runtimeAIFlavorURL) params.set("runtime_ai_flavor_url", String(runtimeAIFlavorURL));

    const configuredUrl =
      cfg.url && typeof cfg.url === "string" ? cfg.url.trim() : "";
    if (configuredUrl) {
      return appendRelayParamsToConfiguredUrl(configuredUrl, params);
    }
    if (!cfg.host) return null;

    const secure = cfg.secure !== undefined ? !!cfg.secure : true;
    const scheme = secure ? "wss" : "ws";
    const isDefaultPort =
      (secure && cfg.port === 443) ||
      (!secure && cfg.port === 80) ||
      cfg.port === undefined;
    const authority = isDefaultPort
      ? cfg.host
      : `${cfg.host}:${cfg.port}`;
    const pathStr = String(cfg.path || "/miniapp-ws").startsWith("/")
      ? String(cfg.path || "/miniapp-ws")
      : `/${String(cfg.path || "miniapp-ws")}`;

    const qs = params.toString();
    return `${scheme}://${authority}${pathStr}${qs ? `?${qs}` : ""}`;
  }

  function parseRelayMessage(text) {
    try {
      return JSON.parse(String(text || ""));
    } catch {
      return null;
    }
  }

  function updateBootstrapRoleFromRelay(payload) {
    if (!payload || typeof payload !== "object") return;
    const bootstrap = bridge.bootstrap;
    if (!bootstrap || typeof bootstrap !== "object") return;
    const localUserId = String(
      getUserValue(bootstrap, "user_id") ||
        getUserValue(bootstrap, "id") ||
        ""
    );
    if (!localUserId) return;
    const hostUserId = payload.host_user_id
      ? String(payload.host_user_id)
      : "";
    if (!hostUserId) return;
    const nextRole = hostUserId === localUserId ? "host" : "client";
    if (bootstrap.user && typeof bootstrap.user === "object") {
      bootstrap.user.role = nextRole;
      bootstrap.user.host_id = hostUserId;
    }
    bootstrap.role = nextRole;
    bootstrap.host_user_id = hostUserId;
    bridge.bootstrap = bootstrap;
    window[BRIDGE_KEY] = bridge;
    window[RUNTIME_KEY] = bridge;
    emitRoleChanged("relay-host-update", {
      host_user_id: hostUserId,
    });
  }

  function ensureBootstrapCompatibility(bootstrap) {
    if (!bootstrap || typeof bootstrap !== "object") return bootstrap;

    const hasUserObject = !!(
      bootstrap.user && typeof bootstrap.user === "object"
    );
    const user = hasUserObject ? bootstrap.user : {};
    const resolvedUserId =
      user.user_id ||
      user.id ||
      bootstrap.user_id ||
      bootstrap.id ||
      null;
    if (resolvedUserId) {
      user.user_id = String(resolvedUserId);
      user.id = String(resolvedUserId);
      bootstrap.user_id = String(resolvedUserId);
    }
    const resolvedRole = user.role || bootstrap.role || "client";
    user.role = String(resolvedRole);
    bootstrap.role = String(resolvedRole);
    if (!hasUserObject) {
      bootstrap.user = user;
    }

    const hasRoomObject = !!(
      bootstrap.room && typeof bootstrap.room === "object"
    );
    const room = hasRoomObject ? bootstrap.room : {};
    const resolvedRoomId =
      room.room_id ||
      room.id ||
      bootstrap.room_id ||
      bootstrap.game_id ||
      null;
    if (resolvedRoomId) {
      room.room_id = String(resolvedRoomId);
      room.id = String(resolvedRoomId);
      bootstrap.room_id = String(resolvedRoomId);
    }
    const resolvedRoomKey =
      room.room_key || bootstrap.room_key || null;
    if (resolvedRoomKey) {
      room.room_key = String(resolvedRoomKey);
      bootstrap.room_key = String(resolvedRoomKey);
    }
    const resolvedInstanceId =
      room.instance_id || bootstrap.instance_id || null;
    if (resolvedInstanceId) {
      room.instance_id = String(resolvedInstanceId);
      bootstrap.instance_id = String(resolvedInstanceId);
    }
    if (!hasRoomObject) {
      bootstrap.room = room;
    }

    return bootstrap;
  }

  function reportRelayConnectionState(status, details) {
    const payload = {
      status,
      timestamp: Date.now(),
      ...(details && typeof details === "object" ? details : {}),
    };
    bridge.relayConnectionState = payload;
    emit("delta:relay-connection-state", payload);
    postToParent("relay:connection-state", payload);
  }

  function clearRelayReconnectTimer() {
    if (bridge._relayReconnectTimer) {
      clearTimeout(bridge._relayReconnectTimer);
      bridge._relayReconnectTimer = null;
    }
  }

  function closeRelaySocket(socket, code, reason) {
    if (!socket) return;
    try {
      if (
        socket.readyState === WebSocket.CONNECTING ||
        socket.readyState === WebSocket.OPEN
      ) {
        socket.close(code || 4002, reason || "relay_socket_replaced");
      }
    } catch {}
  }

  function ensureRelaySocket(bootstrap, options) {
    if (typeof WebSocket === "undefined") return;

    const cfg = bridge.defaultWsConfig || bridge.wsConfig || normalizeWsConfig(bootstrap);
    if (!cfg) return;
    bridge.wsConfig = cfg;
    bridge.relayCandidates = normalizeRelayCandidates(bootstrap, cfg);

    const existing = bridge.relaySocket;
    if (
      !options?.force &&
      existing &&
      (existing.readyState === WebSocket.OPEN ||
        existing.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    if (
      options?.force &&
      existing &&
      (existing.readyState === WebSocket.OPEN ||
        existing.readyState === WebSocket.CONNECTING)
    ) {
      bridge.relaySocket = null;
      closeRelaySocket(existing, 4002, "relay_reconnect_replaced");
    }

    let candidates = bridge.relayCandidates && bridge.relayCandidates.length
      ? bridge.relayCandidates
      : [cfg];
    if (options?.preferLastSuccessful && bridge._lastSuccessfulRelayCandidate) {
      candidates = prioritizeRelayCandidate(candidates, bridge._lastSuccessfulRelayCandidate);
    } else if (bridge._relayRetryStartIndex) {
      candidates = rotateRelayCandidates(candidates, bridge._relayRetryStartIndex);
    }
    if (!options?.continueRetry) {
      bridge._relayConnectStartedAt = Date.now();
      bridge._relayConnectAttemptCount = 0;
      bridge._relayFailureLoopCount = 0;
    }
    const maxConnectAttempts = Math.max(5, candidates.length || 1);
    const maxConnectWindowMs = 40000;
    const runSeq = (bridge._relayConnectSeq || 0) + 1;
    bridge._relayConnectSeq = runSeq;
    clearRelayReconnectTimer();

    function connectElapsedMs() {
      return Math.max(0, Date.now() - (bridge._relayConnectStartedAt || Date.now()));
    }

    function retryBudgetExhausted() {
      return (
        (bridge._relayConnectAttemptCount || 0) >= maxConnectAttempts ||
        connectElapsedMs() >= maxConnectWindowMs
      );
    }

    function reportRetryBudgetExhausted(reason) {
      reportRelayConnectionState("failed", {
        reason: "retry_budget_exhausted",
        detail_reason: reason || "all_candidates_failed",
        attempts: bridge._relayConnectAttemptCount || 0,
        max_attempts: maxConnectAttempts,
        elapsed_ms: connectElapsedMs(),
        max_elapsed_ms: maxConnectWindowMs,
        terminal: true,
      });
    }

    function connectAt(index, reason) {
      if (bridge._relayConnectSeq !== runSeq) return;
      if (index >= candidates.length) {
        if (retryBudgetExhausted()) {
          reportRetryBudgetExhausted(reason);
          return;
        }
        if (candidates.length > 1) {
          bridge._relayRetryStartIndex =
            ((bridge._relayRetryStartIndex || 0) + 1) % candidates.length;
        }
        var failureLoopCount = bridge._relayFailureLoopCount || 0;
        var retryDelay = Math.min(
          30000,
          Math.round(5000 * Math.pow(1.5, failureLoopCount))
        );
        var remainingBudgetMs = maxConnectWindowMs - connectElapsedMs();
        if (remainingBudgetMs <= 500) {
          reportRetryBudgetExhausted(reason);
          return;
        }
        retryDelay = Math.min(retryDelay, remainingBudgetMs);
        bridge._relayFailureLoopCount = failureLoopCount + 1;
        reportRelayConnectionState("retrying", {
          reason: reason || "all_candidates_failed",
          attempts: bridge._relayConnectAttemptCount || candidates.length,
          max_attempts: maxConnectAttempts,
          elapsed_ms: connectElapsedMs(),
          delay_ms: retryDelay,
        });
        bridge._relayReconnectTimer = setTimeout(function () {
          if (bridge._relayConnectSeq !== runSeq) return;
          bridge.relaySocket = null;
          ensureRelaySocket(bridge.bootstrap || bootstrap, { force: true, continueRetry: true });
        }, retryDelay);
        return;
      }

      if (retryBudgetExhausted()) {
        reportRetryBudgetExhausted(reason);
        return;
      }
      bridge._relayConnectAttemptCount = (bridge._relayConnectAttemptCount || 0) + 1;
      const candidate = candidates[index];
      const relayUrl = buildRelayUrl(candidate, bootstrap);
      if (!relayUrl) {
        connectAt(index + 1, "invalid_candidate");
        return;
      }

      try {
      const socket = new WebSocket(relayUrl);
      bridge.relaySocket = socket;
      bridge.wsConfig = candidate;
      bridge._relayCandidateIndex = index;
      reportRelayConnectionState(index === 0 ? "connecting" : "retrying", {
        relay_id: candidate.id || "",
        region: candidate.region || "",
        host: candidate.host || "",
        priority: candidate.priority ?? index + 1,
        role: candidate.role || "",
        attempt: index + 1,
        total: candidates.length,
        overall_attempt: bridge._relayConnectAttemptCount,
        max_attempts: maxConnectAttempts,
        elapsed_ms: connectElapsedMs(),
        reason: reason || "",
      });

      var _rttSamples = [];
      var _rttMax = 20;
      var _rttTimer = null;
      var _rttReportCounter = 0;
      var _opened = false;
      var _advanced = false;
      var _errorAdvanceTimer = null;
      function _isCurrentSocket() {
        return bridge._relayConnectSeq === runSeq && bridge.relaySocket === socket;
      }
      function _cleanupAttemptTimers() {
        if (_openTimer) { clearTimeout(_openTimer); _openTimer = null; }
        if (_errorAdvanceTimer) { clearTimeout(_errorAdvanceTimer); _errorAdvanceTimer = null; }
      }
      function _advanceToNextCandidate(nextIndex, nextReason) {
        if (_advanced || !_isCurrentSocket()) return;
        _advanced = true;
        _cleanupAttemptTimers();
        _stopPingLoop();
        bridge.relaySocket = null;
        closeRelaySocket(socket, 4003, nextReason || "relay_candidate_failed");
        connectAt(nextIndex, nextReason || "connect_failed");
      }
      var _openTimer = setTimeout(function () {
        if (_opened || !_isCurrentSocket()) return;
        reportRelayConnectionState("retrying", {
          relay_id: candidate.id || "",
          host: candidate.host || "",
          attempt: index + 1,
          total: candidates.length,
          overall_attempt: bridge._relayConnectAttemptCount || 0,
          max_attempts: maxConnectAttempts,
          elapsed_ms: connectElapsedMs(),
          reason: "open_timeout",
        });
        _advanceToNextCandidate(index + 1, "open_timeout");
      }, 7000);
      bridge._rtt = { samples: _rttSamples, latest: 0, avg: 0, min: 0, max: 0 };

      function _updateRttStats() {
        if (!_rttSamples.length) return;
        var sum = 0, mn = Infinity, mx = 0;
        for (var i = 0; i < _rttSamples.length; i++) {
          sum += _rttSamples[i];
          if (_rttSamples[i] < mn) mn = _rttSamples[i];
          if (_rttSamples[i] > mx) mx = _rttSamples[i];
        }
        bridge._rtt.avg = Math.round(sum / _rttSamples.length);
        bridge._rtt.min = mn;
        bridge._rtt.max = mx;
      }

      function _startPingLoop() {
        if (_rttTimer) clearInterval(_rttTimer);
        _rttTimer = setInterval(function () {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
              type: "ping",
              payload: { client_ts: Date.now() },
              timestamp: Date.now(),
            }));
          }
        }, 10000);
      }

      function _stopPingLoop() {
        if (_rttTimer) { clearInterval(_rttTimer); _rttTimer = null; }
      }

      socket.addEventListener("open", () => {
        if (!_isCurrentSocket()) {
          try { socket.close(4001, "stale_socket_open"); } catch {}
          return;
        }
        _opened = true;
        bridge._relayReconnectCount = 0;
        bridge._relayRetryStartIndex = 0;
        bridge._relayFailureLoopCount = 0;
        bridge._lastSuccessfulRelayCandidate = { ...candidate };
        _cleanupAttemptTimers();
        _startPingLoop();
        reportRelayConnectionState("connected", {
          relay_id: candidate.id || "",
          region: candidate.region || "",
          host: candidate.host || "",
          priority: candidate.priority ?? index + 1,
          role: candidate.role || "",
          attempt: index + 1,
          total: candidates.length,
          overall_attempt: bridge._relayConnectAttemptCount || 0,
          max_attempts: maxConnectAttempts,
          elapsed_ms: connectElapsedMs(),
        });
        flushPendingRelayMessages();
        emit("delta:relay-open", {
          url: relayUrl,
          bootstrap,
          wsConfig: candidate,
        });
      });

      socket.addEventListener("message", (event) => {
        if (!_isCurrentSocket()) return;
        const msg = parseRelayMessage(event?.data);
        if (!msg) return;

        if (msg.type === "pong") {
          var p = msg.payload || {};
          var clientTs = p.client_ts;
          if (clientTs) {
            var rtt = Date.now() - clientTs;
            if (rtt >= 0 && rtt < 30000) {
              bridge._rtt.latest = rtt;
              _rttSamples.push(rtt);
              if (_rttSamples.length > _rttMax) _rttSamples.shift();
              _updateRttStats();
              emit("delta:rtt-update", {
                latest: rtt,
                avg: bridge._rtt.avg,
                min: bridge._rtt.min,
                max: bridge._rtt.max,
              });
              _rttReportCounter++;
              if (_rttReportCounter % 3 === 0) {
                socket.send(JSON.stringify({
                  type: "rtt_report",
                  payload: {
                    latest: rtt,
                    avg: bridge._rtt.avg,
                    min: bridge._rtt.min,
                    max: bridge._rtt.max,
                  },
                  timestamp: Date.now(),
                }));
              }
            }
          }
          return;
        }

        emit("delta:relay-message", msg);

        // Notify parent of relay room membership changes.
        // Relay is the source of truth for player discovery — not RTC.
        if (msg.type === "player_joined" || msg.type === "peer_joined") {
          var jp = msg.payload || {};
          postToParent("relay:player-joined", {
            user_id: String(jp.user_id || jp.uid || ""),
            role: jp.role || "client",
            name: jp.name || jp.display_name || "",
            avatar_url: jp.avatar_url || "",
          });
        }
        if (msg.type === "player_left" || msg.type === "peer_left") {
          var lp = msg.payload || {};
          postToParent("relay:player-left", {
            user_id: String(lp.user_id || lp.uid || ""),
          });
        }

        if (msg.type === "network_bootstrap") {
          const nextBootstrap = normalizeBootstrapPayload(
            msg.payload || msg
          );
          applyBootstrap(nextBootstrap);
          return;
        }

        if (msg.type === "state_update") {
          updateBootstrapRoleFromRelay(msg.payload || msg);
          emit("delta:state-update", msg.payload || msg);
          return;
        }

        if (msg.type === "host_changed") {
          updateBootstrapRoleFromRelay(msg.payload || msg);
          emit("delta:host-changed", msg.payload || msg);
          return;
        }

        if (msg.type === "judge_pending") {
          emit("delta:judge-pending", msg.payload || msg);
          return;
        }

        if (msg.type === "ai_response") {
          var aiPayload = msg.payload || {};
          var rid = aiPayload.request_id;

          // Agent-facing requestAI/getAIResult routing. Runtime services use the
          // content lane; keep generic/ai accepted for older in-flight responses.
          var respLane = aiPayload.lane;
          if ((respLane === "generic" || respLane === "content" || respLane === "ai" || (!respLane && aiPayload.id && bridge._aiSlots[aiPayload.id])) && aiPayload.id && bridge._aiSlots[aiPayload.id]) {
            var aSlot = bridge._aiSlots[aiPayload.id];
            if (aiPayload.status === "complete" || aiPayload.status === "ready") {
              var aData = aiPayload.data || {};
              var aResult = aData.result != null ? aData.result : (aData.data != null ? aData.data : aData);
              var aText = aData.text || null;
              if (!aText && typeof aResult === "string") aText = aResult;
              if (!aText && aResult && typeof aResult.structured === "string") aText = aResult.structured;
              if (aText && (!aResult || typeof aResult !== "object" || Array.isArray(aResult))) {
                aResult = { text: aText, value: aResult };
              } else if (aText && aResult && typeof aResult === "object" && aResult.text == null) {
                aResult.text = aText;
              }
              aSlot.status = "ready";
              aSlot.source = "ai";
              aSlot.result = aResult;
              aSlot.text = aText;
            } else if (aiPayload.status === "error") {
              aSlot.status = "failed";
              aSlot.source = "fallback";
            }
            emit("delta:ai-generic", aiPayload);
            return;
          }

          // Lane routing: if response has lane field, route to lane-specific slot
          if (respLane === "flavor" && aiPayload.id && bridge._flavorSlots[aiPayload.id]) {
            var fSlot = bridge._flavorSlots[aiPayload.id];
            if (aiPayload.status === "complete" || aiPayload.status === "ready") {
              var data = aiPayload.data || {};
              fSlot.status = "ready";
              fSlot.source = "ai";
              if (data.text) fSlot.text = data.text;
              if (data.url) fSlot.url = data.url;
            } else if (aiPayload.status === "error") {
              fSlot.status = "failed";
              fSlot.source = "fallback";
            }
            emit("delta:ai-flavor", aiPayload);
            return;
          }

          // Judge lane routing
          if (respLane === "judge" && aiPayload.id && bridge._judgeSlots[aiPayload.id]) {
            var jSlot = bridge._judgeSlots[aiPayload.id];
            if (aiPayload.status === "complete" || aiPayload.status === "ready") {
              var jData = aiPayload.data || {};
              jSlot.status = "ready";
              jSlot.source = "ai";
              // Constrain verdict to allowedVerdicts — never auto-accept
              var allowed = jSlot._allowedVerdicts || [];
              jSlot.verdict = (allowed.indexOf(jData.verdict) >= 0) ? jData.verdict : "unresolved";
              jSlot.confidence = jData.confidence;
              jSlot.reason = jData.reason;
            } else if (aiPayload.status === "error") {
              jSlot.status = "failed";
              jSlot.verdict = "unresolved";
              jSlot.source = "fallback";
            }
            emit("delta:ai-judge", aiPayload);
            return;
          }

          // Director lane routing
          if (respLane === "director" && aiPayload.id && bridge._directorSlots[aiPayload.id]) {
            var dSlot = bridge._directorSlots[aiPayload.id];
            if (aiPayload.status === "complete" || aiPayload.status === "ready") {
              var dData = aiPayload.data || {};
              var dAllowed = dSlot._allowedEffects || [];
              // Constrain proposalType to allowedEffects — reject if not in list
              if (dData.proposalType && dAllowed.indexOf(dData.proposalType) >= 0) {
                dSlot.status = "ready";
                dSlot.source = "ai";
                dSlot.proposalType = dData.proposalType;
                dSlot.payload = dData.payload || {};
                dSlot.rationale = dData.rationale;
              } else {
                // AI proposed something not in the whitelist — reject silently
                dSlot.status = "failed";
                dSlot.source = "fallback";
              }
            } else if (aiPayload.status === "error") {
              dSlot.status = "failed";
              dSlot.source = "fallback";
            }
            emit("delta:ai-director", aiPayload);
            return;
          }

          emit("delta:ai-response", aiPayload);
          return;
        }

        if (msg.type === "judge_result") {
          emit("delta:judge-result", msg.payload || msg);
        }
      });

      socket.addEventListener("close", (event) => {
        _cleanupAttemptTimers();
        _stopPingLoop();
        if (!_isCurrentSocket()) return;
        emit("delta:relay-close", {
          code: event.code,
          reason: event.reason || "",
        });
        if (!_opened) {
          _advanceToNextCandidate(index + 1, event.reason || "connect_closed");
          return;
        }
        bridge.relaySocket = null;
        reportRelayConnectionState("disconnected", {
          relay_id: candidate.id || "",
          host: candidate.host || "",
          code: event.code,
          reason: event.reason || "",
          attempt: index + 1,
          total: candidates.length,
        });
        var reconnectCount = bridge._relayReconnectCount || 0;
        var reconnectDelay = Math.min(8000, Math.round(1200 * Math.pow(1.5, reconnectCount)));
        bridge._relayReconnectCount = reconnectCount + 1;
        reportRelayConnectionState("retrying", {
          relay_id: candidate.id || "",
          region: candidate.region || "",
          host: candidate.host || "",
          priority: candidate.priority ?? index + 1,
          role: candidate.role || "",
          attempt: index + 1,
          total: candidates.length,
          reason: "socket_closed_reconnect",
          delay_ms: reconnectDelay,
        });
        bridge._relayReconnectTimer = setTimeout(function () {
          if (bridge._relayConnectSeq !== runSeq) return;
          ensureRelaySocket(bridge.bootstrap || bootstrap, {
            force: true,
            preferLastSuccessful: true,
            reconnect: true,
          });
        }, reconnectDelay);
      });

      socket.addEventListener("error", (event) => {
        emit("delta:relay-error", { event });
        if (!_opened && !_errorAdvanceTimer) {
          _errorAdvanceTimer = setTimeout(function () {
            _advanceToNextCandidate(index + 1, "connect_error");
          }, 500);
        }
      });
      } catch (err) {
        console.warn("[delta-bridge] relay socket init failed:", err);
        connectAt(index + 1, err?.message || "socket_init_failed");
      }
    }

    connectAt(0, "");
  }

  function sendRelay(type, payload) {
    const socket = bridge.relaySocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(
      JSON.stringify({
        type,
        payload: payload ?? {},
        timestamp: Date.now(),
      })
    );
    return true;
  }

  function isPendingAIMessageStillRelevant(item) {
    if (!item || item.type !== "ai_request") return true;
    const payload = item.payload || {};
    const id = payload.id;
    if (!id) return false;
    const lane = payload.lane || "content";
    if (lane === "flavor") {
      const slot = bridge._flavorSlots && bridge._flavorSlots[id];
      return !!slot && slot.status === "pending";
    }
    if (lane === "judge") {
      const slot = bridge._judgeSlots && bridge._judgeSlots[id];
      return !!slot && slot.status === "pending";
    }
    if (lane === "director") {
      const slot = bridge._directorSlots && bridge._directorSlots[id];
      return !!slot && slot.status === "pending";
    }
    const slot = bridge._aiSlots && bridge._aiSlots[id];
    return !!slot && slot.status === "pending";
  }

  function queueRelayMessage(type, payload) {
    pendingRelayMessages.push({ type, payload });
    if (pendingRelayMessages.length > 100) pendingRelayMessages.shift();
    return false;
  }

  function sendRelayWhenReady(type, payload) {
    if (sendRelay(type, payload)) return true;
    queueRelayMessage(type, payload);
    return false;
  }

  function flushPendingRelayMessages() {
    if (!pendingRelayMessages.length) return;
    const toSend = pendingRelayMessages.splice(0);
    for (let i = 0; i < toSend.length; i++) {
      const item = toSend[i];
      if (!isPendingAIMessageStillRelevant(item)) continue;
      if (!sendRelay(item.type, item.payload)) {
        pendingRelayMessages.unshift(item);
        break;
      }
    }
  }

  window.addEventListener("delta:relay-open", flushPendingRelayMessages);

  async function loadStandaloneBootstrap() {
    if (bridge.bootstrap) return bridge.bootstrap;

    const fromGlobal = normalizeBootstrapPayload(
      window.__DELTA_BOOTSTRAP__ ||
        window.__DELTA_RUNTIME_BOOTSTRAP__ ||
        null
    );
    if (fromGlobal) return fromGlobal;

    const params = new URLSearchParams(window.location.search);
    const encoded = params.get("delta_bootstrap");
    if (encoded) {
      try {
        const decoded = decodeBase64Url(encoded);
        const parsed = JSON.parse(decoded);
        const normalized = normalizeBootstrapPayload(parsed);
        if (normalized) return normalized;
      } catch (err) {
        console.warn(
          "[delta-bridge] parse delta_bootstrap failed:",
          err
        );
      }
    }

    const bootstrapEndpoint = inferBootstrapEndpoint(params);
    const gameId =
      params.get("game_id") ||
      params.get("room_id") ||
      inferGameIdFromLocation();
    if (!bootstrapEndpoint || !gameId) return null;

    const payload = {
      game_id: gameId,
      instance_id: params.get("instance_id") || null,
      client: params.get("client") || "standalone",
    };

    const headers = { "content-type": "application/json" };
    const accessToken =
      params.get("access_token") ||
      window.__DELTA_ACCESS_TOKEN__ ||
      null;
    if (accessToken) {
      headers["authorization"] = `Bearer ${accessToken}`;
    }

    try {
      const reqInit = {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      };
      if (!accessToken) {
        reqInit.credentials = "include";
      }
      const resp = await fetch(bootstrapEndpoint, reqInit);
      if (!resp.ok) {
        console.warn(
          "[delta-bridge] standalone bootstrap fetch failed:",
          resp.status
        );
        return null;
      }
      const json = await resp.json();
      return normalizeBootstrapPayload(json);
    } catch (err) {
      console.warn(
        "[delta-bridge] standalone bootstrap request failed:",
        err
      );
      return null;
    }
  }

  function requestJudgeViaHost(input) {
    if (!IS_EMBEDDED) return false;
    try {
      window.parent.postMessage(
        {
          ns: NS,
          action: "judge:request",
          payload: input || {},
          timestamp: Date.now(),
        },
        TARGET_ORIGIN
      );
      return true;
    } catch (err) {
      console.warn(
        "[delta-bridge] requestJudge via host failed:",
        err
      );
      return false;
    }
  }

  function applyBootstrap(bootstrap) {
    if (!bootstrap || typeof bootstrap !== "object") return;
    bootstrap = ensureBootstrapCompatibility(bootstrap);
    bridge.bootstrap = bootstrap;
    window[BRIDGE_KEY] = bridge;
    window[RUNTIME_KEY] = bridge;
    bridge.lastUpdatedAt = Date.now();
    bridge.wsConfig =
      normalizeWsConfig(bootstrap) || bridge.wsConfig;
    bridge.defaultWsConfig = bridge.wsConfig;
    bridge.relayCandidates = normalizeRelayCandidates(bootstrap, bridge.defaultWsConfig);
    emitRoleChanged("bootstrap-applied");
    if (
      bootstrap.sync_mode_downgraded ||
      bootstrap.syncModeDowngraded ||
      bootstrap?.network?.sync_mode_downgraded ||
      bootstrap?.network?.syncModeDowngraded
    ) {
      const room = getRoomInfo();
      console.warn(
        "[delta-bridge] sync mode downgraded:",
        room.requested_sync_mode || "server_sim",
        "->",
        room.sync_mode || "relay",
        room.sync_mode_downgrade_reason || "unknown"
      );
      emit("delta:sync-mode-downgraded", room);
    }
    emit("delta:network-bootstrap", bootstrap);
    if (bridge.wsConfig) {
      emit("delta:relay-config", {
        bootstrap,
        wsConfig: bridge.wsConfig,
      });
      ensureRelaySocket(bootstrap);
    }
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.ns !== NS) return;

    if (data.action === "bridge:ready") {
      bridge.readyAt = Date.now();
      // Capture parent capabilities from bridge:ready response
      if (data.payload && Array.isArray(data.payload.capabilities)) {
        parentCapabilities = data.payload.capabilities;
        bridge.parentCapabilities = parentCapabilities;
      }
      // Capture locale from parent
      if (data.payload && data.payload.locale) {
        bridge.locale = String(data.payload.locale);
      }
      emit("delta:bridge-ready", { capabilities: parentCapabilities, locale: bridge.locale || null });
    }

    if (data.action === "game:network-bootstrap") {
      const bootstrap = normalizeBootstrapPayload(data.payload);
      applyBootstrap(bootstrap);
      return;
    }

    if (
      data.action === "game:data" &&
      data.payload?.type === "network_bootstrap"
    ) {
      const bootstrap = normalizeBootstrapPayload(data.payload);
      applyBootstrap(bootstrap);
      return;
    }

    if (data.action === "judge:result") {
      emit("delta:judge-result", data.payload);
      return;
    }

    if (
      data.action === "game:data" &&
      data.payload?.type === "judge_result"
    ) {
      emit("delta:judge-result", data.payload.payload);
      return;
    }
  });

  if (bridge.bootstrap) {
    applyBootstrap(bridge.bootstrap);
  }
  window.addEventListener("load", () => {
    if (bridge.bootstrap) {
      emitRoleChanged("window-load");
      emit("delta:network-bootstrap", bridge.bootstrap);
      if (bridge.wsConfig) {
        emit("delta:relay-config", {
          bootstrap: bridge.bootstrap,
          wsConfig: bridge.wsConfig,
        });
      }
    }
  });
  if (!bridge.bootstrap && !IS_EMBEDDED) {
    console.warn(
      "[delta-bridge] embedded-only build: standalone bootstrap disabled."
    );
  }

  // --- Capability negotiation ---
  var capabilities = [];
  var parentCapabilities = [];
  bridge.capabilities = capabilities;
  bridge.parentCapabilities = parentCapabilities;

  bridge.hasCapability = function hasCapability(name) {
    return parentCapabilities.indexOf(name) >= 0;
  };

  // --- Player identity state ---
  var playersProfiles = {};
  bridge.playersProfiles = playersProfiles;

  bridge.getPlayers = function getPlayers() { return { ...playersProfiles }; };
  bridge.getPlayer = function getPlayer(uid) { return playersProfiles[String(uid)] || null; };
  bridge.getLocalPlayer = function getLocalPlayer() {
    for (var k in playersProfiles) {
      if (playersProfiles[k] && playersProfiles[k].is_local) return playersProfiles[k];
    }
    return null;
  };
  bridge.requestProfiles = function requestProfiles() { return postToParent("players:request"); };

  // --- Audio proxy ---
  var audioIdCounter = 0;
  bridge.playSound = function playSound(src, options) {
    var id = "snd_" + (++audioIdCounter);
    var opts = options || {};
    return postToParent("audio:play", { id: id, src: src, volume: opts.volume, loop: opts.loop, channel: "sfx" }) ? id : null;
  };
  bridge.setBgm = function setBgm(src, volume) {
    var id = "bgm_" + (++audioIdCounter);
    return postToParent("audio:play", { id: id, src: src, volume: volume, loop: true, channel: "bgm" }) ? id : null;
  };
  bridge.stopSound = function stopSound(id) { return postToParent("audio:stop", { id: id, channel: "sfx" }); };
  bridge.stopBgm = function stopBgm() { return postToParent("audio:stop", { channel: "bgm" }); };
  bridge.setVolume = function setVolume(idOrChannel, vol) {
    var payload = { volume: vol };
    if (idOrChannel === "sfx" || idOrChannel === "bgm") payload.channel = idOrChannel;
    else payload.id = idOrChannel;
    return postToParent("audio:volume", payload);
  };

  function postToParent(action, payload) {
    if (!IS_EMBEDDED) return false;
    try {
      window.parent.postMessage(
        { ns: NS, action: action, payload: payload || {}, timestamp: Date.now() },
        TARGET_ORIGIN
      );
      return true;
    } catch (err) {
      console.warn("[delta-bridge] postToParent failed:", err);
      return false;
    }
  }

  function cloneValue(value) {
    if (value === undefined) return undefined;
    try {
      return structuredClone(value);
    } catch (err) {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch (jsonErr) {
        return value;
      }
    }
  }

  function normalizeMediaStatePayload(payload) {
    var p = payload || {};
    return {
      enabled: !!p.enabled,
      mode: p.mode === "breakout" || p.mode === "stage" ? p.mode : "all",
      audioEnabled: p.audioEnabled !== undefined ? !!p.audioEnabled : !!p.enabled,
      videoEnabled: !!p.videoEnabled,
      isMicMuted: p.isMicMuted !== undefined ? !!p.isMicMuted : !!p.isMuted,
      isCameraOff: !!p.isCameraOff,
      canSpeak: p.canSpeak !== undefined ? !!p.canSpeak : true,
      canSendVideo: p.canSendVideo !== undefined ? !!p.canSendVideo : true,
      groupId: p.groupId === undefined || p.groupId === null || p.groupId === "" ? null : String(p.groupId),
      remoteUserCount: p.remoteUserCount || 0,
      speakers: Array.isArray(p.speakers) ? p.speakers.slice() : [],
    };
  }

  // --- RTC/STT/media proxy ---
  var rtcState = { enabled: false, isMuted: false, isCameraOff: false, remoteUserCount: 0 };
  var mediaState = {
    enabled: false,
    mode: "all",
    audioEnabled: false,
    videoEnabled: false,
    isMicMuted: false,
    isCameraOff: false,
    canSpeak: true,
    canSendVideo: true,
    groupId: null,
    remoteUserCount: 0,
    speakers: []
  };
  var sttState = { isActive: false, provider: "agora", availableProviders: ["agora"] };
  var mediaParticipants = {};
  var mediaGroups = [];
  var videoFrames = {};
  bridge.rtcState = rtcState;
  bridge.mediaState = mediaState;
  bridge.sttState = sttState;
  bridge.mediaParticipants = mediaParticipants;
  bridge.mediaGroups = mediaGroups;
  bridge.videoFrames = videoFrames;
  bridge.startMedia = function (options) { return postToParent("media:start", options || {}); };
  bridge.stopMedia = function () { return postToParent("media:stop"); };
  bridge.toggleMic = function () { return postToParent("media:toggle-mic"); };
  bridge.toggleCamera = function () { return postToParent("media:toggle-camera"); };
  bridge.startRtc = function () { return postToParent("rtc:start"); };
  bridge.stopRtc = function () { return postToParent("rtc:stop"); };
  bridge.toggleAudio = function () { return postToParent("rtc:toggle-audio"); };
  bridge.toggleVideo = function () { return postToParent("rtc:toggle-video"); };
  bridge.startStt = function () { return postToParent("stt:start"); };
  bridge.stopStt = function () { return postToParent("stt:stop"); };
  bridge.setSttProvider = function (providerId) { return postToParent("stt:set-provider", { providerId: String(providerId || "") }); };
  bridge.getRtcState = function () { return { ...rtcState }; };
  bridge.getMediaState = function () { return cloneValue(mediaState) || { ...mediaState }; };
  bridge.getMediaParticipants = function () { return cloneValue(mediaParticipants) || {}; };
  bridge.getMediaGroups = function () { return cloneValue(mediaGroups) || []; };
  bridge.getRtcSpeaking = function () { return { speakers: Array.isArray(mediaState.speakers) ? mediaState.speakers.slice() : [] }; };
  bridge.getSttState = function () { return { ...sttState }; };
  bridge.getSttProvider = function () { return sttState.provider || null; };
  bridge.listSttProviders = function () { return Array.isArray(sttState.availableProviders) ? sttState.availableProviders.slice() : []; };
  bridge.getVideoFrames = function () { return videoFrames; };
  bridge.getVideoFrame = function (uid) { return videoFrames[String(uid || "local")] || null; };
  bridge.listVideoUsers = function () { return Object.keys(videoFrames); };
  bridge.media = {
    start: bridge.startMedia,
    stop: bridge.stopMedia,
    toggleMic: bridge.toggleMic,
    toggleCamera: bridge.toggleCamera,
    getState: bridge.getMediaState,
    getParticipants: bridge.getMediaParticipants,
    getGroups: bridge.getMediaGroups,
    getVideoFrame: bridge.getVideoFrame,
    listVideoUsers: bridge.listVideoUsers,
    drawVideo: function () { return false; }
  };
  bridge.stt = {
    start: bridge.startStt,
    stop: bridge.stopStt,
    setProvider: bridge.setSttProvider,
    getState: bridge.getSttState,
    getProvider: bridge.getSttProvider,
    listProviders: bridge.listSttProviders,
  };
  bridge.hostMedia = {
    setMode: function (mode) { return postToParent("host-media:set-mode", { mode: mode }); },
    setGroups: function (groups) { return postToParent("host-media:set-groups", { groups: Array.isArray(groups) ? groups : [] }); },
    setSpeakers: function (userIds) { return postToParent("host-media:set-speakers", { userIds: Array.isArray(userIds) ? userIds : [] }); },
    setMuted: function (userIds, muted) { return postToParent("host-media:set-muted", { userIds: Array.isArray(userIds) ? userIds : [], muted: !!muted }); },
    setVideoAllowed: function (userIds, allowed) { return postToParent("host-media:set-video-allowed", { userIds: Array.isArray(userIds) ? userIds : [], allowed: !!allowed }); },
    moveToGroup: function (userId, groupId) { return postToParent("host-media:move-user", { userId: String(userId || ""), groupId: groupId === undefined ? null : groupId }); }
  };

  // Listen for parent messages (player identity, audio, RTC, STT)
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.ns !== NS) return;

    // Player identity messages
    if (data.action === "players:profiles" && data.payload) {
      var pp = data.payload.players;
      if (pp && typeof pp === "object") {
        playersProfiles = {};
        for (var pk in pp) { playersProfiles[pk] = pp[pk]; }
        bridge.playersProfiles = playersProfiles;
        emit("delta:players-profiles", { players: playersProfiles });
      }
    }

    if (data.action === "players:update" && data.payload) {
      var pu = data.payload;
      var puid = String(pu.user_id || "");
      if (puid) {
        if (pu.event === "left") {
          delete playersProfiles[puid];
        } else {
          playersProfiles[puid] = pu;
        }
        bridge.playersProfiles = playersProfiles;
        emit("delta:player-update", pu);
      }
    }

    // Audio state callback
    if (data.action === "audio:state" && data.payload) {
      emit("delta:audio-state", data.payload);
    }

    if (data.action === "media:state" && data.payload) {
      mediaState = normalizeMediaStatePayload(data.payload);
      rtcState.enabled = mediaState.enabled;
      rtcState.isMuted = mediaState.isMicMuted;
      rtcState.isCameraOff = mediaState.isCameraOff;
      rtcState.remoteUserCount = mediaState.remoteUserCount;
      bridge.mediaState = mediaState;
      bridge.rtcState = rtcState;
      emit("delta:media-state", cloneValue(mediaState));
      emit("delta:rtc-state", { ...rtcState });
      return;
    }

    if (data.action === "media:participants" && data.payload && data.payload.participants && typeof data.payload.participants === "object") {
      mediaParticipants = {};
      for (var mpk in data.payload.participants) mediaParticipants[mpk] = data.payload.participants[mpk];
      bridge.mediaParticipants = mediaParticipants;
      emit("delta:media-participants", { participants: cloneValue(mediaParticipants) || {} });
      return;
    }

    if (data.action === "media:groups" && data.payload && Array.isArray(data.payload.groups)) {
      mediaGroups = cloneValue(data.payload.groups) || [];
      bridge.mediaGroups = mediaGroups;
      emit("delta:media-groups", { groups: cloneValue(mediaGroups) || [] });
      return;
    }

    if (data.action === "rtc:state" && data.payload) {
      var r = data.payload || {};
      rtcState.enabled = !!r.enabled;
      rtcState.isMuted = !!r.isMuted;
      rtcState.isCameraOff = !!r.isCameraOff;
      rtcState.remoteUserCount = r.remoteUserCount || 0;
      mediaState.enabled = rtcState.enabled;
      mediaState.audioEnabled = rtcState.enabled;
      mediaState.videoEnabled = !rtcState.isCameraOff;
      mediaState.isMicMuted = rtcState.isMuted;
      mediaState.isCameraOff = rtcState.isCameraOff;
      mediaState.remoteUserCount = rtcState.remoteUserCount;
      bridge.rtcState = rtcState;
      bridge.mediaState = mediaState;
      emit("delta:media-state", cloneValue(mediaState));
      emit("delta:rtc-state", { ...rtcState });
      return;
    }

    if (data.action === "stt:state" && data.payload) {
      sttState.isActive = !!data.payload.isActive;
      if (data.payload.provider) sttState.provider = data.payload.provider;
      if (data.payload.language) sttState.language = data.payload.language;
      if (Array.isArray(data.payload.availableProviders)) sttState.availableProviders = data.payload.availableProviders.slice();
      bridge.sttState = sttState;
      emit("delta:stt-state", { ...sttState });
      return;
    }

    if (data.action === "stt:transcript" && data.payload) {
      var transcript = data.payload;
      emit("delta:stt-transcript", transcript);
      if (transcript && transcript.isFinal) {
        emit("delta:stt-final", transcript);
      } else {
        emit("delta:stt-partial", transcript);
      }
      return;
    }
  });

  bridge.sendAction = function sendAction(action) {
    return sendRelay("player_action", action);
  };
  bridge.sendStateSync = function sendStateSync(state) {
    return sendRelay("state_sync", { state });
  };
  bridge.getRelayRTT = function getRelayRTT() {
    var r = bridge._rtt || {};
    return { latest: r.latest || 0, avg: r.avg || 0, min: r.min || 0, max: r.max || 0 };
  };
  bridge.reportRuntimeTelemetry = function reportRuntimeTelemetry(name, payload) {
    var detail = {
      name: String(name || "runtime"),
      payload: cloneValue(payload) || {},
      room: getRoomInfo(),
    };
    emit("delta:runtime-telemetry", detail);
    return postToParent("telemetry:runtime", detail);
  };
  bridge.getRole = function getRole() {
    return getCurrentRole();
  };
  bridge.isHost = function isHost() {
    return getCurrentRole() === "host";
  };
  bridge.getRoomInfo = function getRoomInfoPublic() {
    return getRoomInfo();
  };
  // ── Runtime AI ──────────────────────────────────────────────────────────
  // Agent-facing experiment: expose one generic AI interface. The old lane
  // helpers remain internally for backward compatibility, but new games should
  // reason from requestAI/getAIResult instead of pre-defined AI categories.
  bridge._aiSlots = {};          // id → GenericAIResult
  bridge._flavorSlots = {};      // id → FlavorResult
  bridge._judgeSlots = {};       // id → JudgeDecision
  bridge._directorSlots = {};    // id → DirectorProposal
  bridge._laneRequestCounter = 0;
  bridge._recentAIEvents = [];   // max 5, auto + game code events
  bridge._aiBudget = { generic: { used: 0, max: 20 }, flavor: { used: 0, max: 30 }, judge: { used: 0, max: 10 }, director: { used: 0, max: 5 } };
  bridge._laneThrottle = {};     // idempotencyKey → timestamp (10s throttle)

  function pushAIEvent(text, source) {
    bridge._recentAIEvents.push({ text: text, source: source || "auto", at: Date.now() });
    if (bridge._recentAIEvents.length > 5) bridge._recentAIEvents.shift();
  }

  function buildLaneEnvelope(lane, id) {
    return {
      id: id,
      lane: lane,
      roomId: (getRoomInfo() || {}).roomKey || "",
      phase: "unknown", // SDK will override with actual phase
      requestedBy: "host",
      requestedAt: Date.now(),
      idempotencyKey: lane + ":" + id,
    };
  }

  bridge.requestAI = function requestAI(id, opts, sdkPhase) {
    opts = opts || {};
    if (getCurrentRole() !== "host") return;
    if (!id) return;
    if (opts.fallback == null) {
      console.warn("[delta-bridge] requestAI: fallback is required");
      return;
    }
    var existing = bridge._aiSlots[id];
    if (existing && (existing.status === "pending" || existing.status === "ready")) return;
    if (bridge._aiBudget.generic.used >= bridge._aiBudget.generic.max) {
      bridge._aiSlots[id] = { status: "failed", result: opts.fallback, source: "fallback" };
      return;
    }
    var throttleKey = "content:" + id;
    var now = Date.now();
    if (bridge._laneThrottle[throttleKey] && now - bridge._laneThrottle[throttleKey] < 10000) return;
    bridge._laneThrottle[throttleKey] = now;

    bridge._aiBudget.generic.used++;
    bridge._aiSlots[id] = { status: "pending", result: opts.fallback, source: "fallback" };

    var envelope = buildLaneEnvelope("content", id);
    if (sdkPhase) envelope.phase = sdkPhase;
    var sent = sendRelayWhenReady("ai_request", {
      ...envelope,
      publicInput: {
        prompt: (opts.prompt || "") + (opts.input ? "\nInput: " + JSON.stringify(opts.input) : ""),
        fallbackData: opts.fallback,
        schema: opts.schema || null,
        fallbackText: typeof opts.fallback === "string" ? opts.fallback : null,
        timeoutMs: opts.timeoutMs || 15000,
      },
      runtimeSnapshot: {
        phase: envelope.phase,
        playerCount: Object.keys((getRoomInfo() || {}).players || {}).length || 0,
        recentEvents: bridge._recentAIEvents.map(function(e) { return e.text; }),
      },
    });

    if (!sent) bridge._aiSlots[id].queued = true;

    var timeoutMs = opts.timeoutMs || 15000;
    setTimeout(function() {
      var slot = bridge._aiSlots[id];
      if (slot && slot.status === "pending") {
        slot.status = "failed";
        slot.source = "fallback";
      }
    }, timeoutMs);
  };

  bridge.getAIResult = function getAIResult(id) {
    return bridge._aiSlots[id] || null;
  };

  /**
   * requestFlavor — fire-and-forget content generation.
   * Game code polls via getFlavor(id).
   */
  bridge.requestFlavor = function requestFlavor(id, opts, sdkPhase) {
    opts = opts || {};
    // Policy: host-only (soft)
    if (getCurrentRole() !== "host") return;
    // Policy: text type must have fallback; image/video can be without (just won't show)
    var flavorType = opts.type || "text";
    if (flavorType === "text" && opts.fallbackText == null) {
      console.warn("[delta-bridge] requestFlavor: text type must have fallbackText");
      return;
    }
    // Dedup: if slot already exists and is pending/ready, skip entirely.
    // Prevents re-firing while request is in-flight (images ~20s, video ~50s) and
    // also avoids wasted re-requests after successful completion.
    var existing = bridge._flavorSlots[id];
    if (existing && (existing.status === "pending" || existing.status === "ready")) {
      return;
    }
    // Policy: budget check (soft)
    if (bridge._aiBudget.flavor.used >= bridge._aiBudget.flavor.max) {
      bridge._flavorSlots[id] = { status: "failed", text: opts.fallbackText || null, url: opts.fallbackUrl || null, source: "fallback" };
      return;
    }
    // Policy: throttle (10s between retries after failure)
    var throttleKey = "flavor:" + id;
    var now = Date.now();
    if (bridge._laneThrottle[throttleKey] && now - bridge._laneThrottle[throttleKey] < 10000) return;
    bridge._laneThrottle[throttleKey] = now;

    bridge._aiBudget.flavor.used++;
    bridge._flavorSlots[id] = { status: "pending", text: opts.fallbackText || null, url: opts.fallbackUrl || null, source: "fallback" };

    // Build wire-format message
    var envelope = buildLaneEnvelope("flavor", id);
    if (sdkPhase) envelope.phase = sdkPhase;
    var sent = sendRelayWhenReady("ai_request", {
      ...envelope,
      publicInput: {
        type: opts.type || "text",
        prompt: opts.prompt || "",
        fallbackText: opts.fallbackText || null,
        fallbackUrl: opts.fallbackUrl || null,
        timeoutMs: opts.timeoutMs || 15000,
      },
      runtimeSnapshot: {
        phase: envelope.phase,
        playerCount: Object.keys((getRoomInfo() || {}).players || {}).length || 0,
        recentEvents: bridge._recentAIEvents.map(function(e) { return e.text; }),
      },
    });

    if (!sent) bridge._flavorSlots[id].queued = true;

    // Timeout → auto-degrade
    var timeoutMs = opts.timeoutMs || 15000;
    setTimeout(function() {
      var slot = bridge._flavorSlots[id];
      if (slot && slot.status === "pending") {
        slot.status = "failed";
        slot.source = "fallback";
      }
    }, timeoutMs);
  };

  bridge.getFlavor = function getFlavor(id) {
    return bridge._flavorSlots[id] || null;
  };

  bridge.logAIEvent = function logAIEvent(desc) {
    if (typeof desc === "string" && desc.length > 0) {
      pushAIEvent(desc, "game");
    }
  };

  /**
   * requestJudge (lane) — fire-and-forget judgment request.
   * AI verdict MUST be one of allowedVerdicts.
   * Failure = 'unresolved', NEVER auto-accept.
   * Game code polls via getJudge(id), then commits via sendAction.
   */
  bridge.requestJudgeLane = function requestJudgeLane(id, opts, sdkPhase) {
    opts = opts || {};
    if (getCurrentRole() !== "host") return;
    if (!opts.allowedVerdicts || !Array.isArray(opts.allowedVerdicts) || opts.allowedVerdicts.length < 2) {
      console.warn("[delta-bridge] requestJudge: allowedVerdicts must have at least 2 options");
      return;
    }
    // Dedup: skip if request already in-flight or completed
    var existingJ = bridge._judgeSlots[id];
    if (existingJ && (existingJ.status === "pending" || existingJ.status === "ready")) {
      return;
    }
    if (bridge._aiBudget.judge.used >= bridge._aiBudget.judge.max) {
      bridge._judgeSlots[id] = { status: "failed", verdict: "unresolved", source: "fallback" };
      return;
    }
    var throttleKey = "judge:" + id;
    var now = Date.now();
    if (bridge._laneThrottle[throttleKey] && now - bridge._laneThrottle[throttleKey] < 10000) return;
    bridge._laneThrottle[throttleKey] = now;

    bridge._aiBudget.judge.used++;
    bridge._judgeSlots[id] = { status: "pending", verdict: "unresolved", source: "fallback" };

    var envelope = buildLaneEnvelope("judge", id);
    if (sdkPhase) envelope.phase = sdkPhase;
    var sent = sendRelayWhenReady("ai_request", {
      ...envelope,
      publicInput: {
        task: opts.task || "custom",
        input: opts.input || {},
        allowedVerdicts: opts.allowedVerdicts,
        timeoutMs: opts.timeoutMs || 10000,
      },
      runtimeSnapshot: {
        phase: envelope.phase,
        playerCount: Object.keys((getRoomInfo() || {}).players || {}).length || 0,
        recentEvents: bridge._recentAIEvents.map(function(e) { return e.text; }),
      },
    });

    if (!sent) bridge._judgeSlots[id].queued = true;

    // Store allowedVerdicts for response validation
    bridge._judgeSlots[id]._allowedVerdicts = opts.allowedVerdicts;

    var timeoutMs = opts.timeoutMs || 10000;
    setTimeout(function() {
      var slot = bridge._judgeSlots[id];
      if (slot && slot.status === "pending") {
        slot.status = "failed";
        slot.verdict = "unresolved";
        slot.source = "fallback";
      }
    }, timeoutMs);
  };

  bridge.getJudgeLane = function getJudgeLane(id) {
    var slot = bridge._judgeSlots[id];
    if (!slot) return null;
    // Don't expose internal fields
    return { status: slot.status, verdict: slot.verdict, confidence: slot.confidence, reason: slot.reason, source: slot.source };
  };

  /**
   * requestDirector (lane) — fire-and-forget gameplay adjustment proposal.
   * AI proposalType MUST be in allowedEffects (restricted vocabulary).
   * No proposal on failure — game continues without adjustment.
   * Game code polls via getDirectorProposal(id), then commits via sendAction.
   */
  bridge.requestDirectorLane = function requestDirectorLane(id, opts, sdkPhase) {
    opts = opts || {};
    if (getCurrentRole() !== "host") return;
    var validEffects = { spawn_modifier: 1, loot_modifier: 1, visibility_modifier: 1, phase_event: 1 };
    if (!opts.allowedEffects || !Array.isArray(opts.allowedEffects) || opts.allowedEffects.length < 1) {
      console.warn("[delta-bridge] requestDirector: allowedEffects required");
      return;
    }
    for (var ei = 0; ei < opts.allowedEffects.length; ei++) {
      if (!validEffects[opts.allowedEffects[ei]]) {
        console.warn("[delta-bridge] requestDirector: invalid effect '" + opts.allowedEffects[ei] + "'");
        return;
      }
    }
    var validCheckpoints = { round_end: 1, wave_end: 1, chapter_start: 1 };
    if (!validCheckpoints[opts.checkpoint]) {
      console.warn("[delta-bridge] requestDirector: invalid checkpoint '" + opts.checkpoint + "'");
      return;
    }
    // Dedup: skip if request already in-flight or completed
    var existingD = bridge._directorSlots[id];
    if (existingD && (existingD.status === "pending" || existingD.status === "ready")) {
      return;
    }
    if (bridge._aiBudget.director.used >= bridge._aiBudget.director.max) {
      bridge._directorSlots[id] = { status: "failed", source: "fallback" };
      return;
    }
    var throttleKey = "director:" + id;
    var now = Date.now();
    if (bridge._laneThrottle[throttleKey] && now - bridge._laneThrottle[throttleKey] < 10000) return;
    bridge._laneThrottle[throttleKey] = now;

    bridge._aiBudget.director.used++;
    bridge._directorSlots[id] = { status: "pending", source: "fallback" };

    var envelope = buildLaneEnvelope("director", id);
    if (sdkPhase) envelope.phase = sdkPhase;
    var sent = sendRelayWhenReady("ai_request", {
      ...envelope,
      publicInput: {
        checkpoint: opts.checkpoint,
        allowedEffects: opts.allowedEffects,
        context: opts.context || {},
        timeoutMs: opts.timeoutMs || 10000,
      },
      runtimeSnapshot: {
        phase: envelope.phase,
        playerCount: Object.keys((getRoomInfo() || {}).players || {}).length || 0,
        recentEvents: bridge._recentAIEvents.map(function(e) { return e.text; }),
      },
    });

    if (!sent) bridge._directorSlots[id].queued = true;

    bridge._directorSlots[id]._allowedEffects = opts.allowedEffects;

    var timeoutMs = opts.timeoutMs || 10000;
    setTimeout(function() {
      var slot = bridge._directorSlots[id];
      if (slot && slot.status === "pending") {
        slot.status = "failed";
        slot.source = "fallback";
      }
    }, timeoutMs);
  };

  bridge.getDirectorProposalLane = function getDirectorProposalLane(id) {
    var slot = bridge._directorSlots[id];
    if (!slot) return null;
    return { status: slot.status, proposalType: slot.proposalType, payload: slot.payload, rationale: slot.rationale, source: slot.source };
  };

  // Legacy judge (non-lane, backward compat for old games)
  bridge.requestJudge = function requestJudge(payload) {
    const input = payload || {};
    const sentToRelay = sendRelay("judge_request", input);
    if (sentToRelay) return true;
    return requestJudgeViaHost(input);
  };
  window.sendRoomAction = function sendRoomAction(action) {
    return bridge.sendAction(action);
  };
  // Agent-facing AI lives on ctx.requestAI/getAIResult.
  window.requestJudge = function requestJudge(payload) {
    return bridge.requestJudge(payload);
  };
  window.getDeltaRoomInfo = function getDeltaRoomInfo() {
    return bridge.getRoomInfo();
  };
  window.__DELTA_RUNTIME__ = bridge;
  window.__DELTA_BRIDGE__ = bridge;

  if (SHOULD_SEND_INIT && IS_EMBEDDED) {
    capabilities = ["player-identity", "audio"];
    bridge.capabilities = capabilities;
    // Forward game-declared capabilities so the parent can tailor auto-behavior.
    // null means the game didn't declare capabilities (legacy / no-voice games).
    var gameConfig = window.__DELTA_GAME_CONFIG__ || {};
    var gameCapabilities = Array.isArray(gameConfig.capabilities) ? gameConfig.capabilities : null;
    window.parent.postMessage(
      {
        ns: NS,
        action: "bridge:init",
        payload: { version: VERSION, capabilities: capabilities, gameCapabilities: gameCapabilities },
        timestamp: Date.now(),
      },
      TARGET_ORIGIN
    );
  }

  // ── Error forwarding: capture runtime errors and send to parent ──
  // Parent can collect these for bug diagnosis when user edits the game.
  if (IS_EMBEDDED) {
    var _errBuffer = [];
    var _errFlushTimer = null;
    var MAX_ERRORS = 20;

    function _pushError(msg) {
      if (_errBuffer.length >= MAX_ERRORS) return;
      _errBuffer.push(msg);
      if (!_errFlushTimer) {
        _errFlushTimer = setTimeout(function () {
          _errFlushTimer = null;
          if (_errBuffer.length === 0) return;
          window.parent.postMessage(
            { ns: NS, action: "bridge:runtime-errors", payload: { errors: _errBuffer.slice() }, timestamp: Date.now() },
            TARGET_ORIGIN
          );
          _errBuffer = [];
        }, 2000);
      }
    }

    // Capture uncaught errors
    window.addEventListener("error", function (e) {
      _pushError(e.message + (e.filename ? " (" + e.filename.split("/").pop() + ":" + e.lineno + ")" : ""));
    });

    // Capture unhandled promise rejections
    window.addEventListener("unhandledrejection", function (e) {
      _pushError("UnhandledRejection: " + (e.reason && e.reason.message ? e.reason.message : String(e.reason)));
    });

    // Intercept console.error
    var _origConsoleError = console.error;
    console.error = function () {
      _origConsoleError.apply(console, arguments);
      var msg = Array.prototype.slice.call(arguments).map(function (a) {
        return typeof a === "object" ? (a && a.message ? a.message : JSON.stringify(a)) : String(a);
      }).join(" ");
      if (msg.includes("favicon") || msg.includes("[delta-sdk]")) return; // skip noisy
      _pushError(msg);
    };
  }
})();
