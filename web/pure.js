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
  // The published maximum page size for the tracks endpoint. The server
  // echoes the size it actually enforced, and offsets step by that echo.
  const trackPageLimit = 100;
  // Spotify caps a playlist at 10,000 items.
  const maxPlaylistTracks = 10000;

  class TokenRejectedError extends Error {}
  class AuthorizationRevokedError extends TokenRejectedError {}
  class PlaylistChangedError extends Error {}

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
        total: item.tracks && Number.isFinite(item.tracks.total) ? item.tracks.total : null,
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
      "/tracks?fields=limit,total,items(track(uri))" +
      "&limit=" + trackPageLimit + "&offset=" + offset;
  }

  function readPlaylistSnapshot(payload) {
    if (!payload || typeof payload.snapshot_id !== "string" || payload.snapshot_id === "") {
      throw new Error("Spotify returned an invalid playlist snapshot");
    }
    return payload.snapshot_id;
  }

  function readTrackPage(payload) {
    if (!payload || !Array.isArray(payload.items) ||
        !Number.isInteger(payload.limit) || payload.limit <= 0 ||
        !Number.isInteger(payload.total) || payload.total < 0) {
      throw new Error("Spotify returned an invalid track page");
    }
    const uris = [];
    for (const item of payload.items) {
      // Items without an exposable track URI are skipped, but the raw count
      // keeps them so completeness is checked against what Spotify sent.
      if (item && item.track && typeof item.track.uri === "string" && item.track.uri !== "") {
        uris.push(item.track.uri);
      }
    }
    return {limit: payload.limit, total: payload.total, count: payload.items.length, uris: uris};
  }

  function likedPageURL(offset) {
    return likedTracksEndpoint + "?limit=" + likedPageLimit + "&offset=" + offset;
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

  // The full loaded-tracks message: plain count for a cache hit (null
  // elapsed), one-decimal duration for a network read, and the membership
  // difference when a prior record existed and something changed.
  function loadedTracksMessage(count, elapsedMilliseconds, changes) {
    let message = "Loaded " + count + (count === 1 ? " track" : " tracks");
    if (elapsedMilliseconds !== null) {
      message += " in " + (Math.max(0, elapsedMilliseconds) / 1000).toFixed(1) + "s";
    }
    message += ".";
    if (changes && (changes.added !== 0 || changes.removed !== 0)) {
      message += " " + changes.added + " added, " + changes.removed +
        " removed since last read.";
    }
    return message;
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
    PlaylistChangedError: PlaylistChangedError,
    TokenRejectedError: TokenRejectedError,
    assembleTrackPages: assembleTrackPages,
    buildTokenRecord: buildTokenRecord,
    countTrackChanges: countTrackChanges,
    hasScope: hasScope,
    likedPageURL: likedPageURL,
    loadedTracksMessage: loadedTracksMessage,
    maxPlaylistTracks: maxPlaylistTracks,
    playlistLabel: playlistLabel,
    playlistSnapshotURL: playlistSnapshotURL,
    playlistsEndpoint: playlistsEndpoint,
    readPlaylistPage: readPlaylistPage,
    readPlaylistSnapshot: readPlaylistSnapshot,
    readTrackPage: readTrackPage,
    remainingTrackOffsets: remainingTrackOffsets,
    trackPageURL: trackPageURL,
    validPlaylistCursor: validPlaylistCursor,
    validTokenRecord: validTokenRecord,
    validTrackCacheRecord: validTrackCacheRecord
  };
}());
