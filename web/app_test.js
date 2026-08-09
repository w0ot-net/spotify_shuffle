"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const {webcrypto} = require("node:crypto");
const {TextEncoder} = require("node:util");

const pureSource = fs.readFileSync(path.join(__dirname, "pure.js"), "utf8");
const appSource = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
const tokenStorageKey = "spotify_shuffle.oauth.v1";
const stateStorageKey = "spotify_shuffle.oauth.state.v1";
const verifierStorageKey = "spotify_shuffle.oauth.verifier.v1";
const tokenEndpoint = "https://accounts.spotify.com/api/token";
const playlistsEndpoint = "https://api.spotify.com/v1/me/playlists";

class FakeStorage {
  constructor(entries, failures) {
    this.values = new Map(Object.entries(entries || {}));
    this.failures = failures || {};
    this.setCount = 0;
  }

  getItem(key) {
    if (this.failures.get) {
      throw new Error("storage read failed");
    }
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.setCount += 1;
    if (this.failures.set || this.failures.setAt === this.setCount) {
      throw new Error("storage write failed");
    }
    this.values.set(key, String(value));
  }

  removeItem(key) {
    if (this.failures.remove) {
      throw new Error("storage removal failed");
    }
    this.values.delete(key);
  }
}

class FakeElement {
  constructor(hidden) {
    this.textContent = "";
    this.hidden = hidden;
    this.disabled = false;
    this.listeners = new Map();
    this.attributes = new Map();
  }

  // Assigning textContent removes existing children in a real DOM.
  set textContent(value) {
    this.text = String(value);
    this.children = [];
  }

  get textContent() {
    return this.text;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  click() {
    const listener = this.listeners.get("click");
    assert.ok(listener, "click listener is registered");
    listener();
  }
}

function jsonResponse(status, payload, jsonError) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    async json() {
      if (jsonError) {
        throw jsonError;
      }
      return payload;
    }
  };
}

function expiredToken() {
  return {
    access_token: "old-access-token",
    refresh_token: "saved-refresh-token",
    token_type: "Bearer",
    scope: "playlist-read-private",
    expires_at: 0
  };
}

function currentToken() {
  return Object.assign(expiredToken(), {
    access_token: "current-access-token",
    expires_at: Date.now() + (3600 * 1000)
  });
}

function playlistPage(items, next) {
  return jsonResponse(200, {items: items, next: next || null});
}

function createHarness(options) {
  options = options || {};
  const statusElement = new FakeElement(false);
  const connectButton = new FakeElement(true);
  const logoutButton = new FakeElement(true);
  const playlistStatusElement = new FakeElement(true);
  const playlistsElement = new FakeElement(true);
  const elements = {
    status: statusElement,
    connect: connectButton,
    logout: logoutButton,
    "playlist-status": playlistStatusElement,
    playlists: playlistsElement
  };
  const localStorage = options.localStorage || new FakeStorage();
  const sessionStorage = options.sessionStorage || new FakeStorage();
  const requests = [];
  const historyPaths = [];
  const location = {
    origin: "https://shuffle.example",
    pathname: options.pathname || "/",
    search: options.search || "",
    assigned: null,
    assign(url) {
      this.assigned = url;
    }
  };
  const window = {
    crypto: webcrypto,
    localStorage: localStorage,
    sessionStorage: sessionStorage,
    location: location,
    history: {
      replaceState(_state, _title, nextPath) {
        historyPaths.push(nextPath);
      }
    },
    btoa(value) {
      return Buffer.from(value, "binary").toString("base64");
    },
    async fetch(url, requestOptions) {
      requests.push({url: url, options: requestOptions});
      if (url === "/api/config") {
        return jsonResponse(200, {spotify_client_id: "test-client-id"});
      }
      if (url === tokenEndpoint && options.tokenHandler) {
        return options.tokenHandler(requestOptions);
      }
      if (url.startsWith(playlistsEndpoint + "?")) {
        return (options.playlistHandler || (() => playlistPage([])))(url, requestOptions);
      }
      throw new Error("unexpected fetch: " + url);
    }
  };
  const document = {
    getElementById(id) {
      return elements[id];
    },
    createElement(_tagName) {
      return new FakeElement(false);
    }
  };
  const context = vm.createContext({
    Buffer: Buffer,
    TextEncoder: TextEncoder,
    URL: URL,
    URLSearchParams: URLSearchParams,
    Uint8Array: Uint8Array,
    document: document,
    window: window
  });

  // Match the served page: pure.js defines the TrueShuffle global app.js reads.
  vm.runInContext(pureSource, context, {filename: "web/pure.js"});
  vm.runInContext(appSource, context, {filename: "web/app.js"});
  return {
    connectButton: connectButton,
    historyPaths: historyPaths,
    localStorage: localStorage,
    location: location,
    logoutButton: logoutButton,
    playlistStatusElement: playlistStatusElement,
    playlistsElement: playlistsElement,
    requests: requests,
    sessionStorage: sessionStorage,
    statusElement: statusElement
  };
}

function playlistButtons(harness) {
  return harness.playlistsElement.children.map((item) => item.children[0]);
}

async function settle(rounds) {
  for (let index = 0; index < (rounds || 12); index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const temporaryRefreshCases = [
  {
    name: "429 response",
    handler: () => jsonResponse(429, {error: "temporarily_unavailable"})
  },
  {
    name: "server failure",
    handler: () => jsonResponse(500, {error: "server_error"})
  },
  {
    name: "non-JSON response",
    handler: () => jsonResponse(502, null, new SyntaxError("invalid JSON"))
  },
  {
    name: "network failure",
    handler: () => {
      throw new Error("network unavailable");
    }
  },
  {
    name: "malformed successful response",
    handler: () => jsonResponse(200, {access_token: "incomplete"})
  }
];

for (const testCase of temporaryRefreshCases) {
  test("refresh retains authorization after " + testCase.name, async () => {
    const token = expiredToken();
    const rawToken = JSON.stringify(token);
    const localStorage = new FakeStorage({[tokenStorageKey]: rawToken});
    const harness = createHarness({
      localStorage: localStorage,
      tokenHandler: testCase.handler
    });

    await settle();

    assert.equal(localStorage.getItem(tokenStorageKey), rawToken);
    assert.equal(harness.statusElement.textContent, "Spotify could not be reached. Reload to try again.");
    assert.equal(harness.connectButton.hidden, true);
  });
}

test("invalid_grant clears authorization and requires reconnection", async () => {
  const localStorage = new FakeStorage({
    [tokenStorageKey]: JSON.stringify(expiredToken())
  });
  const harness = createHarness({
    localStorage: localStorage,
    tokenHandler: () => jsonResponse(400, {error: "invalid_grant"})
  });

  await settle();

  assert.equal(localStorage.getItem(tokenStorageKey), null);
  assert.equal(harness.statusElement.textContent, "Spotify authorization expired. Please connect again.");
  assert.equal(harness.connectButton.hidden, false);
});

test("successful refresh preserves an omitted refresh token", async () => {
  const localStorage = new FakeStorage({
    [tokenStorageKey]: JSON.stringify(expiredToken())
  });
  const harness = createHarness({
    localStorage: localStorage,
    tokenHandler: () => jsonResponse(200, {
      access_token: "new-access-token",
      token_type: "Bearer",
      scope: "playlist-read-private",
      expires_in: 3600
    })
  });

  await settle();

  const storedToken = JSON.parse(localStorage.getItem(tokenStorageKey));
  assert.equal(storedToken.access_token, "new-access-token");
  assert.equal(storedToken.refresh_token, "saved-refresh-token");
  assert.equal(harness.statusElement.textContent, "Spotify is connected in this browser.");
});

test("callback cleans its URL when pending authorization reads fail", async () => {
  const sessionStorage = new FakeStorage({}, {get: true});
  const harness = createHarness({
    pathname: "/callback",
    search: "?code=authorization-code&state=returned-state",
    sessionStorage: sessionStorage
  });

  await settle();

  assert.deepEqual(harness.historyPaths, ["/"]);
  assert.equal(
    harness.statusElement.textContent,
    "Spotify authorization could not be verified. Please connect again."
  );
  assert.equal(harness.requests.length, 1);
});

test("callback cleans its URL when pending authorization removals fail", async () => {
  const sessionStorage = new FakeStorage({
    [stateStorageKey]: "returned-state",
    [verifierStorageKey]: "saved-verifier"
  }, {remove: true});
  const harness = createHarness({
    pathname: "/callback",
    search: "?code=authorization-code&state=returned-state",
    sessionStorage: sessionStorage,
    tokenHandler: () => jsonResponse(200, {
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      token_type: "Bearer",
      scope: "playlist-read-private",
      expires_in: 3600
    })
  });

  await settle();

  assert.deepEqual(harness.historyPaths, ["/"]);
  assert.equal(harness.statusElement.textContent, "Spotify is connected in this browser.");
  assert.ok(harness.localStorage.getItem(tokenStorageKey));
});

test("playlist listing renders every page in order", async () => {
  const secondPage = playlistsEndpoint + "?offset=50&limit=50";
  const harness = createHarness({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(currentToken())}),
    playlistHandler: (url) => {
      if (url === playlistsEndpoint + "?limit=50") {
        return playlistPage([
          {id: "first", name: "Morning", tracks: {total: 1}},
          null,
          {id: "second", name: "Evening", tracks: {total: 4212}}
        ], secondPage);
      }
      assert.equal(url, secondPage);
      return playlistPage([{id: "third", name: "Late", tracks: {total: 0}}]);
    }
  });

  await settle();

  assert.deepEqual(
    playlistButtons(harness).map((button) => button.textContent),
    ["Morning (1 track)", "Evening (4212 tracks)", "Late (0 tracks)"]
  );
  assert.equal(harness.playlistsElement.hidden, false);
  assert.equal(harness.playlistStatusElement.textContent, "Select a playlist.");
  assert.equal(harness.statusElement.textContent, "Spotify is connected in this browser.");

  const playlistRequests = harness.requests.filter((request) => request.url.startsWith(playlistsEndpoint));
  assert.equal(playlistRequests.length, 2);
  assert.equal(playlistRequests[0].options.headers.Authorization, "Bearer current-access-token");
});

test("playlist listing renders an empty account state", async () => {
  const harness = createHarness({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(currentToken())}),
    playlistHandler: () => playlistPage([])
  });

  await settle();

  assert.equal(harness.playlistStatusElement.textContent, "This Spotify account has no playlists.");
  assert.equal(harness.playlistsElement.hidden, true);
});

test("a failed playlist listing retains authorization", async () => {
  const rawToken = JSON.stringify(currentToken());
  const localStorage = new FakeStorage({[tokenStorageKey]: rawToken});
  const harness = createHarness({
    localStorage: localStorage,
    playlistHandler: () => jsonResponse(500, {error: {status: 500}})
  });

  await settle();

  assert.equal(localStorage.getItem(tokenStorageKey), rawToken);
  assert.equal(harness.statusElement.textContent, "Spotify is connected in this browser.");
  assert.equal(harness.logoutButton.hidden, false);
  assert.equal(
    harness.playlistStatusElement.textContent,
    "Playlists could not be loaded. Reload to try again."
  );
});

test("a playlist page cursor off the Spotify API origin is rejected", async () => {
  const attackerCursor = "https://attacker.example/v1/me/playlists?offset=50";
  const harness = createHarness({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(currentToken())}),
    playlistHandler: () => playlistPage(
      [{id: "first", name: "Morning", tracks: {total: 1}}],
      attackerCursor
    )
  });

  await settle();

  // The point of the guard is that the bearer token never leaves the Spotify
  // API origin, so the load-bearing assertion is that no request was issued
  // to the cursor at all; the failure UI alone also appears when the fake
  // fetch rejects an unguarded request, which would hide a deleted guard.
  assert.ok(
    harness.requests.every((request) => request.url !== attackerCursor),
    "a request was issued to the off-origin cursor"
  );
  assert.equal(
    harness.playlistStatusElement.textContent,
    "Playlists could not be loaded. Reload to try again."
  );
  assert.equal(harness.playlistsElement.hidden, true);
});

test("selecting a playlist marks it and moves the mark on reselection", async () => {
  const harness = createHarness({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(currentToken())}),
    playlistHandler: () => playlistPage([
      {id: "first", name: "Morning", tracks: {total: 1}},
      {id: "second", name: "Evening", tracks: {total: 2}}
    ])
  });

  await settle();
  const buttons = playlistButtons(harness);
  const requestCount = harness.requests.length;

  buttons[0].click();
  assert.equal(buttons[0].getAttribute("aria-pressed"), "true");
  assert.equal(harness.playlistStatusElement.textContent, "Selected Morning.");

  buttons[1].click();
  assert.equal(buttons[0].getAttribute("aria-pressed"), "false");
  assert.equal(buttons[1].getAttribute("aria-pressed"), "true");
  assert.equal(harness.playlistStatusElement.textContent, "Selected Evening.");
  assert.equal(harness.requests.length, requestCount);
});

test("disconnecting clears a rendered playlist list", async () => {
  const harness = createHarness({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(currentToken())}),
    playlistHandler: () => playlistPage([{id: "first", name: "Morning", tracks: {total: 1}}])
  });

  await settle();
  assert.equal(playlistButtons(harness).length, 1);

  harness.logoutButton.click();

  assert.deepEqual(harness.playlistsElement.children, []);
  assert.equal(harness.playlistsElement.hidden, true);
  assert.equal(harness.playlistStatusElement.hidden, true);
  assert.equal(harness.statusElement.textContent, "Spotify was disconnected from this browser.");
});

test("connect recovers from a partial pending authorization write", async () => {
  const sessionStorage = new FakeStorage({}, {setAt: 2});
  const harness = createHarness({sessionStorage: sessionStorage});
  await settle();
  assert.equal(harness.connectButton.hidden, false);

  harness.connectButton.click();
  await settle(40);

  assert.equal(harness.location.assigned, null);
  assert.equal(sessionStorage.getItem(stateStorageKey), null);
  assert.equal(sessionStorage.getItem(verifierStorageKey), null);
  assert.equal(harness.statusElement.textContent, "Spotify authorization could not be started.");
  assert.equal(harness.connectButton.hidden, false);
  assert.equal(harness.connectButton.disabled, false);
});
