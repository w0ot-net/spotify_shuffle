"use strict";

// Browser-independent value logic. No DOM, network, storage, or other
// platform interface may be referenced here; repository validation greps
// this file for their names.
var TrueShuffle = (function () {
  const playlistsEndpoint = "https://api.spotify.com/v1/me/playlists";
  const playlistEndpointPrefix = "https://api.spotify.com/v1/playlists/";
  const likedTracksEndpoint = "https://api.spotify.com/v1/me/tracks";
  // The saved-tracks endpoint maximum; it supports no fields filtering.
  const likedPageLimit = 50;
  // The add-items endpoint accepts at most 100 URIs per request.
  const addTracksBatchLimit = 100;
  // The published maximum page size for the playlist-items endpoint. The server
  // echoes the size it actually enforced, and offsets step by that echo.
  const trackPageLimit = 50;
  // Spotify caps a playlist at 10,000 items.
  const maxPlaylistTracks = 10000;

  class TokenRejectedError extends Error {}
  class AuthorizationRevokedError extends TokenRejectedError {}
  class PlaylistChangedError extends Error {}
  // A locally enforced Spotify cooldown: no request was sent. Carries the
  // absolute deadline so callers can render the retry time.
  class CooldownActiveError extends Error {
    constructor(message, until) {
      super(message);
      this.until = until;
    }
  }
  // A non-OK Web API response; carries the status, request path, and
  // Spotify's own error message so failure messages can name what was
  // refused, where, and in Spotify's words.
  class SpotifyRequestError extends Error {
    constructor(status, path, detail) {
      super("Spotify request failed with status " + status +
        (typeof path === "string" && path !== "" ? " at " + path : "") +
        (typeof detail === "string" && detail !== "" ? ": " + detail : ""));
      this.status = status;
      this.path = typeof path === "string" ? path : "";
      this.detail = typeof detail === "string" ? detail : "";
    }
  }

  function validTokenRecord(value) {
    return value !== null &&
      typeof value === "object" &&
      typeof value.access_token === "string" && value.access_token !== "" &&
      typeof value.refresh_token === "string" && value.refresh_token !== "" &&
      typeof value.token_type === "string" && value.token_type !== "" &&
      typeof value.scope === "string" &&
      typeof value.expires_at === "number" && Number.isFinite(value.expires_at);
  }

  function buildTokenRecord(payload, previousToken, now) {
    const refreshToken = typeof payload.refresh_token === "string" && payload.refresh_token !== ""
      ? payload.refresh_token
      : previousToken && previousToken.refresh_token;
    const scope = typeof payload.scope === "string"
      ? payload.scope
      : previousToken && previousToken.scope;
    const tokenType = typeof payload.token_type === "string" && payload.token_type !== ""
      ? payload.token_type
      : previousToken && previousToken.token_type;

    if (typeof payload.access_token !== "string" || payload.access_token === "" ||
        typeof refreshToken !== "string" || refreshToken === "" ||
        typeof scope !== "string" ||
        typeof tokenType !== "string" || tokenType === "" ||
        typeof payload.expires_in !== "number" || !Number.isFinite(payload.expires_in) ||
        payload.expires_in <= 0) {
      throw new TokenRejectedError("Spotify returned an invalid token response");
    }

    return {
      access_token: payload.access_token,
      refresh_token: refreshToken,
      token_type: tokenType,
      scope: scope,
      expires_at: now + (payload.expires_in * 1000)
    };
  }

  function playlistLabel(playlist) {
    if (playlist.total === null) {
      return playlist.name;
    }
    return playlist.name + " (" + playlist.total +
      (playlist.total === 1 ? " track)" : " tracks)");
  }

  function readPlaylistPage(payload) {
    if (!payload || !Array.isArray(payload.items)) {
      throw new Error("Spotify returned an invalid playlist page");
    }
    const playlists = [];
    for (const item of payload.items) {
      // Spotify can include null placeholders for items it cannot expose.
      if (!item || typeof item.id !== "string" || item.id === "") {
        continue;
      }
      playlists.push({
        id: item.id,
        name: typeof item.name === "string" && item.name !== "" ? item.name : "Untitled playlist",
        total: item.items && Number.isFinite(item.items.total) ? item.items.total : null,
        // The listing's version stamp is what selection compares against the
        // track cache, so a hit needs no extra request.
        snapshotId: typeof item.snapshot_id === "string" && item.snapshot_id !== "" ? item.snapshot_id : null
      });
    }
    return playlists;
  }

  function validPlaylistCursor(cursor) {
    return cursor.startsWith(playlistsEndpoint + "?");
  }

  // Track-read URLs are always constructed here against the fixed API
  // origin, never taken from a response, and Spotify-supplied playlist ids
  // are third-party strings, so they are URI-encoded before entering a path.
  function playlistSnapshotURL(playlistId) {
    return playlistEndpointPrefix + encodeURIComponent(playlistId) +
      "?fields=snapshot_id";
  }

  function trackPageURL(playlistId, offset) {
    return playlistEndpointPrefix + encodeURIComponent(playlistId) +
      "/items?fields=limit,total,items(item(uri))" +
      "&limit=" + trackPageLimit + "&offset=" + offset;
  }

  function readPlaylistSnapshot(payload) {
    if (!payload || typeof payload.snapshot_id !== "string" || payload.snapshot_id === "") {
      throw new Error("Spotify returned an invalid playlist snapshot");
    }
    return payload.snapshot_id;
  }

  function readURIPage(payload, itemProperty) {
    if (!payload || !Array.isArray(payload.items) ||
        !Number.isInteger(payload.limit) || payload.limit <= 0 ||
        !Number.isInteger(payload.total) || payload.total < 0) {
      throw new Error("Spotify returned an invalid track page");
    }
    const uris = [];
    for (const item of payload.items) {
      // Items without an exposable track URI are skipped, but the raw count
      // keeps them so completeness is checked against what Spotify sent.
      const content = item && item[itemProperty];
      if (content && typeof content.uri === "string" && content.uri !== "") {
        uris.push(content.uri);
      }
    }
    return {limit: payload.limit, total: payload.total, count: payload.items.length, uris: uris};
  }

  function readPlaylistItemPage(payload) {
    return readURIPage(payload, "item");
  }

  function readLikedTrackPage(payload) {
    return readURIPage(payload, "track");
  }

  function likedPageURL(offset) {
    return likedTracksEndpoint + "?limit=" + likedPageLimit + "&offset=" + offset;
  }

  function createPlaylistURL() {
    return playlistsEndpoint;
  }

  function addTracksURL(playlistId) {
    return playlistEndpointPrefix + encodeURIComponent(playlistId) + "/items";
  }

  function playlistTotalURL(playlistId) {
    return playlistEndpointPrefix + encodeURIComponent(playlistId) +
      "?fields=items.total";
  }

  function readCreatedPlaylist(payload) {
    if (!payload || typeof payload.id !== "string" || payload.id === "") {
      throw new Error("Spotify returned an invalid created playlist");
    }
    return {
      id: payload.id,
      name: typeof payload.name === "string" && payload.name !== "" ? payload.name : "New playlist"
    };
  }

  function readPlaylistTotal(payload) {
    if (!payload || !payload.items ||
        !Number.isInteger(payload.items.total) || payload.items.total < 0) {
      throw new Error("Spotify returned an invalid playlist total");
    }
    return payload.items.total;
  }

  // Fisher-Yates with injected randomness so the shuffle is directly
  // testable; every index the source produces is validated before use.
  function shuffledURIs(uris, randomBelow) {
    const shuffled = uris.slice();
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = randomBelow(i + 1);
      if (!Number.isInteger(j) || j < 0 || j > i) {
        throw new Error("the shuffle randomness source returned an invalid index");
      }
      const swap = shuffled[i];
      shuffled[i] = shuffled[j];
      shuffled[j] = swap;
    }
    return shuffled;
  }

  function uriBatches(uris) {
    const batches = [];
    for (let start = 0; start < uris.length; start += addTracksBatchLimit) {
      batches.push(uris.slice(start, start + addTracksBatchLimit));
    }
    return batches;
  }

  // The suffix is the app's ownership claim: the only playlists the write
  // flow ever addresses carry it.
  const derivedPlaylistSuffix = " TrueShuffle";

  function derivedPlaylistName(sourceName) {
    return sourceName + derivedPlaylistSuffix;
  }

  function findPlaylistByName(playlists, name) {
    for (const playlist of playlists) {
      if (playlist.name === name) {
        return playlist;
      }
    }
    return null;
  }

  function shuffleResultMessage(created, name, count, elapsedMilliseconds) {
    return (created ? "Created \"" : "Updated \"") + name + "\" with " + count +
      (count === 1 ? " track" : " tracks") +
      " in " + (Math.max(0, elapsedMilliseconds) / 1000).toFixed(1) + "s.";
  }

  function hasScope(scope, name) {
    return scope.split(" ").includes(name);
  }

  // The caller supplies the maximum because the bounds differ: a playlist
  // holds at most 10,000 items while the liked-songs library is uncapped.
  function remainingTrackOffsets(pageLimit, total, maxTotal) {
    if (total > maxTotal) {
      throw new Error("Spotify reported more tracks than this read allows");
    }
    const offsets = [];
    for (let offset = pageLimit; offset < total; offset += pageLimit) {
      offsets.push(offset);
    }
    return offsets;
  }

  function validTrackCacheRecord(value) {
    return value !== null &&
      typeof value === "object" &&
      typeof value.snapshot_id === "string" && value.snapshot_id !== "" &&
      Array.isArray(value.uris) &&
      value.uris.every(function (uri) { return typeof uri === "string"; }) &&
      typeof value.cached_at === "number" && Number.isFinite(value.cached_at);
  }

  function validLikedCacheRecord(value) {
    return value !== null &&
      typeof value === "object" &&
      Number.isInteger(value.total) && value.total >= 0 &&
      Array.isArray(value.head) &&
      value.head.every(function (uri) { return typeof uri === "string"; }) &&
      Array.isArray(value.uris) &&
      value.uris.every(function (uri) { return typeof uri === "string"; }) &&
      typeof value.cached_at === "number" && Number.isFinite(value.cached_at);
  }

  // The liked-library fingerprint: the total plus the newest page's URIs.
  // Saved tracks order newest-first and cannot be reordered, so a removal
  // moves the total and an addition moves the head even when a balanced
  // removal holds the count still. The one invisible mutation is an unlike
  // reversed for the same track, which is membership-neutral.
  function likedRecordMatches(record, firstPage) {
    return record.total === firstPage.total &&
      record.head.length === firstPage.uris.length &&
      record.head.every(function (uri, index) { return uri === firstPage.uris[index]; });
  }

  // Playlists may contain the same URI more than once, so the difference is
  // a multiset count: added is the surplus in the new list, removed the
  // surplus in the old. A reorder is zero/zero.
  function countTrackChanges(previousUris, currentUris) {
    const surplus = new Map();
    for (const uri of previousUris) {
      surplus.set(uri, (surplus.get(uri) || 0) + 1);
    }
    let added = 0;
    for (const uri of currentUris) {
      const remaining = surplus.get(uri) || 0;
      if (remaining > 0) {
        surplus.set(uri, remaining - 1);
      } else {
        added += 1;
      }
    }
    let removed = 0;
    for (const remaining of surplus.values()) {
      removed += remaining;
    }
    return {added: added, removed: removed};
  }

  // The membership-difference sentence, empty when nothing changed, shared
  // by the loaded message and the shuffle result.
  function trackChangesSuffix(changes) {
    if (!changes || (changes.added === 0 && changes.removed === 0)) {
      return "";
    }
    return " " + changes.added + " added, " + changes.removed +
      " removed since last read.";
  }

  // The full loaded-tracks message: plain count for a cache hit (null
  // elapsed), one-decimal duration for a network read, and the membership
  // difference when a prior record existed and something changed.
  function loadedTracksMessage(count, elapsedMilliseconds, changes) {
    let message = "Loaded " + count + (count === 1 ? " track" : " tracks");
    if (elapsedMilliseconds !== null) {
      message += " in " + (Math.max(0, elapsedMilliseconds) / 1000).toFixed(1) + "s";
    }
    return message + "." + trackChangesSuffix(changes);
  }

  const likedSourceName = "Liked Songs";

  // The rendered list hides the app's own derived playlists and keeps only
  // the first instance of each name (the Liked Songs row counts as the
  // first "Liked Songs"), so visible names are unique and name-keyed
  // targets are unambiguous. The retained listing keeps everything so the
  // write flow's target lookup still sees it. Derived hiding is routine
  // and uncounted; shadowed duplicates are counted so the renderer can
  // say so instead of silently truncating.
  function displayedPlaylists(playlists) {
    const seenNames = new Set([likedSourceName]);
    const visible = [];
    let shadowedCount = 0;
    for (const playlist of playlists) {
      if (playlist.name.endsWith(derivedPlaylistSuffix)) {
        continue;
      }
      if (seenNames.has(playlist.name)) {
        shadowedCount += 1;
        continue;
      }
      seenNames.add(playlist.name);
      visible.push(playlist);
    }
    return {playlists: visible, shadowedCount: shadowedCount};
  }

  function shadowedRowsNote(shadowedCount) {
    if (shadowedCount === 0) {
      return "";
    }
    return shadowedCount === 1
      ? "1 playlist with a duplicate name is hidden; rename it in Spotify to shuffle it."
      : shadowedCount + " playlists with duplicate names are hidden; rename them in Spotify to shuffle them.";
  }

  function likedRowLabel(hasLibraryScope) {
    return hasLibraryScope ? likedSourceName : likedSourceName + " (reconnect Spotify to enable)";
  }

  function emptySourceMessage(name) {
    return "\"" + name + "\" has no tracks to shuffle.";
  }

  // ---- Telemetry value logic ----
  // Sanitized rate-limit evidence: bounded enums and numbers only. Nothing
  // built here may carry tokens, account or playlist identity, track URIs,
  // raw URLs, or response text.

  const telemetryRoleEndpoints = {
    "playlist-list-page": "playlists",
    "playlist-snapshot-pin": "playlist-metadata",
    "playlist-snapshot-verify": "playlist-metadata",
    "playlist-items-page": "playlist-items",
    "liked-fingerprint-open": "liked-tracks",
    "liked-items-page": "liked-tracks",
    "liked-fingerprint-verify": "liked-tracks",
    "target-create": "playlists",
    "target-replace": "playlist-items",
    "target-append": "playlist-items",
    "target-total-verify": "playlist-metadata"
  };

  function telemetryEndpointClass(role) {
    const endpointClass = telemetryRoleEndpoints[role];
    if (endpointClass === undefined) {
      throw new Error("unknown telemetry request role: " + role);
    }
    return endpointClass;
  }

  // Only a plain bounded delta is a valid Retry-After; dates and noise are
  // recorded as invalid rather than guessed at.
  function normalizeRetryAfter(headerValue) {
    if (headerValue === null || headerValue === undefined || headerValue === "") {
      return {state: "absent", seconds: null};
    }
    if (typeof headerValue === "string" && /^\d{1,6}$/.test(headerValue.trim())) {
      return {state: "valid", seconds: Number(headerValue.trim())};
    }
    return {state: "invalid", seconds: null};
  }

  function normalizeSpotifyReason(value) {
    return typeof value === "string" && /^[A-Z0-9_]{1,40}$/.test(value) ? value : null;
  }

  function normalizeTelemetryCount(value) {
    return Number.isInteger(value) && value >= 0 && value <= 1000000 ? value : null;
  }

  // Page-local rolling pressure: request starts within the last 30 seconds,
  // including the request being dispatched now.
  function rollingRequestHistory(starts, now) {
    const kept = starts.filter(function (start) { return now - start < 30000; });
    kept.push(now);
    return {starts: kept, count: kept.length};
  }

  const maxTelemetryEvents = 256;
  const maxTelemetryReportLength = 60 * 1024;

  // The 429 policy: one deadline per response, 30 seconds when Spotify's
  // guidance is missing or invalid (the span Spotify states for its rate
  // limiter), one retry only when the wait is short, a local block
  // otherwise.
  const fallbackCooldownMs = 30 * 1000;
  const maxCooldownWaitMs = 60 * 1000;

  function cooldownDeadline(retryAfter, now) {
    return now + (retryAfter.state === "valid"
      ? retryAfter.seconds * 1000
      : fallbackCooldownMs);
  }

  function validCooldownRecord(value) {
    return value !== null &&
      typeof value === "object" &&
      typeof value.until === "number" && Number.isFinite(value.until) &&
      value.until > 0;
  }

  // Only an explicit 429 is safe to replay, exactly once, and only when
  // the advertised wait is short; every other failure stays fail-fast.
  function shouldRetry429(attempt, waitMs) {
    return attempt === 1 && waitMs <= maxCooldownWaitMs;
  }

  // Failure-preserving truncation: drop the oldest successes first, then the
  // oldest events outright. Window counts computed at dispatch are retained
  // as recorded, never recomputed from the truncated list.
  function truncateTelemetryEvents(events, maxEvents) {
    if (events.length <= maxEvents) {
      return {events: events.slice(), truncated: false};
    }
    const kept = events.slice();
    let index = 0;
    while (kept.length > maxEvents && index < kept.length) {
      if (kept[index].result === "ok") {
        kept.splice(index, 1);
      } else {
        index += 1;
      }
    }
    while (kept.length > maxEvents) {
      kept.shift();
    }
    return {events: kept, truncated: true};
  }

  // The encoded report is bounded twice: the event count, then the encoded
  // length, dropping more events until it fits. Report content is ASCII by
  // construction, so string length bounds encoded bytes.
  function encodeTelemetryReport(report) {
    let bounded = truncateTelemetryEvents(report.events, maxTelemetryEvents);
    let body = Object.assign({}, report, {
      events: bounded.events,
      truncated: report.truncated || bounded.truncated
    });
    let encoded = JSON.stringify(body);
    while (encoded.length > maxTelemetryReportLength && body.events.length > 0) {
      bounded = truncateTelemetryEvents(
        body.events, Math.max(0, body.events.length - 16)
      );
      body = Object.assign({}, body, {events: bounded.events, truncated: true});
      encoded = JSON.stringify(body);
    }
    return encoded;
  }

  // The four-entry delivery queue: sanitized encoded reports awaiting the
  // server's acknowledgement. One versioned envelope record holds them.
  const telemetryQueueLimit = 4;

  function validTelemetryQueueEnvelope(value) {
    return value !== null &&
      typeof value === "object" &&
      value.version === 1 &&
      Number.isInteger(value.dropped) && value.dropped >= 0 &&
      Array.isArray(value.entries) &&
      value.entries.every(function (entry) {
        return entry !== null && typeof entry === "object" &&
          typeof entry.id === "string" && entry.id !== "" &&
          typeof entry.failed === "boolean" &&
          typeof entry.body === "string" && entry.body !== "";
      });
  }

  // Enqueue with the failure-preserving bound: overflow deletes the oldest
  // success-only entry first; when only failure-bearing entries remain, the
  // oldest is dropped and the bounded drop counter records it.
  function queueTelemetryReport(envelope, entry, limit) {
    const entries = envelope.entries.filter(function (existing) {
      return existing.id !== entry.id;
    });
    entries.push(entry);
    let dropped = envelope.dropped;
    while (entries.length > limit) {
      let dropIndex = -1;
      for (let index = 0; index < entries.length; index += 1) {
        if (!entries[index].failed) {
          dropIndex = index;
          break;
        }
      }
      if (dropIndex === -1) {
        dropIndex = 0;
        dropped = Math.min(1000, dropped + 1);
      }
      entries.splice(dropIndex, 1);
    }
    return {version: 1, dropped: dropped, entries: entries};
  }

  function assembleTrackPages(pages, total) {
    // Sorting by offset makes assembly independent of completion order.
    const ordered = pages.slice().sort((a, b) => a.offset - b.offset);
    let count = 0;
    const uris = [];
    for (const page of ordered) {
      count += page.count;
      uris.push(...page.uris);
    }
    if (count !== total) {
      throw new PlaylistChangedError("the playlist changed while its tracks were read");
    }
    return uris;
  }

  return {
    AuthorizationRevokedError: AuthorizationRevokedError,
    CooldownActiveError: CooldownActiveError,
    PlaylistChangedError: PlaylistChangedError,
    TokenRejectedError: TokenRejectedError,
    addTracksURL: addTracksURL,
    cooldownDeadline: cooldownDeadline,
    fallbackCooldownMs: fallbackCooldownMs,
    maxCooldownWaitMs: maxCooldownWaitMs,
    shouldRetry429: shouldRetry429,
    validCooldownRecord: validCooldownRecord,
    assembleTrackPages: assembleTrackPages,
    buildTokenRecord: buildTokenRecord,
    countTrackChanges: countTrackChanges,
    createPlaylistURL: createPlaylistURL,
    derivedPlaylistName: derivedPlaylistName,
    derivedPlaylistSuffix: derivedPlaylistSuffix,
    displayedPlaylists: displayedPlaylists,
    emptySourceMessage: emptySourceMessage,
    encodeTelemetryReport: encodeTelemetryReport,
    findPlaylistByName: findPlaylistByName,
    hasScope: hasScope,
    likedPageURL: likedPageURL,
    likedRecordMatches: likedRecordMatches,
    likedRowLabel: likedRowLabel,
    likedSourceName: likedSourceName,
    loadedTracksMessage: loadedTracksMessage,
    maxPlaylistTracks: maxPlaylistTracks,
    maxTelemetryEvents: maxTelemetryEvents,
    maxTelemetryReportLength: maxTelemetryReportLength,
    normalizeRetryAfter: normalizeRetryAfter,
    normalizeSpotifyReason: normalizeSpotifyReason,
    normalizeTelemetryCount: normalizeTelemetryCount,
    playlistLabel: playlistLabel,
    playlistSnapshotURL: playlistSnapshotURL,
    playlistTotalURL: playlistTotalURL,
    playlistsEndpoint: playlistsEndpoint,
    readCreatedPlaylist: readCreatedPlaylist,
    readLikedTrackPage: readLikedTrackPage,
    readPlaylistPage: readPlaylistPage,
    readPlaylistItemPage: readPlaylistItemPage,
    readPlaylistSnapshot: readPlaylistSnapshot,
    readPlaylistTotal: readPlaylistTotal,
    remainingTrackOffsets: remainingTrackOffsets,
    rollingRequestHistory: rollingRequestHistory,
    shadowedRowsNote: shadowedRowsNote,
    shuffledURIs: shuffledURIs,
    shuffleResultMessage: shuffleResultMessage,
    SpotifyRequestError: SpotifyRequestError,
    telemetryEndpointClass: telemetryEndpointClass,
    telemetryQueueLimit: telemetryQueueLimit,
    queueTelemetryReport: queueTelemetryReport,
    trackChangesSuffix: trackChangesSuffix,
    trackPageURL: trackPageURL,
    truncateTelemetryEvents: truncateTelemetryEvents,
    uriBatches: uriBatches,
    validLikedCacheRecord: validLikedCacheRecord,
    validPlaylistCursor: validPlaylistCursor,
    validTelemetryQueueEnvelope: validTelemetryQueueEnvelope,
    validTokenRecord: validTokenRecord,
    validTrackCacheRecord: validTrackCacheRecord
  };
}());
