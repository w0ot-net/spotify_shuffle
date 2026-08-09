"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const {webcrypto} = require("node:crypto");
const {TextEncoder} = require("node:util");

const appSource = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
const tokenStorageKey = "spotify_shuffle.oauth.v1";
const stateStorageKey = "spotify_shuffle.oauth.state.v1";
const verifierStorageKey = "spotify_shuffle.oauth.verifier.v1";
const tokenEndpoint = "https://accounts.spotify.com/api/token";

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

function createHarness(options) {
  options = options || {};
  const statusElement = new FakeElement(false);
  const connectButton = new FakeElement(true);
  const logoutButton = new FakeElement(true);
  const elements = {
    status: statusElement,
    connect: connectButton,
    logout: logoutButton
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
      throw new Error("unexpected fetch: " + url);
    }
  };
  const document = {
    getElementById(id) {
      return elements[id];
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

  vm.runInContext(appSource, context, {filename: "web/app.js"});
  return {
    connectButton: connectButton,
    historyPaths: historyPaths,
    localStorage: localStorage,
    location: location,
    logoutButton: logoutButton,
    requests: requests,
    sessionStorage: sessionStorage,
    statusElement: statusElement
  };
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
