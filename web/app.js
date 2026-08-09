(function () {
  "use strict";

  const authorizeEndpoint = "https://accounts.spotify.com/authorize";
  const tokenEndpoint = "https://accounts.spotify.com/api/token";
  const playlistsEndpoint = "https://api.spotify.com/v1/me/playlists";
  // Spotify caps a page at 50 items and a library at 10,000 playlists.
  const playlistPageLimit = 50;
  const maxPlaylistPages = 200;
  // Keep the legacy namespace so the product rename preserves browser sessions.
  const tokenStorageKey = "spotify_shuffle.oauth.v1";
  const stateStorageKey = "spotify_shuffle.oauth.state.v1";
  const verifierStorageKey = "spotify_shuffle.oauth.verifier.v1";
  const expirySkewMilliseconds = 60 * 1000;
  const scopes = [
    "playlist-read-private",
    "playlist-modify-public",
    "playlist-modify-private"
  ];

  const statusElement = document.getElementById("status");
  const connectButton = document.getElementById("connect");
  const logoutButton = document.getElementById("logout");
  const playlistStatusElement = document.getElementById("playlist-status");
  const playlistsElement = document.getElementById("playlists");
  let publicConfig = null;
  let selectedPlaylist = null;

  class TokenRejectedError extends Error {}
  class AuthorizationRevokedError extends TokenRejectedError {}

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

  function validTokenRecord(value) {
    return value !== null &&
      typeof value === "object" &&
      typeof value.access_token === "string" && value.access_token !== "" &&
      typeof value.refresh_token === "string" && value.refresh_token !== "" &&
      typeof value.token_type === "string" && value.token_type !== "" &&
      typeof value.scope === "string" &&
      typeof value.expires_at === "number" && Number.isFinite(value.expires_at);
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
      if (validTokenRecord(token)) {
        return token;
      }
    } catch (_) {
      // Invalid records are removed below.
    }
    clearStoredToken();
    return null;
  }

  function storeTokenResponse(payload, previousToken) {
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

    const token = {
      access_token: payload.access_token,
      refresh_token: refreshToken,
      token_type: tokenType,
      scope: scope,
      expires_at: Date.now() + (payload.expires_in * 1000)
    };
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

  function clearPlaylists() {
    selectedPlaylist = null;
    playlistsElement.textContent = "";
    playlistsElement.hidden = true;
    playlistStatusElement.textContent = "";
    playlistStatusElement.hidden = true;
  }

  function playlistLabel(playlist) {
    if (playlist.total === null) {
      return playlist.name;
    }
    return playlist.name + " (" + playlist.total +
      (playlist.total === 1 ? " track)" : " tracks)");
  }

  function readPlaylistPage(payload, playlists) {
    if (!payload || !Array.isArray(payload.items)) {
      throw new Error("Spotify returned an invalid playlist page");
    }
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
  }

  async function requestPlaylistPage(token, url) {
    const response = await window.fetch(url, {
      headers: {Authorization: token.token_type + " " + token.access_token}
    });
    if (!response.ok) {
      throw new Error("Spotify playlist request failed with status " + response.status);
    }
    return response.json();
  }

  async function fetchPlaylists(token) {
    const playlists = [];
    let url = playlistsEndpoint + "?limit=" + playlistPageLimit;
    for (let page = 0; page < maxPlaylistPages; page += 1) {
      const payload = await requestPlaylistPage(token, url);
      readPlaylistPage(payload, playlists);
      if (typeof payload.next !== "string" || payload.next === "") {
        return playlists;
      }
      // The bearer token must never follow a cursor off the Spotify API origin.
      if (!payload.next.startsWith(playlistsEndpoint + "?")) {
        throw new Error("Spotify returned an unexpected playlist page cursor");
      }
      url = payload.next;
    }
    throw new Error("Spotify returned more playlist pages than this app reads");
  }

  function selectPlaylist(playlist, button) {
    if (selectedPlaylist) {
      selectedPlaylist.button.setAttribute("aria-pressed", "false");
    }
    selectedPlaylist = {id: playlist.id, name: playlist.name, button: button};
    button.setAttribute("aria-pressed", "true");
    renderPlaylistStatus("Selected " + playlist.name + ".");
  }

  function renderPlaylists(playlists) {
    playlistsElement.textContent = "";
    for (const playlist of playlists) {
      const button = document.createElement("button");
      button.type = "button";
      // Playlist names are third-party text and must never become markup.
      button.textContent = playlistLabel(playlist);
      button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", function () {
        selectPlaylist(playlist, button);
      });

      const item = document.createElement("li");
      item.appendChild(button);
      playlistsElement.appendChild(item);
    }
    playlistsElement.hidden = false;
  }

  async function loadPlaylists(token) {
    renderPlaylistStatus("Loading playlists...");
    let playlists;
    try {
      playlists = await fetchPlaylists(token);
    } catch (_) {
      // A failed listing is not proof of revocation, so the token is kept.
      renderPlaylistStatus("Playlists could not be loaded. Reload to try again.");
      return;
    }

    if (playlists.length === 0) {
      renderPlaylistStatus("This Spotify account has no playlists.");
      return;
    }
    renderPlaylists(playlists);
    renderPlaylistStatus("Select a playlist.");
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
    clearPlaylists();
    renderDisconnected("Spotify was disconnected from this browser.");
  });

  initialize();
}());
