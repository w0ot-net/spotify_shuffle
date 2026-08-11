(function () {
  "use strict";

  const {AuthorizationRevokedError, TokenRejectedError, playlistsEndpoint} = TrueShuffle;
  const authorizeEndpoint = "https://accounts.spotify.com/authorize";
  const tokenEndpoint = "https://accounts.spotify.com/api/token";
  // Spotify caps a page at 50 items and a library at 10,000 playlists.
  const playlistPageLimit = 50;
  const maxPlaylistPages = 200;
  // One serial request lane: a single in-flight Web API call with at least
  // this gap between starts, across listing, reads, writes, and
  // verification. Stepped from 1,000 ms on 2026-08-10 after telemetry
  // recorded 198 clean requests at the old ceiling and only
  // pressure-independent quota 429s; at the observed ~270 ms median request
  // latency the serial lane is now latency-bound, so a smaller gap would
  // change nothing. Still unconfigurable: the next change also comes from
  // telemetry evidence.
  const minStartGapMs = 250;
  const backgroundStorageKey = "trueshuffle.background.v1";
  const cooldownStorageKey = "trueshuffle.spotify-cooldown.v1";
  const likedCooldownStorageKey = "trueshuffle.liked-cooldown.v1";
  const trackCacheDatabaseName = "trueshuffle";
  const trackCacheStoreName = "playlists";
  // Keep the legacy namespace so the product rename preserves browser sessions.
  const tokenStorageKey = "spotify_shuffle.oauth.v1";
  const stateStorageKey = "spotify_shuffle.oauth.state.v1";
  const verifierStorageKey = "spotify_shuffle.oauth.verifier.v1";
  const expirySkewMilliseconds = 60 * 1000;
  const scopes = [
    "playlist-read-private",
    "playlist-modify-public",
    "playlist-modify-private",
    "user-library-read"
  ];
  const likedScope = "user-library-read";
  const playlistWriteScope = "playlist-modify-private";
  // The request policy the telemetry reports: the serial paced lane with
  // one allowed 429 retry.
  const telemetryPolicy = {policy: "serial-250ms-v1", minStartGapMs: minStartGapMs, retryCeiling: 1};
  const telemetryEndpoint = "/api/telemetry";
  // The delivery queue lives in its own database so disconnect can keep
  // deleting the private track cache without touching sanitized pending
  // operational evidence.
  const telemetryQueueDatabaseName = "trueshuffle-telemetry";
  const telemetryQueueStoreName = "queue";
  const telemetryQueueKey = "envelope";

  const statusElement = document.getElementById("status");
  // One dock swatch per background choice; ids follow the vocabulary.
  const backgroundButtons = TrueShuffle.backgroundChoices.map(function (choice) {
    return {choice: choice, button: document.getElementById("background-" + choice)};
  });
  const connectButton = document.getElementById("connect");
  const logoutButton = document.getElementById("logout");
  const playlistStatusElement = document.getElementById("playlist-status");
  const trackStatusElement = document.getElementById("track-status");
  const trackProgressElement = document.getElementById("track-progress");
  const openTargetLink = document.getElementById("open-target");
  const waitStatusElement = document.getElementById("wait-status");
  const cancelButton = document.getElementById("cancel");
  const playlistsElement = document.getElementById("playlists");
  // The list's first row. A hyphen cannot appear in a Spotify id, so this
  // sentinel can never collide with a listed playlist.
  const likedSource = {liked: true, id: "liked-songs", name: TrueShuffle.likedSourceName};
  let publicConfig = null;
  let selectedPlaylist = null;
  let playlistButtons = [];
  // The listing as fetched, retained so the write flow can find an existing
  // derived target by name; a created target is appended so a second
  // shuffle in the same page load overwrites instead of duplicating.
  let listedPlaylists = [];
  // The selected source's verified read: {id, snapshotId, uris}. Liked
  // Songs loads here too, with a null snapshotId.
  let loadedTracks = null;
  // Telemetry: one report per operation, page-scoped session identity, and
  // the page-lifetime request-start history behind the rolling 30-second
  // pressure count. The history deliberately survives operation boundaries
  // and disconnect within one page load.
  let pageSessionId = null;
  let requestStartHistory = [];
  let activeOperation = null;
  // The serial lane's next allowed dispatch time.
  let nextRequestStartAt = 0;

  function applyBackground(value) {
    const choice = TrueShuffle.normalizeBackgroundChoice(value);
    for (const entry of backgroundButtons) {
      entry.button.setAttribute("aria-pressed", entry.choice === choice ? "true" : "false");
    }
    if (choice === TrueShuffle.defaultBackground) {
      delete document.documentElement.dataset.background;
    } else {
      document.documentElement.dataset.background = choice;
    }
    return choice;
  }

  function restoreBackground() {
    let stored = null;
    try {
      stored = window.localStorage.getItem(backgroundStorageKey);
    } catch (_) {
      // The visual preference is optional; the default remains usable.
    }
    const choice = applyBackground(stored);
    if (stored !== null && stored !== choice) {
      try {
        window.localStorage.removeItem(backgroundStorageKey);
      } catch (_) {
        // Invalid preference cleanup is best effort.
      }
    }
  }

  function selectBackground(value) {
    const choice = applyBackground(value);
    try {
      if (choice === TrueShuffle.defaultBackground) {
        window.localStorage.removeItem(backgroundStorageKey);
      } else {
        window.localStorage.setItem(backgroundStorageKey, choice);
      }
    } catch (_) {
      // The current page can still apply a choice without persistence.
    }
  }

  function renderWorking(message) {
    statusElement.textContent = message;
    connectButton.hidden = true;
    logoutButton.hidden = true;
  }

  function renderDisconnected(message) {
    statusElement.textContent = message || "Spotify is not connected in this browser.";
    connectButton.hidden = false;
    connectButton.disabled = false;
    logoutButton.hidden = true;
  }

  function renderConnected() {
    statusElement.textContent = "Spotify is connected in this browser.";
    connectButton.hidden = true;
    logoutButton.hidden = false;
    logoutButton.disabled = false;
  }

  function renderError(message, canReconnect, canDisconnect) {
    statusElement.textContent = message;
    connectButton.hidden = !canReconnect;
    connectButton.disabled = false;
    logoutButton.hidden = !canDisconnect;
    logoutButton.disabled = false;
  }

  function redirectURI() {
    return window.location.origin + "/callback";
  }

  function encodeBase64URL(bytes) {
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return window.btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  function randomBase64URL(byteLength) {
    const bytes = new Uint8Array(byteLength);
    window.crypto.getRandomValues(bytes);
    return encodeBase64URL(bytes);
  }

  async function codeChallenge(verifier) {
    const input = new TextEncoder().encode(verifier);
    const digest = await window.crypto.subtle.digest("SHA-256", input);
    return encodeBase64URL(new Uint8Array(digest));
  }

  async function loadPublicConfig() {
    const response = await window.fetch("/api/config", {
      cache: "no-store",
      credentials: "same-origin"
    });
    if (!response.ok) {
      throw new Error("public configuration request failed");
    }

    const config = await response.json();
    if (!config || typeof config.spotify_client_id !== "string" || config.spotify_client_id === "") {
      throw new Error("public configuration is invalid");
    }
    return config;
  }

  function clearPendingAuthorization() {
    try {
      window.sessionStorage.removeItem(stateStorageKey);
    } catch (_) {
      // Pending authorization cleanup is best effort.
    }
    try {
      window.sessionStorage.removeItem(verifierStorageKey);
    } catch (_) {
      // Pending authorization cleanup is best effort.
    }
  }

  function storePendingAuthorization(state, verifier) {
    try {
      window.sessionStorage.setItem(stateStorageKey, state);
      window.sessionStorage.setItem(verifierStorageKey, verifier);
    } catch (_) {
      clearPendingAuthorization();
      throw new Error("pending authorization could not be stored");
    }
  }

  function readPendingAuthorization() {
    try {
      return {
        state: window.sessionStorage.getItem(stateStorageKey),
        verifier: window.sessionStorage.getItem(verifierStorageKey)
      };
    } catch (_) {
      return {state: null, verifier: null};
    }
  }

  function clearStoredToken() {
    try {
      window.localStorage.removeItem(tokenStorageKey);
    } catch (_) {
      // An unavailable browser store is equivalent to being disconnected.
    }
  }

  function readStoredToken() {
    let raw;
    try {
      raw = window.localStorage.getItem(tokenStorageKey);
    } catch (_) {
      return null;
    }
    if (raw === null) {
      return null;
    }

    try {
      const token = JSON.parse(raw);
      if (TrueShuffle.validTokenRecord(token)) {
        return token;
      }
    } catch (_) {
      // Invalid records are removed below.
    }
    clearStoredToken();
    return null;
  }

  function storeTokenResponse(payload, previousToken) {
    const token = TrueShuffle.buildTokenRecord(payload, previousToken, Date.now());
    window.localStorage.setItem(tokenStorageKey, JSON.stringify(token));
    return token;
  }

  async function requestToken(parameters) {
    const response = await window.fetch(tokenEndpoint, {
      method: "POST",
      headers: {"Content-Type": "application/x-www-form-urlencoded"},
      body: new URLSearchParams(parameters)
    });

    let payload;
    try {
      payload = await response.json();
    } catch (_) {
      throw new TokenRejectedError("Spotify returned a non-JSON token response");
    }
    if (!response.ok) {
      if (payload && payload.error === "invalid_grant") {
        throw new AuthorizationRevokedError("Spotify rejected the token request");
      }
      throw new TokenRejectedError("Spotify rejected the token request");
    }
    return payload;
  }

  async function refreshToken(token) {
    const payload = await requestToken({
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
      client_id: publicConfig.spotify_client_id
    });
    return storeTokenResponse(payload, token);
  }

  function renderPlaylistStatus(message) {
    playlistStatusElement.textContent = message;
    playlistStatusElement.hidden = false;
  }

  function renderTrackStatus(message) {
    trackStatusElement.textContent = message;
    trackStatusElement.hidden = false;
  }

  // Progress is determinate from the moment it appears: the maximum is the
  // server-reported total and every advance is a completed page's raw item
  // count. The aria-live status text stays quiet while the bar moves.
  function renderTrackProgress(loadedCount, total) {
    if (total <= 0) {
      return;
    }
    trackProgressElement.max = total;
    trackProgressElement.value = loadedCount;
    trackProgressElement.hidden = false;
  }

  function clearPlaylists() {
    selectedPlaylist = null;
    loadedTracks = null;
    playlistButtons = [];
    listedPlaylists = [];
    playlistsElement.textContent = "";
    playlistsElement.hidden = true;
    playlistStatusElement.textContent = "";
    playlistStatusElement.hidden = true;
    trackStatusElement.textContent = "";
    trackStatusElement.hidden = true;
    trackProgressElement.hidden = true;
    waitStatusElement.textContent = "";
    waitStatusElement.hidden = true;
    cancelButton.hidden = true;
    openTargetLink.hidden = true;
  }

  function randomHexId() {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    let hex = "";
    for (const byte of bytes) {
      hex += byte.toString(16).padStart(2, "0");
    }
    return hex;
  }

  // One report per operation, opened by the listing and by each shuffle
  // chain; the one-operation UI invariant keeps this module state safe.
  function beginOperation(kind) {
    if (pageSessionId === null) {
      pageSessionId = randomHexId();
    }
    activeOperation = {
      startedMonotonic: window.performance.now(),
      // Disconnect aborts this controller; the lane checks its signal
      // before every wait and dispatch.
      controller: new AbortController(),
      report: {
        report_id: randomHexId(),
        page_session_id: pageSessionId,
        kind: kind,
        client_started_at: Date.now(),
        client_ended_at: 0,
        duration_ms: 0,
        source_total: null,
        source_disposition: "not-applicable",
        target_disposition: "untouched",
        terminal_phase: "abandoned",
        policy: telemetryPolicy.policy,
        policy_min_gap_ms: telemetryPolicy.minStartGapMs,
        policy_retry_ceiling: telemetryPolicy.retryCeiling,
        request_count: 0,
        peak_window_count: 0,
        truncated: false,
        delivery_storage: "one-shot",
        reports_dropped_before: 0,
        events: []
      }
    };
    return activeOperation;
  }

  function setOperationContext(fields) {
    if (activeOperation !== null) {
      Object.assign(activeOperation.report, fields);
    }
  }

  // Delivery is launched unawaited when the operation settles; queue,
  // storage, and transport failure are all contained inside the delivery
  // owner and can never affect the operation that produced the report.
  function finishOperation(operation, terminalPhase) {
    if (operation === null || activeOperation !== operation) {
      return;
    }
    activeOperation = null;
    const report = operation.report;
    report.terminal_phase = terminalPhase;
    report.client_ended_at = Date.now();
    report.duration_ms = Math.max(0, Math.round(
      window.performance.now() - operation.startedMonotonic
    ));
    try {
      deliverTelemetryReport(report).catch(function (_) {
        // Lost telemetry is lost; the operation already rendered.
      });
    } catch (_) {
      // An unavailable delivery path is equivalent to lost transport.
    }
  }

  function submitTelemetryOnce(body) {
    try {
      window.fetch(telemetryEndpoint, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: body,
        keepalive: true,
        credentials: "same-origin"
      }).catch(function (_) {
        // Lost telemetry is lost.
      });
    } catch (_) {
      // An unavailable fetch is equivalent to lost transport.
    }
  }

  function openTelemetryQueue() {
    return new Promise(function (resolve, reject) {
      const request = window.indexedDB.open(telemetryQueueDatabaseName, 1);
      request.onupgradeneeded = function () {
        request.result.createObjectStore(telemetryQueueStoreName);
      };
      request.onsuccess = function () {
        resolve(request.result);
      };
      request.onerror = function () {
        reject(request.error || new Error("telemetry queue could not be opened"));
      };
    });
  }

  // One read/write transaction owns each envelope update, which is what
  // serializes overlapping tabs without a lock abstraction. The mutator is
  // synchronous so the whole read-modify-write commits atomically; a
  // corrupt stored envelope is discarded rather than interpreted.
  function updateTelemetryQueue(database, mutate) {
    return new Promise(function (resolve, reject) {
      const transaction = database.transaction(telemetryQueueStoreName, "readwrite");
      const store = transaction.objectStore(telemetryQueueStoreName);
      const request = store.get(telemetryQueueKey);
      let outcome = null;
      let corrupt = false;
      request.onsuccess = function () {
        let stored = request.result;
        if (stored === undefined) {
          stored = {version: 1, dropped: 0, entries: []};
        } else if (!TrueShuffle.validTelemetryQueueEnvelope(stored)) {
          // Discard corruption: reset the record and report this pass as
          // unavailable rather than interpreting the damage.
          store.put({version: 1, dropped: 0, entries: []}, telemetryQueueKey);
          corrupt = true;
          return;
        }
        outcome = mutate(stored);
        if (outcome.write) {
          store.put(outcome.write, telemetryQueueKey);
        }
      };
      request.onerror = function () {
        reject(request.error);
      };
      transaction.oncomplete = function () {
        if (corrupt) {
          reject(new Error("the telemetry queue record was corrupt"));
          return;
        }
        resolve(outcome === null ? null : outcome.value);
      };
      transaction.onerror = function () {
        reject(transaction.error);
      };
      transaction.onabort = function () {
        reject(transaction.error);
      };
    });
  }

  // Drain has triggers, not a retry loop: page initialization and each
  // successful enqueue. Only a 204 removes a report; the first transport
  // or storage failure stops the pass, and the next trigger retries.
  let telemetryDrainActive = false;

  async function drainTelemetryQueue() {
    if (telemetryDrainActive) {
      return;
    }
    telemetryDrainActive = true;
    try {
      for (;;) {
        const database = await openTelemetryQueue();
        let oldest = null;
        try {
          oldest = await updateTelemetryQueue(database, function (envelope) {
            return {value: envelope.entries.length > 0 ? envelope.entries[0] : null};
          });
        } finally {
          database.close();
        }
        if (oldest === null) {
          return;
        }
        const response = await window.fetch(telemetryEndpoint, {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: oldest.body,
          keepalive: true,
          credentials: "same-origin"
        });
        if (response.status !== 204) {
          return;
        }
        const removal = await openTelemetryQueue();
        try {
          await updateTelemetryQueue(removal, function (envelope) {
            return {
              write: Object.assign({}, envelope, {
                entries: envelope.entries.filter(function (entry) {
                  return entry.id !== oldest.id;
                })
              }),
              value: null
            };
          });
        } finally {
          removal.close();
        }
      }
    } catch (_) {
      // The queue keeps the report; a later trigger retries.
    } finally {
      telemetryDrainActive = false;
    }
  }

  // Enqueue before transport so an acknowledged report is the only kind
  // that ever leaves the queue; without usable queue storage the report
  // degrades to the one-shot path and says so.
  async function deliverTelemetryReport(report) {
    const failed = report.events.some(function (event) {
      return event.result !== "ok";
    });
    try {
      const database = await openTelemetryQueue();
      try {
        await updateTelemetryQueue(database, function (envelope) {
          report.delivery_storage = "indexeddb";
          report.reports_dropped_before = Math.min(1000, envelope.dropped);
          const entry = {
            id: report.report_id,
            failed: failed,
            body: TrueShuffle.encodeTelemetryReport(report)
          };
          return {
            write: TrueShuffle.queueTelemetryReport(
              envelope, entry, TrueShuffle.telemetryQueueLimit
            ),
            value: null
          };
        });
      } finally {
        database.close();
      }
      await drainTelemetryQueue();
    } catch (_) {
      report.delivery_storage = "queue-unavailable";
      submitTelemetryOnce(TrueShuffle.encodeTelemetryReport(report));
    }
  }

  // Opens the sanitized event for one dispatched request: bounded role,
  // class, method, and workload numbers only -- raw URLs and payloads never
  // leave this normalizer.
  function beginRequestEvent(url, role, body, method) {
    const rolled = TrueShuffle.rollingRequestHistory(requestStartHistory, Date.now());
    requestStartHistory = rolled.starts;
    if (activeOperation === null) {
      return null;
    }
    const report = activeOperation.report;
    report.request_count += 1;
    if (rolled.count > report.peak_window_count) {
      report.peak_window_count = rolled.count;
    }
    const parameters = new URL(url, "https://api.spotify.com").searchParams;
    const rawOffset = parameters.get("offset");
    const rawLimit = parameters.get("limit");
    const event = {
      role: role,
      endpoint_class: TrueShuffle.telemetryEndpointClass(role),
      method: body !== undefined ? (method || "POST") : "GET",
      attempt: 1,
      scheduled_wait_ms: 0,
      started_at: Date.now(),
      start_offset_ms: Math.max(0, Math.round(
        window.performance.now() - activeOperation.startedMonotonic
      )),
      duration_ms: 0,
      result: "network-error",
      status: null,
      retry_after_state: "absent",
      retry_after_seconds: null,
      reason: null,
      request_items: body && Array.isArray(body.uris)
        ? TrueShuffle.normalizeTelemetryCount(body.uris.length)
        : null,
      response_items: null,
      page_offset: rawOffset === null
        ? null
        : TrueShuffle.normalizeTelemetryCount(Number(rawOffset)),
      page_limit: rawLimit === null
        ? null
        : TrueShuffle.normalizeTelemetryCount(Number(rawLimit)),
      server_total: null,
      window_count: rolled.count
    };
    report.events.push(event);
    return event;
  }

  // One persisted deadline record behind a page-memory backup for an
  // unwritable store. Invalid and expired records are removed on read; the
  // deadlines are application state, not authorization state, so
  // disconnect never clears them. Two instances exist because Spotify
  // scopes its penalties per endpoint: the general lane cooldown, and the
  // liked-tracks lockout that must never block playlist work.
  function cooldownStore(storageKey) {
    let memoryUntil = 0;
    return {
      store(until) {
        memoryUntil = until;
        try {
          window.localStorage.setItem(storageKey, JSON.stringify({until: until}));
        } catch (_) {
          // The page-memory deadline still applies.
        }
      },
      activeUntil() {
        let until = memoryUntil;
        try {
          const raw = window.localStorage.getItem(storageKey);
          if (raw !== null) {
            const record = JSON.parse(raw);
            if (TrueShuffle.validCooldownRecord(record)) {
              until = Math.max(until, record.until);
            } else {
              window.localStorage.removeItem(storageKey);
            }
          }
        } catch (_) {
          // An unreadable store leaves the page-memory deadline.
        }
        if (until <= Date.now()) {
          if (until !== 0) {
            memoryUntil = 0;
            try {
              window.localStorage.removeItem(storageKey);
            } catch (_) {
              // Expired either way.
            }
          }
          return null;
        }
        return until;
      }
    };
  }

  const spotifyCooldown = cooldownStore(cooldownStorageKey);
  const likedCooldown = cooldownStore(likedCooldownStorageKey);

  function cooldownError(until) {
    const time = new Date(until).toTimeString().slice(0, 8);
    return new TrueShuffle.CooldownActiveError(
      "Spotify asked for a pause. Try again after " + time + ".", until
    );
  }

  function likedLockoutError(until) {
    return new TrueShuffle.CooldownActiveError(
      TrueShuffle.likedLockoutMessage(until - Date.now()), until
    );
  }

  function abortableDelay(milliseconds, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) {
        reject(new TrueShuffle.OperationCancelledError("the operation was cancelled"));
        return;
      }
      function onAbort() {
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
        reject(new TrueShuffle.OperationCancelledError("the operation was cancelled"));
      }
      window.setTimeout(function () {
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
        resolve();
      }, milliseconds);
      if (signal) {
        signal.addEventListener("abort", onAbort);
      }
    });
  }

  const waitNoticeThresholdMs = 2000;

  // Waits at or beyond the notice threshold render a live countdown naming
  // the reason; the routine pacing gap stays silent. Like the progress
  // bar, the countdown is visual-only, so screen readers hear outcomes
  // rather than ticks. The element disappears however the wait ends.
  async function pacedWait(waitMs, signal) {
    if (waitMs < waitNoticeThresholdMs) {
      await abortableDelay(waitMs, signal);
      return;
    }
    const until = Date.now() + waitMs;
    try {
      for (;;) {
        const remaining = until - Date.now();
        if (remaining <= 0) {
          return;
        }
        waitStatusElement.textContent = TrueShuffle.waitCountdownMessage(remaining);
        waitStatusElement.hidden = false;
        await abortableDelay(Math.min(1000, remaining), signal);
      }
    } finally {
      waitStatusElement.textContent = "";
      waitStatusElement.hidden = true;
    }
  }

  // A deliberate cancel arrives as the pure class from our own delay and
  // lane checks, or as the platform's AbortError from an aborted fetch.
  function wasCancelled(error) {
    return error instanceof TrueShuffle.OperationCancelledError ||
      (error !== null && typeof error === "object" && error.name === "AbortError");
  }

  // One serial paced lane for every Web API request. A 429 stores one
  // cooldown deadline and is retried at most once after a short wait; a
  // long deadline fails locally -- recorded as cooldown-blocked, no request
  // sent -- until it expires. Cancellation is checked before every wait and
  // dispatch so nothing runs after disconnect.
  async function requestSpotify(token, url, role, body, method, responseMode) {
    const operation = activeOperation;
    const signal = operation !== null ? operation.controller.signal : null;
    const likedRole = TrueShuffle.telemetryEndpointClass(role) === "liked-tracks";
    let attempt = 1;
    for (;;) {
      const now = Date.now();
      let startAt = Math.max(nextRequestStartAt, now);
      // The liked lockout always blocks locally: its window is far beyond
      // the inline-wait ceiling and a request during it restarts the
      // penalty.
      const likedUntil = likedRole ? likedCooldown.activeUntil() : null;
      if (likedUntil !== null) {
        const blocked = beginRequestEvent(url, role, body, method);
        if (blocked !== null) {
          blocked.attempt = attempt;
          blocked.result = "cooldown-blocked";
        }
        throw likedLockoutError(likedUntil);
      }
      const cooldownUntil = spotifyCooldown.activeUntil();
      if (cooldownUntil !== null) {
        if (cooldownUntil - now > TrueShuffle.maxCooldownWaitMs) {
          const blocked = beginRequestEvent(url, role, body, method);
          if (blocked !== null) {
            blocked.attempt = attempt;
            blocked.result = "cooldown-blocked";
          }
          throw cooldownError(cooldownUntil);
        }
        startAt = Math.max(startAt, cooldownUntil);
      }
      const waitMs = Math.max(0, startAt - now);
      if (waitMs > 0) {
        await pacedWait(waitMs, signal);
      }
      if (signal && signal.aborted) {
        throw new TrueShuffle.OperationCancelledError("the operation was cancelled");
      }
      nextRequestStartAt = Date.now() + minStartGapMs;
      const event = beginRequestEvent(url, role, body, method);
      if (event !== null) {
        event.attempt = attempt;
        event.scheduled_wait_ms = waitMs;
      }
      const dispatchedMonotonic = window.performance.now();
      let retryAfter = {state: "absent", seconds: null};
      try {
        const options = {
          headers: {Authorization: token.token_type + " " + token.access_token}
        };
        if (signal) {
          options.signal = signal;
        }
        if (body !== undefined) {
          options.method = method || "POST";
          options.headers["Content-Type"] = "application/json";
          options.body = JSON.stringify(body);
        }
        const response = await window.fetch(url, options);
        if (!response.ok) {
          let detail = "";
          let reason = null;
          try {
            const payload = await response.json();
            if (payload && payload.error) {
              if (typeof payload.error.message === "string") {
                detail = payload.error.message;
              }
              reason = TrueShuffle.normalizeSpotifyReason(payload.error.reason);
            }
          } catch (_) {
            // A non-JSON error body adds nothing beyond the status.
          }
          retryAfter = TrueShuffle.normalizeRetryAfter(
            response.headers.get("Retry-After")
          );
          if (event !== null) {
            event.result = "http-error";
            event.status = response.status;
            event.retry_after_state = retryAfter.state;
            event.retry_after_seconds = retryAfter.seconds;
            event.reason = reason;
          }
          throw new TrueShuffle.SpotifyRequestError(response.status, new URL(url).pathname, detail);
        }
        if (event !== null) {
          // Set before parsing so a malformed success body keeps this label.
          event.result = "invalid-response";
          event.status = response.status;
        }
        if (responseMode === "empty") {
          if (event !== null) {
            event.result = "ok";
          }
          return null;
        }
        const payload = await response.json();
        if (event !== null) {
          event.result = "ok";
          if (payload && Array.isArray(payload.items)) {
            event.response_items = TrueShuffle.normalizeTelemetryCount(payload.items.length);
          }
          if (payload && Number.isInteger(payload.total)) {
            event.server_total = TrueShuffle.normalizeTelemetryCount(payload.total);
          }
        }
        return payload;
      } catch (error) {
        if (error instanceof TrueShuffle.SpotifyRequestError && error.status === 429) {
          if (likedRole) {
            // Spotify hides this endpoint's Retry-After from browsers and
            // scopes the penalty to the endpoint: pin the observed window,
            // never retry (a retry restarts it), and leave playlist work
            // outside the lockout.
            const likedDeadline = Date.now() + TrueShuffle.likedCooldownMs;
            likedCooldown.store(likedDeadline);
            throw likedLockoutError(likedDeadline);
          }
          const deadline = TrueShuffle.cooldownDeadline(retryAfter, Date.now());
          spotifyCooldown.store(deadline);
          const wait = deadline - Date.now();
          if (TrueShuffle.shouldRetry429(attempt, wait) && !(signal && signal.aborted)) {
            attempt += 1;
            continue;
          }
          // A 429 that will not be retried is always a pause with a known
          // end, never a generic failure.
          throw cooldownError(deadline);
        }
        throw error;
      } finally {
        if (event !== null) {
          event.duration_ms = Math.max(0, Math.round(
            window.performance.now() - dispatchedMonotonic
          ));
        }
      }
    }
  }

  // Fail-fast stays, but blind messages cost live diagnosis time twice;
  // name the status, the refused endpoint, and Spotify's own words when
  // supplied. The detail is third-party text and only ever rendered
  // through textContent.
  function failureDetail(error) {
    if (!(error instanceof TrueShuffle.SpotifyRequestError)) {
      return "";
    }
    return " (Spotify returned " + error.status +
      (error.path !== "" ? " at " + error.path : "") +
      (error.detail !== "" ? ": " + error.detail : "") + ")";
  }

  async function fetchPlaylists(token) {
    const playlists = [];
    let url = playlistsEndpoint + "?limit=" + playlistPageLimit;
    for (let page = 0; page < maxPlaylistPages; page += 1) {
      const payload = await requestSpotify(token, url, "playlist-list-page");
      playlists.push(...TrueShuffle.readPlaylistPage(payload));
      if (typeof payload.next !== "string" || payload.next === "") {
        return playlists;
      }
      // The bearer token must never follow a cursor off the Spotify API origin.
      if (!TrueShuffle.validPlaylistCursor(payload.next)) {
        throw new Error("Spotify returned an unexpected playlist page cursor");
      }
      url = payload.next;
    }
    throw new Error("Spotify returned more playlist pages than this app reads");
  }

  // One operation at a time: every row shares this gate, so chains cannot
  // interleave and the progress element has one owner.
  function setActionButtonsDisabled(disabled) {
    for (const button of playlistButtons) {
      button.disabled = disabled;
    }
  }

  // Pages are read in order through the serial lane; the first failure
  // stops the read with nothing else in flight.
  async function fetchTrackPages(token, urlForOffset, offsets, readPage, role, onPage) {
    const pages = [];
    for (const offset of offsets) {
      const page = readPage(
        await requestSpotify(token, urlForOffset(offset), role)
      );
      pages.push({offset: offset, count: page.count, uris: page.uris});
      onPage(page.count);
    }
    return pages;
  }

  // Pin the playlist version, fetch every page, then verify the count and
  // that the version never moved; a mutating playlist fails the read rather
  // than silently assembling a corrupted order.
  async function readPlaylistTracks(token, playlistId, onProgress) {
    const pinnedSnapshot = TrueShuffle.readPlaylistSnapshot(
      await requestSpotify(token, TrueShuffle.playlistSnapshotURL(playlistId), "playlist-snapshot-pin")
    );
    const firstPage = TrueShuffle.readPlaylistItemPage(
      await requestSpotify(token, TrueShuffle.trackPageURL(playlistId, 0), "playlist-items-page")
    );
    let loadedCount = firstPage.count;
    onProgress(loadedCount, firstPage.total);
    const offsets = TrueShuffle.remainingTrackOffsets(
      firstPage.limit, firstPage.total, TrueShuffle.maxPlaylistTracks
    );
    const pages = await fetchTrackPages(token, function (offset) {
      return TrueShuffle.trackPageURL(playlistId, offset);
    }, offsets, TrueShuffle.readPlaylistItemPage, "playlist-items-page", function (pageCount) {
      loadedCount += pageCount;
      onProgress(loadedCount, firstPage.total);
    });
    pages.push({offset: 0, count: firstPage.count, uris: firstPage.uris});
    const uris = TrueShuffle.assembleTrackPages(pages, firstPage.total);
    const confirmedSnapshot = TrueShuffle.readPlaylistSnapshot(
      await requestSpotify(token, TrueShuffle.playlistSnapshotURL(playlistId), "playlist-snapshot-verify")
    );
    if (confirmedSnapshot !== pinnedSnapshot) {
      throw new TrueShuffle.PlaylistChangedError("the playlist changed while its tracks were read");
    }
    return {snapshotId: pinnedSnapshot, uris: uris};
  }

  function selectionActive(playlist) {
    return selectedPlaylist !== null && selectedPlaylist.id === playlist.id;
  }

  function openTrackCache() {
    return new Promise(function (resolve, reject) {
      const request = window.indexedDB.open(trackCacheDatabaseName, 1);
      request.onupgradeneeded = function () {
        request.result.createObjectStore(trackCacheStoreName);
      };
      request.onsuccess = function () {
        resolve(request.result);
      };
      request.onerror = function () {
        reject(request.error || new Error("track cache could not be opened"));
      };
    });
  }

  // The cache is an optimization: an unavailable or unreadable store is a
  // miss and a failed write leaves the rendered result standing, so a
  // browser without IndexedDB still reads playlists.
  async function readTrackCache(key, valid) {
    try {
      const database = await openTrackCache();
      try {
        const record = await new Promise(function (resolve, reject) {
          const request = database.transaction(trackCacheStoreName, "readonly")
            .objectStore(trackCacheStoreName)
            .get(key);
          request.onsuccess = function () {
            resolve(request.result);
          };
          request.onerror = function () {
            reject(request.error);
          };
        });
        return valid(record) ? record : null;
      } finally {
        database.close();
      }
    } catch (_) {
      return null;
    }
  }

  async function writeTrackCache(playlistId, record) {
    try {
      const database = await openTrackCache();
      try {
        await new Promise(function (resolve, reject) {
          const transaction = database.transaction(trackCacheStoreName, "readwrite");
          transaction.objectStore(trackCacheStoreName).put(record, playlistId);
          transaction.oncomplete = function () {
            resolve();
          };
          transaction.onerror = function () {
            reject(transaction.error);
          };
          transaction.onabort = function () {
            reject(transaction.error);
          };
        });
      } finally {
        database.close();
      }
    } catch (_) {
      // The verified read is already rendered; the cache just missed it.
    }
  }

  function deleteTrackCache() {
    // Cached URIs are private account data; disconnect removes the database.
    try {
      window.indexedDB.deleteDatabase(trackCacheDatabaseName);
    } catch (_) {
      // Cache deletion is best effort.
    }
  }

  // Loads the playlist's URIs cache-first, rendering the loaded message or
  // the failure; returns {uris, changes} or null when the chain must stop.
  // The chain owns the button gate and the progress element's teardown.
  async function loadPlaylistSource(token, playlist) {
    loadedTracks = null;
    renderTrackStatus("Loading tracks...");
    try {
      const cached = await readTrackCache(playlist.id, TrueShuffle.validTrackCacheRecord);
      // Snapshot equality is the entire validity rule: a matching record is
      // the full ordered list, so a hit issues zero track requests.
      if (cached !== null && playlist.snapshotId !== null &&
          cached.snapshot_id === playlist.snapshotId) {
        loadedTracks = {id: playlist.id, snapshotId: cached.snapshot_id, uris: cached.uris};
        renderTrackStatus(TrueShuffle.loadedTracksMessage(cached.uris.length, null, null));
        setOperationContext({source_disposition: "playlist-cache-hit"});
        return {uris: cached.uris, changes: null};
      }
      setOperationContext({source_disposition: "network-read"});

      const readStart = Date.now();
      const read = await readPlaylistTracks(token, playlist.id, renderTrackProgress);
      const elapsedMilliseconds = Date.now() - readStart;
      // Disconnecting mid-read cleared the page; drop the late result.
      if (!selectionActive(playlist)) {
        return null;
      }
      const changes = cached !== null
        ? TrueShuffle.countTrackChanges(cached.uris, read.uris)
        : null;
      loadedTracks = {id: playlist.id, snapshotId: read.snapshotId, uris: read.uris};
      renderTrackStatus(TrueShuffle.loadedTracksMessage(
        read.uris.length, elapsedMilliseconds, changes
      ));
      await writeTrackCache(playlist.id, {
        snapshot_id: read.snapshotId,
        uris: read.uris,
        cached_at: Date.now()
      });
      return {uris: read.uris, changes: changes};
    } catch (error) {
      if (!selectionActive(playlist)) {
        return null;
      }
      if (wasCancelled(error)) {
        renderTrackStatus("Cancelled.");
        return null;
      }
      if (error instanceof TrueShuffle.CooldownActiveError) {
        renderTrackStatus(error.message);
        return null;
      }
      renderTrackStatus(error instanceof TrueShuffle.PlaylistChangedError
        ? "This playlist changed while loading. Select it again."
        : "Tracks could not be loaded" + failureDetail(error) +
          ". Select the playlist again to retry.");
      return null;
    }
  }

  // The library has no snapshot, so the read verifies against its opening
  // page: the summed raw count must match the total, and the closing probe
  // must reproduce the opening fingerprint -- total plus newest page -- so
  // a mid-read membership change fails the read even when it holds the
  // count still. The caller supplies page 0, already fetched for the
  // fingerprint check.
  async function readLikedTracks(token, firstPage, onProgress) {
    let loadedCount = firstPage.count;
    onProgress(loadedCount, firstPage.total);
    const offsets = TrueShuffle.remainingTrackOffsets(
      firstPage.limit, firstPage.total, Number.MAX_SAFE_INTEGER
    );
    const pages = await fetchTrackPages(
      token, TrueShuffle.likedPageURL, offsets, TrueShuffle.readLikedTrackPage,
      "liked-items-page",
      function (pageCount) {
        loadedCount += pageCount;
        onProgress(loadedCount, firstPage.total);
      }
    );
    pages.push({offset: 0, count: firstPage.count, uris: firstPage.uris});
    const uris = TrueShuffle.assembleTrackPages(pages, firstPage.total);
    const probe = TrueShuffle.readLikedTrackPage(
      await requestSpotify(token, TrueShuffle.likedPageURL(0), "liked-fingerprint-verify")
    );
    if (!TrueShuffle.likedRecordMatches({total: firstPage.total, head: firstPage.uris}, probe)) {
      throw new TrueShuffle.PlaylistChangedError("the library changed while it was read");
    }
    return uris;
  }

  // The Liked Songs counterpart of loadPlaylistSource. The library has no
  // snapshot, so validity is the fingerprint likedRecordMatches checks --
  // total plus newest page -- compared against the page-0 fetch a read
  // needs anyway, which makes a hit cost exactly one request.
  async function loadLikedSource(token, source) {
    loadedTracks = null;
    renderTrackStatus("Loading Liked Songs...");
    const loadStart = Date.now();
    try {
      const cached = await readTrackCache(source.id, TrueShuffle.validLikedCacheRecord);
      const firstPage = TrueShuffle.readLikedTrackPage(
        await requestSpotify(token, TrueShuffle.likedPageURL(0), "liked-fingerprint-open")
      );
      // Disconnecting mid-fetch cleared the page; drop the late result.
      if (!selectionActive(source)) {
        return null;
      }
      // Page zero already proves an oversized library; spend no further
      // request on a read whose write is impossible.
      if (firstPage.total > TrueShuffle.maxPlaylistTracks) {
        return {capacity: firstPage.total};
      }
      if (cached !== null && TrueShuffle.likedRecordMatches(cached, firstPage)) {
        loadedTracks = {id: source.id, snapshotId: null, uris: cached.uris};
        renderTrackStatus(TrueShuffle.loadedTracksMessage(cached.uris.length, null, null));
        setOperationContext({source_disposition: "liked-fingerprint-hit"});
        return {uris: cached.uris, changes: null};
      }
      setOperationContext({source_disposition: "network-read"});

      const uris = await readLikedTracks(token, firstPage, renderTrackProgress);
      if (!selectionActive(source)) {
        return null;
      }
      const changes = cached !== null
        ? TrueShuffle.countTrackChanges(cached.uris, uris)
        : null;
      loadedTracks = {id: source.id, snapshotId: null, uris: uris};
      renderTrackStatus(TrueShuffle.loadedTracksMessage(
        uris.length, Date.now() - loadStart, changes
      ));
      // The probe proved the fingerprint still true at read end, so the
      // stored record never begins life stale.
      await writeTrackCache(source.id, {
        total: firstPage.total,
        head: firstPage.uris,
        uris: uris,
        cached_at: Date.now()
      });
      return {uris: uris, changes: changes};
    } catch (error) {
      if (!selectionActive(source)) {
        return null;
      }
      if (wasCancelled(error)) {
        renderTrackStatus("Cancelled.");
        return null;
      }
      if (error instanceof TrueShuffle.CooldownActiveError) {
        renderTrackStatus(error.message);
        return null;
      }
      renderTrackStatus(error instanceof TrueShuffle.PlaylistChangedError
        ? "Liked Songs changed while loading. Select it again."
        : "Liked Songs could not be loaded" + failureDetail(error) + ". Select it again.");
      return null;
    }
  }

  // Uniform 0..n-1 via rejection sampling of a 32-bit crypto word, so no
  // modulo bias enters the shuffle.
  function randomBelow(n) {
    const bound = Math.floor(0x100000000 / n) * n;
    const words = new Uint32Array(1);
    do {
      window.crypto.getRandomValues(words);
    } while (words[0] >= bound);
    return words[0] % n;
  }

  // Writes land only in a target whose exact managed description names this
  // source, or in one legacy target that is marked before its items change.
  // Names are the creation/current-name contract, never proof of ownership.
  async function writeShuffled(token, source, uris, changes) {
    const targetName = TrueShuffle.derivedPlaylistName(source.name);
    renderTrackStatus("Shuffling into \"" + targetName + "\"...");
    const writeStart = Date.now();
    let target = null;
    let overwriting = false;
    let itemWriteStarted = false;
    try {
      const resolved = TrueShuffle.resolveManagedTarget(listedPlaylists, source, targetName);
      target = resolved.target;
      overwriting = target !== null;
      const shuffled = TrueShuffle.shuffledURIs(uris, randomBelow);
      if (!overwriting) {
        const created = TrueShuffle.readCreatedPlaylist(await requestSpotify(
          token,
          TrueShuffle.createPlaylistURL(),
          "target-create",
          {name: targetName, public: false, description: resolved.description}
        ));
        target = {
          id: created.id,
          name: created.name,
          total: null,
          description: resolved.description,
          snapshotId: null
        };
        listedPlaylists.push(target);
        setOperationContext({target_disposition: "created"});
      } else if (resolved.legacy || target.name !== targetName) {
        await requestSpotify(
          token,
          TrueShuffle.playlistDetailsURL(target.id),
          "target-details-update",
          {name: targetName, description: resolved.description},
          "PUT",
          "empty"
        );
        target.name = targetName;
        target.description = resolved.description;
      }
      let written = 0;
      renderTrackProgress(written, shuffled.length);
      const batches = TrueShuffle.uriBatches(shuffled);
      for (let index = 0; index < batches.length; index += 1) {
        // On an existing target the first batch replaces the entire
        // contents, so a rerun never appends onto wreckage.
        const replace = overwriting && index === 0;
        itemWriteStarted = true;
        await requestSpotify(
          token,
          TrueShuffle.addTracksURL(target.id),
          replace ? "target-replace" : "target-append",
          {uris: batches[index]},
          replace ? "PUT" : "POST"
        );
        if (replace) {
          setOperationContext({target_disposition: "replaced"});
        }
        written += batches[index].length;
        renderTrackProgress(written, shuffled.length);
      }
      const total = TrueShuffle.readPlaylistTotal(
        await requestSpotify(token, TrueShuffle.playlistTotalURL(target.id), "target-total-verify")
      );
      if (total !== shuffled.length) {
        throw new Error("the target playlist does not contain every track");
      }
      if (!selectionActive(source)) {
        return false;
      }
      renderTrackStatus(TrueShuffle.shuffleResultMessage(
        !overwriting, target.name, shuffled.length, Date.now() - writeStart
      ) + TrueShuffle.trackChangesSuffix(changes));
      // One tap into the standing result. Fixed origin, encoded id, no
      // token: the same constructed-URL rule every API request follows.
      openTargetLink.href = "https://open.spotify.com/playlist/" + encodeURIComponent(target.id);
      openTargetLink.hidden = false;
      return true;
    } catch (error) {
      if (!selectionActive(source)) {
        return false;
      }
      if (wasCancelled(error)) {
        renderTrackStatus(target === null || !itemWriteStarted
          ? "Cancelled."
          : "Cancelled. \"" + target.name + "\" may be incomplete; shuffle again to rewrite it.");
        return false;
      }
      if (error instanceof TrueShuffle.TargetAmbiguousError) {
        renderTrackStatus(error.message);
        return false;
      }
      if (error instanceof TrueShuffle.CooldownActiveError) {
        renderTrackStatus(target === null
          ? "The shuffled playlist could not be created. " + error.message
          : !itemWriteStarted
            ? "The shuffled playlist could not be prepared. " + error.message
          : "\"" + target.name + "\" may be incomplete. " + error.message +
            " Shuffle again afterward.");
        return false;
      }
      renderTrackStatus(target === null
        ? "The shuffled playlist could not be created" + failureDetail(error) + ". Try again."
        : !itemWriteStarted
          ? "The shuffled playlist could not be prepared" + failureDetail(error) + ". Try again."
        : "\"" + target.name + "\" may be incomplete" + failureDetail(error) +
          ". Shuffle again to rewrite it.");
      return false;
    }
  }

  // The one gesture: load the row's tracks, shuffle, and write the derived
  // target, under a single button gate and one progress element.
  async function runShuffle(token, source) {
    setActionButtonsDisabled(true);
    // A prior result's link must not outlive the result it points at.
    openTargetLink.hidden = true;
    const operation = beginOperation(source.liked ? "liked-shuffle" : "playlist-shuffle");
    // The escape hatch: visible for exactly as long as the chain runs.
    cancelButton.disabled = false;
    cancelButton.hidden = false;
    try {
      const loaded = source.liked
        ? await loadLikedSource(token, source)
        : await loadPlaylistSource(token, source);
      if (loaded === null) {
        finishOperation(operation,
          operation.controller.signal.aborted || selectedPlaylist === null
            ? "abandoned"
            : "load-failed");
        return;
      }
      if (loaded.capacity !== undefined) {
        renderTrackStatus("\"" + source.name + "\" holds more than 10,000 tracks, the most a playlist can contain.");
        setOperationContext({source_total: loaded.capacity, source_disposition: "capacity-rejected"});
        finishOperation(operation, "capacity-rejected");
        return;
      }
      setOperationContext({source_total: loaded.uris.length});
      if (loaded.uris.length === 0) {
        renderTrackStatus(TrueShuffle.emptySourceMessage(source.name));
        setOperationContext({source_disposition: "empty"});
        finishOperation(operation, "no-tracks");
        return;
      }
      if (loaded.uris.length > TrueShuffle.maxPlaylistTracks) {
        renderTrackStatus("\"" + source.name + "\" holds more than 10,000 tracks, the most a playlist can contain.");
        setOperationContext({source_disposition: "capacity-rejected"});
        finishOperation(operation, "capacity-rejected");
        return;
      }
      // Writing needs the modify scope; a token without it would only earn
      // a 403. Reconnecting is the fix, and disconnect is the way there.
      if (!TrueShuffle.hasScope(token.scope, playlistWriteScope)) {
        renderTrackStatus("Disconnect this browser and reconnect Spotify to allow creating playlists.");
        finishOperation(operation, "scope-blocked");
        return;
      }
      const written = await writeShuffled(token, source, loaded.uris, loaded.changes);
      finishOperation(operation, written
        ? "complete"
        : (operation.controller.signal.aborted || selectedPlaylist === null
          ? "abandoned"
          : "write-failed"));
    } finally {
      finishOperation(operation, "abandoned");
      cancelButton.hidden = true;
      trackProgressElement.hidden = true;
      setActionButtonsDisabled(false);
    }
  }

  function selectPlaylist(token, source, button) {
    if (selectedPlaylist) {
      selectedPlaylist.button.setAttribute("aria-pressed", "false");
    }
    selectedPlaylist = {id: source.id, name: source.name, button: button};
    button.setAttribute("aria-pressed", "true");
    renderPlaylistStatus("Selected " + source.name + ".");
    return runShuffle(token, source);
  }

  function appendSourceRow(label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    // Playlist names are third-party text and must never become markup.
    button.textContent = label;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", function () {
      onClick(button);
    });

    const item = document.createElement("li");
    item.appendChild(button);
    playlistsElement.appendChild(item);
    playlistButtons.push(button);
  }

  function renderSourceList(token, displayed) {
    playlistsElement.textContent = "";
    playlistButtons = [];

    // Liked Songs leads the list; without the library scope the row is the
    // reconnect surface, running the ordinary authorization flow.
    const hasLibraryScope = TrueShuffle.hasScope(token.scope, likedScope);
    appendSourceRow(TrueShuffle.likedRowLabel(hasLibraryScope), function (button) {
      if (hasLibraryScope) {
        selectPlaylist(token, likedSource, button);
        return;
      }
      setActionButtonsDisabled(true);
      startAuthorization().catch(function () {
        clearPendingAuthorization();
        setActionButtonsDisabled(false);
        renderTrackStatus("Spotify authorization could not be started.");
      });
    });

    for (const playlist of displayed) {
      appendSourceRow(TrueShuffle.playlistLabel(playlist), function (button) {
        selectPlaylist(token, playlist, button);
      });
    }
    playlistsElement.hidden = false;
  }

  async function loadPlaylists(token) {
    renderPlaylistStatus("Loading playlists...");
    const operation = beginOperation("playlist-list");
    let playlists;
    try {
      playlists = await fetchPlaylists(token);
    } catch (error) {
      // Cancellation here only means disconnect; the page is being
      // cleared, so nothing is rendered over it.
      if (wasCancelled(error)) {
        finishOperation(operation, "abandoned");
        return;
      }
      // A failed listing is not proof of revocation, so the token is kept.
      renderPlaylistStatus(error instanceof TrueShuffle.CooldownActiveError
        ? error.message + " Reload afterward."
        : "Playlists could not be loaded. Reload to try again.");
      finishOperation(operation, "listing-failed");
      return;
    }
    finishOperation(operation, "complete");
    listedPlaylists = playlists;
    const displayed = TrueShuffle.displayedPlaylists(playlists);
    renderSourceList(token, displayed);
    renderPlaylistStatus("Select a playlist to shuffle it.");
  }

  async function startAuthorization() {
    if (!publicConfig) {
      throw new Error("public configuration is unavailable");
    }

    renderWorking("Opening Spotify authorization...");
    const state = randomBase64URL(32);
    const verifier = randomBase64URL(64);
    const challenge = await codeChallenge(verifier);
    storePendingAuthorization(state, verifier);

    const url = new URL(authorizeEndpoint);
    url.search = new URLSearchParams({
      client_id: publicConfig.spotify_client_id,
      response_type: "code",
      redirect_uri: redirectURI(),
      state: state,
      scope: scopes.join(" "),
      code_challenge_method: "S256",
      code_challenge: challenge
    }).toString();
    window.location.assign(url.toString());
  }

  function cleanCallbackURL() {
    window.history.replaceState(null, "", "/");
  }

  async function handleCallback() {
    const parameters = new URLSearchParams(window.location.search);
    cleanCallbackURL();
    const pendingAuthorization = readPendingAuthorization();
    clearPendingAuthorization();

    const returnedState = parameters.get("state");
    if (!returnedState || !pendingAuthorization.state || returnedState !== pendingAuthorization.state) {
      throw new TokenRejectedError("Spotify authorization could not be verified. Please connect again.");
    }
    if (parameters.has("error")) {
      throw new TokenRejectedError("Spotify authorization was not granted.");
    }

    const code = parameters.get("code");
    if (!code || !pendingAuthorization.verifier) {
      throw new TokenRejectedError("Spotify authorization could not be verified. Please connect again.");
    }

    const payload = await requestToken({
      client_id: publicConfig.spotify_client_id,
      grant_type: "authorization_code",
      code: code,
      redirect_uri: redirectURI(),
      code_verifier: pendingAuthorization.verifier
    });
    return storeTokenResponse(payload, null);
  }

  async function initialize() {
    restoreBackground();
    // A prior page may have left acknowledged-pending reports behind.
    try {
      drainTelemetryQueue().catch(function (_) {
        // The queue keeps its reports; a later trigger retries.
      });
    } catch (_) {
      // An unusable queue never blocks initialization.
    }
    if (!window.crypto || !window.crypto.subtle) {
      renderError("This browser does not support secure Spotify authorization.", false, false);
      return;
    }

    try {
      publicConfig = await loadPublicConfig();
    } catch (_) {
      renderError("Spotify configuration could not be loaded.", false, false);
      return;
    }

    if (window.location.pathname === "/callback") {
      renderWorking("Completing Spotify connection...");
      try {
        const token = await handleCallback();
        renderConnected();
        await loadPlaylists(token);
      } catch (error) {
        clearStoredToken();
        const message = error instanceof TokenRejectedError
          ? error.message
          : "Spotify could not be connected. Please try again.";
        renderError(message, true, false);
      }
      return;
    }

    const token = readStoredToken();
    if (!token) {
      renderDisconnected();
      return;
    }
    if (token.expires_at - Date.now() > expirySkewMilliseconds) {
      renderConnected();
      await loadPlaylists(token);
      return;
    }

    renderWorking("Refreshing Spotify connection...");
    let refreshed;
    try {
      refreshed = await refreshToken(token);
    } catch (error) {
      if (error instanceof AuthorizationRevokedError) {
        clearStoredToken();
        renderError("Spotify authorization expired. Please connect again.", true, false);
        return;
      }
      // The kept token may never refresh again; the disconnect button is the
      // on-page escape from that state.
      renderError("Spotify could not be reached. Reload to try again, or " +
        "disconnect this browser and connect again.", false, true);
      return;
    }
    renderConnected();
    await loadPlaylists(refreshed);
  }

  connectButton.addEventListener("click", function () {
    connectButton.disabled = true;
    startAuthorization().catch(function () {
      clearPendingAuthorization();
      renderError("Spotify authorization could not be started.", true, false);
    });
  });

  backgroundButtons.forEach(function (entry) {
    entry.button.addEventListener("click", function () {
      selectBackground(entry.choice);
    });
  });

  cancelButton.addEventListener("click", function () {
    cancelButton.disabled = true;
    if (activeOperation !== null) {
      activeOperation.controller.abort();
    }
  });

  logoutButton.addEventListener("click", function () {
    logoutButton.disabled = true;
    // Abort the active chain first so no later page or write batch can be
    // dispatched after the page state is cleared.
    if (activeOperation !== null) {
      activeOperation.controller.abort();
    }
    clearPendingAuthorization();
    clearStoredToken();
    deleteTrackCache();
    clearPlaylists();
    renderDisconnected("Spotify was disconnected from this browser.");
  });

  initialize();
}());
