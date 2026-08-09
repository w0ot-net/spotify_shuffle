(function () {
  "use strict";

  const authorizeEndpoint = "https://accounts.spotify.com/authorize";
  const tokenEndpoint = "https://accounts.spotify.com/api/token";
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
  let publicConfig = null;

  class TokenRejectedError extends Error {}

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
    window.sessionStorage.removeItem(stateStorageKey);
    window.sessionStorage.removeItem(verifierStorageKey);
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

  async function startAuthorization() {
    if (!publicConfig) {
      throw new Error("public configuration is unavailable");
    }

    renderWorking("Opening Spotify authorization...");
    const state = randomBase64URL(32);
    const verifier = randomBase64URL(64);
    const challenge = await codeChallenge(verifier);
    window.sessionStorage.setItem(stateStorageKey, state);
    window.sessionStorage.setItem(verifierStorageKey, verifier);

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
    const expectedState = window.sessionStorage.getItem(stateStorageKey);
    const verifier = window.sessionStorage.getItem(verifierStorageKey);
    clearPendingAuthorization();
    cleanCallbackURL();

    const returnedState = parameters.get("state");
    if (!returnedState || !expectedState || returnedState !== expectedState) {
      throw new TokenRejectedError("Spotify authorization could not be verified. Please connect again.");
    }
    if (parameters.has("error")) {
      throw new TokenRejectedError("Spotify authorization was not granted.");
    }

    const code = parameters.get("code");
    if (!code || !verifier) {
      throw new TokenRejectedError("Spotify authorization could not be verified. Please connect again.");
    }

    const payload = await requestToken({
      client_id: publicConfig.spotify_client_id,
      grant_type: "authorization_code",
      code: code,
      redirect_uri: redirectURI(),
      code_verifier: verifier
    });
    storeTokenResponse(payload, null);
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
        await handleCallback();
        renderConnected();
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
      return;
    }

    renderWorking("Refreshing Spotify connection...");
    try {
      await refreshToken(token);
      renderConnected();
    } catch (error) {
      if (error instanceof TokenRejectedError) {
        clearStoredToken();
        renderError("Spotify authorization expired. Please connect again.", true);
        return;
      }
      renderError("Spotify could not be reached. Reload to try again.", false);
    }
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
    renderDisconnected("Spotify was disconnected from this browser.");
  });

  initialize();
}());
