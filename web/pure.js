"use strict";

// Browser-independent value logic. No DOM, network, storage, or other
// platform interface may be referenced here; repository validation greps
// this file for their names.
var TrueShuffle = (function () {
  const playlistsEndpoint = "https://api.spotify.com/v1/me/playlists";

  class TokenRejectedError extends Error {}
  class AuthorizationRevokedError extends TokenRejectedError {}

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
        total: item.tracks && Number.isFinite(item.tracks.total) ? item.tracks.total : null
      });
    }
    return playlists;
  }

  function validPlaylistCursor(cursor) {
    return cursor.startsWith(playlistsEndpoint + "?");
  }

  return {
    AuthorizationRevokedError: AuthorizationRevokedError,
    TokenRejectedError: TokenRejectedError,
    buildTokenRecord: buildTokenRecord,
    playlistLabel: playlistLabel,
    playlistsEndpoint: playlistsEndpoint,
    readPlaylistPage: readPlaylistPage,
    validPlaylistCursor: validPlaylistCursor,
    validTokenRecord: validTokenRecord
  };
}());
