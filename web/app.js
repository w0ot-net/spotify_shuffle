(function () {
  "use strict";

  const {AuthorizationRevokedError, TokenRejectedError, playlistsEndpoint} = TrueShuffle;
  const authorizeEndpoint = "https://accounts.spotify.com/authorize";
  const tokenEndpoint = "https://accounts.spotify.com/api/token";
  // Spotify caps a page at 50 items and a library at 10,000 playlists.
  const playlistPageLimit = 50;
  const maxPlaylistPages = 200;
  // Wide enough to matter for a 100-page playlist, narrow enough not to
  // invite 429s; a 429 still fails the read under the fail-fast posture.
  const maxConcurrentTrackRequests = 6;
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
  // The request policy the telemetry reports: today's six-worker dispatcher
  // with no pacing and no retries. The request-control plan changes only
  // these values.
  const telemetryPolicy = {policy: "pool-6-v0", minStartGapMs: 0, retryCeiling: 0};
  const telemetryEndpoint = "/api/telemetry";

  const statusElement = document.getElementById("status");
  const connectButton = document.getElementById("connect");
  const logoutButton = document.getElementById("logout");
  const playlistStatusElement = document.getElementById("playlist-status");
  const trackStatusElement = document.getElementById("track-status");
  const trackProgressElement = document.getElementById("track-progress");
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

  function renderError(message, canReconnect) {
    statusElement.textContent = message;
    connectButton.hidden = !canReconnect;
    connectButton.disabled = false;
    logoutButton.hidden = true;
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

  // Submission is one unawaited same-origin request; telemetry transport
  // can never affect the operation that produced the report.
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
      window.fetch(telemetryEndpoint, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: TrueShuffle.encodeTelemetryReport(report),
        keepalive: true,
        credentials: "same-origin"
      }).catch(function (_) {
        // Lost telemetry is lost; the operation already rendered.
      });
    } catch (_) {
      // An unavailable fetch is equivalent to lost transport.
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

  async function requestSpotify(token, url, role, body, method) {
    const event = beginRequestEvent(url, role, body, method);
    const dispatchedMonotonic = window.performance.now();
    try {
      const options = {
        headers: {Authorization: token.token_type + " " + token.access_token}
      };
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
        if (event !== null) {
          const retryAfter = TrueShuffle.normalizeRetryAfter(
            response.headers.get("Retry-After")
          );
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
    } finally {
      if (event !== null) {
        event.duration_ms = Math.max(0, Math.round(
          window.performance.now() - dispatchedMonotonic
        ));
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

  async function fetchTrackPages(token, urlForOffset, offsets, readPage, role, onPage) {
    const pages = [];
    let nextIndex = 0;
    let failure = null;
    async function worker() {
      // Nothing further is dispatched after the first failure, so a failed
      // read costs at most the requests already in flight.
      while (nextIndex < offsets.length && failure === null) {
        const offset = offsets[nextIndex];
        nextIndex += 1;
        try {
          const page = readPage(
            await requestSpotify(token, urlForOffset(offset), role)
          );
          pages.push({offset: offset, count: page.count, uris: page.uris});
          onPage(page.count);
        } catch (error) {
          failure = failure || error;
        }
      }
    }
    const workers = [];
    for (let slot = 0; slot < Math.min(maxConcurrentTrackRequests, offsets.length); slot += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);
    if (failure !== null) {
      throw failure;
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

  // Writes land in the one derived target per source -- created under the
  // derived name when absent, replaced in full when present. Every id this
  // flow addresses is either returned by the create call it just made or
  // found in the listing under the exact derived name, so a playlist
  // without the suffix is unreachable by construction.
  async function writeShuffled(token, source, uris, changes) {
    const targetName = TrueShuffle.derivedPlaylistName(source.name);
    renderTrackStatus("Shuffling into \"" + targetName + "\"...");
    const writeStart = Date.now();
    let target = TrueShuffle.findPlaylistByName(listedPlaylists, targetName);
    const overwriting = target !== null;
    try {
      const shuffled = TrueShuffle.shuffledURIs(uris, randomBelow);
      if (!overwriting) {
        const created = TrueShuffle.readCreatedPlaylist(await requestSpotify(
          token,
          TrueShuffle.createPlaylistURL(),
          "target-create",
          {name: targetName, public: false, description: "Created by TrueShuffle"}
        ));
        target = {id: created.id, name: created.name, total: null, snapshotId: null};
        listedPlaylists.push(target);
        setOperationContext({target_disposition: "created"});
      }
      let written = 0;
      renderTrackProgress(written, shuffled.length);
      const batches = TrueShuffle.uriBatches(shuffled);
      for (let index = 0; index < batches.length; index += 1) {
        // On an existing target the first batch replaces the entire
        // contents, so a rerun never appends onto wreckage.
        const replace = overwriting && index === 0;
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
      return true;
    } catch (error) {
      if (!selectionActive(source)) {
        return false;
      }
      renderTrackStatus(target === null
        ? "The shuffled playlist could not be created" + failureDetail(error) + ". Try again."
        : "\"" + target.name + "\" may be incomplete" + failureDetail(error) +
          ". Shuffle again to rewrite it.");
      return false;
    }
  }

  // The one gesture: load the row's tracks, shuffle, and write the derived
  // target, under a single button gate and one progress element.
  async function runShuffle(token, source) {
    setActionButtonsDisabled(true);
    const operation = beginOperation(source.liked ? "liked-shuffle" : "playlist-shuffle");
    try {
      const loaded = source.liked
        ? await loadLikedSource(token, source)
        : await loadPlaylistSource(token, source);
      if (loaded === null) {
        finishOperation(operation, selectedPlaylist === null ? "abandoned" : "load-failed");
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
        : (selectedPlaylist === null ? "abandoned" : "write-failed"));
    } finally {
      finishOperation(operation, "abandoned");
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
    } catch (_) {
      // A failed listing is not proof of revocation, so the token is kept.
      renderPlaylistStatus("Playlists could not be loaded. Reload to try again.");
      finishOperation(operation, "listing-failed");
      return;
    }
    finishOperation(operation, "complete");
    listedPlaylists = playlists;
    const displayed = TrueShuffle.displayedPlaylists(playlists);
    renderSourceList(token, displayed.playlists);
    // A shadowed duplicate is unshuffleable until renamed; hiding it
    // silently would be the listing's version of silent truncation.
    const note = TrueShuffle.shadowedRowsNote(displayed.shadowedCount);
    renderPlaylistStatus("Select a playlist to shuffle it." + (note === "" ? "" : " " + note));
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
    if (!window.crypto || !window.crypto.subtle) {
      renderError("This browser does not support secure Spotify authorization.", false);
      return;
    }

    try {
      publicConfig = await loadPublicConfig();
    } catch (_) {
      renderError("Spotify configuration could not be loaded.", false);
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
        renderError(message, true);
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
        renderError("Spotify authorization expired. Please connect again.", true);
        return;
      }
      renderError("Spotify could not be reached. Reload to try again.", false);
      return;
    }
    renderConnected();
    await loadPlaylists(refreshed);
  }

  connectButton.addEventListener("click", function () {
    connectButton.disabled = true;
    startAuthorization().catch(function () {
      clearPendingAuthorization();
      renderError("Spotify authorization could not be started.", true);
    });
  });

  logoutButton.addEventListener("click", function () {
    logoutButton.disabled = true;
    clearPendingAuthorization();
    clearStoredToken();
    deleteTrackCache();
    clearPlaylists();
    renderDisconnected("Spotify was disconnected from this browser.");
  });

  initialize();
}());
