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
  const trackStatusElement = document.getElementById("track-status");
  const playlistsElement = document.getElementById("playlists");
  let publicConfig = null;
  let selectedPlaylist = null;
  let playlistButtons = [];
  // The selected playlist's verified read: {id, snapshotId, uris}. This is
  // the attachment point for caching and shuffle generation.
  let loadedTracks = null;

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

  function clearPlaylists() {
    selectedPlaylist = null;
    loadedTracks = null;
    playlistButtons = [];
    playlistsElement.textContent = "";
    playlistsElement.hidden = true;
    playlistStatusElement.textContent = "";
    playlistStatusElement.hidden = true;
    trackStatusElement.textContent = "";
    trackStatusElement.hidden = true;
  }

  async function requestSpotify(token, url) {
    const response = await window.fetch(url, {
      headers: {Authorization: token.token_type + " " + token.access_token}
    });
    if (!response.ok) {
      throw new Error("Spotify request failed with status " + response.status);
    }
    return response.json();
  }

  async function fetchPlaylists(token) {
    const playlists = [];
    let url = playlistsEndpoint + "?limit=" + playlistPageLimit;
    for (let page = 0; page < maxPlaylistPages; page += 1) {
      const payload = await requestSpotify(token, url);
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

  function setPlaylistButtonsDisabled(disabled) {
    for (const button of playlistButtons) {
      button.disabled = disabled;
    }
  }

  async function fetchTrackPages(token, playlistId, offsets) {
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
          const page = TrueShuffle.readTrackPage(
            await requestSpotify(token, TrueShuffle.trackPageURL(playlistId, offset))
          );
          pages.push({offset: offset, count: page.count, uris: page.uris});
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
  async function readPlaylistTracks(token, playlistId) {
    const pinnedSnapshot = TrueShuffle.readPlaylistSnapshot(
      await requestSpotify(token, TrueShuffle.playlistSnapshotURL(playlistId))
    );
    const firstPage = TrueShuffle.readTrackPage(
      await requestSpotify(token, TrueShuffle.trackPageURL(playlistId, 0))
    );
    const offsets = TrueShuffle.remainingTrackOffsets(firstPage.limit, firstPage.total);
    const pages = await fetchTrackPages(token, playlistId, offsets);
    pages.push({offset: 0, count: firstPage.count, uris: firstPage.uris});
    const uris = TrueShuffle.assembleTrackPages(pages, firstPage.total);
    const confirmedSnapshot = TrueShuffle.readPlaylistSnapshot(
      await requestSpotify(token, TrueShuffle.playlistSnapshotURL(playlistId))
    );
    if (confirmedSnapshot !== pinnedSnapshot) {
      throw new TrueShuffle.PlaylistChangedError("the playlist changed while its tracks were read");
    }
    return {snapshotId: pinnedSnapshot, uris: uris};
  }

  function selectionActive(playlist) {
    return selectedPlaylist !== null && selectedPlaylist.id === playlist.id;
  }

  async function loadTracks(token, playlist) {
    loadedTracks = null;
    setPlaylistButtonsDisabled(true);
    renderTrackStatus("Loading tracks...");
    try {
      const read = await readPlaylistTracks(token, playlist.id);
      // Disconnecting mid-read cleared the page; drop the late result.
      if (!selectionActive(playlist)) {
        return;
      }
      loadedTracks = {id: playlist.id, snapshotId: read.snapshotId, uris: read.uris};
      renderTrackStatus("Loaded " + read.uris.length +
        (read.uris.length === 1 ? " track." : " tracks."));
    } catch (error) {
      if (!selectionActive(playlist)) {
        return;
      }
      renderTrackStatus(error instanceof TrueShuffle.PlaylistChangedError
        ? "This playlist changed while loading. Select it again."
        : "Tracks could not be loaded. Select the playlist again to retry.");
    } finally {
      setPlaylistButtonsDisabled(false);
    }
  }

  function selectPlaylist(token, playlist, button) {
    if (selectedPlaylist) {
      selectedPlaylist.button.setAttribute("aria-pressed", "false");
    }
    selectedPlaylist = {id: playlist.id, name: playlist.name, button: button};
    button.setAttribute("aria-pressed", "true");
    renderPlaylistStatus("Selected " + playlist.name + ".");
    return loadTracks(token, playlist);
  }

  function renderPlaylists(token, playlists) {
    playlistsElement.textContent = "";
    playlistButtons = [];
    for (const playlist of playlists) {
      const button = document.createElement("button");
      button.type = "button";
      // Playlist names are third-party text and must never become markup.
      button.textContent = TrueShuffle.playlistLabel(playlist);
      button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", function () {
        selectPlaylist(token, playlist, button);
      });

      const item = document.createElement("li");
      item.appendChild(button);
      playlistsElement.appendChild(item);
      playlistButtons.push(button);
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
    renderPlaylists(token, playlists);
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
