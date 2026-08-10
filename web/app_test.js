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
const backgroundStorageKey = "trueshuffle.background.v1";
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

// Fakes exactly the IndexedDB surface the app's wrapper touches: open with
// upgrade, get, put, and database delete, delivering callbacks via deferred
// microtasks so handler registration wins the race.
class FakeIndexedDB {
  constructor(options) {
    options = options || {};
    this.unavailable = options.unavailable || false;
    this.deletedDatabases = [];
    // database name -> store name -> Map(key -> value)
    this.databases = new Map();
    for (const [databaseName, stores] of Object.entries(options.seed || {})) {
      const storeMap = new Map();
      for (const [storeName, entries] of Object.entries(stores)) {
        storeMap.set(storeName, new Map(Object.entries(entries)));
      }
      this.databases.set(databaseName, storeMap);
    }
  }

  record(databaseName, storeName, key) {
    const stores = this.databases.get(databaseName);
    const store = stores && stores.get(storeName);
    return store ? store.get(key) : undefined;
  }

  open(name, _version) {
    const request = {onupgradeneeded: null, onsuccess: null, onerror: null, result: null, error: null};
    Promise.resolve().then(() => {
      if (this.unavailable) {
        request.error = new Error("indexeddb unavailable");
        if (request.onerror) {
          request.onerror();
        }
        return;
      }
      const isNew = !this.databases.has(name);
      if (isNew) {
        this.databases.set(name, new Map());
      }
      request.result = new FakeIndexedDBDatabase(this.databases.get(name));
      if (isNew && request.onupgradeneeded) {
        request.onupgradeneeded();
      }
      if (request.onsuccess) {
        request.onsuccess();
      }
    });
    return request;
  }

  deleteDatabase(name) {
    this.databases.delete(name);
    this.deletedDatabases.push(name);
    return {onsuccess: null, onerror: null};
  }
}

class FakeIndexedDBDatabase {
  constructor(stores) {
    this.stores = stores;
  }

  createObjectStore(name) {
    this.stores.set(name, new Map());
  }

  transaction(storeName, _mode) {
    const store = this.stores.get(storeName);
    const operations = [];
    const transaction = {
      oncomplete: null,
      onerror: null,
      onabort: null,
      error: null,
      objectStore(_name) {
        return {
          get(key) {
            const request = {onsuccess: null, onerror: null, result: undefined, error: null};
            operations.push(() => {
              request.result = store.get(key);
              if (request.onsuccess) {
                request.onsuccess();
              }
            });
            return request;
          },
          put(value, key) {
            operations.push(() => {
              store.set(key, value);
            });
            return {onsuccess: null, onerror: null};
          }
        };
      }
    };
    Promise.resolve().then(() => {
      for (const operation of operations) {
        operation();
      }
      if (transaction.oncomplete) {
        transaction.oncomplete();
      }
    });
    return transaction;
  }

  close() {}
}

class FakeElement {
  constructor(hidden) {
    this.textContent = "";
    this.value = "";
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

  change() {
    const listener = this.listeners.get("change");
    assert.ok(listener, "change listener is registered");
    listener();
  }
}

function jsonResponse(status, payload, jsonError, headers) {
  const headerMap = headers || {};
  return {
    ok: status >= 200 && status < 300,
    status: status,
    headers: {
      get(name) {
        return Object.prototype.hasOwnProperty.call(headerMap, name)
          ? headerMap[name]
          : null;
      }
    },
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

function snapshotPage(snapshotId) {
  return jsonResponse(200, {snapshot_id: snapshotId});
}

function playlistItemPageResponse(limit, total, uris) {
  return jsonResponse(200, {
    limit: limit,
    total: total,
    items: uris.map((uri) => ({item: {uri: uri}}))
  });
}

function savedTrackPageResponse(limit, total, uris) {
  return jsonResponse(200, {
    limit: limit,
    total: total,
    items: uris.map((uri) => ({track: {uri: uri}}))
  });
}

function snapshotURL(playlistId) {
  return "https://api.spotify.com/v1/playlists/" + playlistId + "?fields=snapshot_id";
}

function trackURL(playlistId, offset) {
  return "https://api.spotify.com/v1/playlists/" + playlistId +
    "/items?fields=limit,total,items(item(uri))&limit=50&offset=" + offset;
}

// Serves the snapshot pin/verify and every offset page for one playlist
// whose contents never change during the read.
function steadyTrackHandler(playlistId, snapshotId, limit, uris) {
  return (url) => {
    if (url === snapshotURL(playlistId)) {
      return snapshotPage(snapshotId);
    }
    const offset = Number(new URL(url).searchParams.get("offset"));
    assert.equal(url, trackURL(playlistId, offset));
    return playlistItemPageResponse(limit, uris.length, uris.slice(offset, offset + limit));
  };
}

function likedToken() {
  return Object.assign(currentToken(), {
    scope: "playlist-read-private playlist-modify-private user-library-read"
  });
}

function likedURL(offset) {
  return "https://api.spotify.com/v1/me/tracks?limit=50&offset=" + offset;
}

// Serves every saved-tracks page for a library whose contents never change.
function steadyLikedHandler(limit, uris) {
  return (url) => {
    const offset = Number(new URL(url).searchParams.get("offset"));
    assert.equal(url, likedURL(offset));
    return savedTrackPageResponse(limit, uris.length, uris.slice(offset, offset + limit));
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return {promise: promise, resolve: resolve};
}

// Serves the whole write path for any number of derived targets: creation
// (assigning target-1, target-2, ...), batch writes with
// replace-versus-append contents modeling, and totals. Pre-register
// {id, name, contents} rows via backend.targets for derived playlists that
// already exist. handle() returns null for URLs it does not own.
function makeWriteBackend() {
  const backend = {targets: [], createBodies: [], writes: [], nextId: 1};
  backend.find = (id) => backend.targets.find((target) => target.id === id) || null;
  backend.writesFor = (id) => backend.writes.filter((write) => write.id === id);
  backend.handle = (url, requestOptions) => {
    if (url === playlistsEndpoint) {
      assert.equal(requestOptions.method, "POST");
      const body = JSON.parse(requestOptions.body);
      backend.createBodies.push(body);
      const target = {id: "target-" + backend.nextId, name: body.name, contents: null};
      backend.nextId += 1;
      backend.targets.push(target);
      return jsonResponse(200, {id: target.id, name: target.name});
    }
    const write = url.match(/^https:\/\/api\.spotify\.com\/v1\/playlists\/([^/?]+)\/items$/);
    if (write !== null && backend.find(write[1]) !== null) {
      const target = backend.find(write[1]);
      const uris = JSON.parse(requestOptions.body).uris;
      backend.writes.push({id: target.id, method: requestOptions.method, uris: uris});
      target.contents = requestOptions.method === "PUT"
        ? uris.slice()
        : (target.contents || []).concat(uris);
      return jsonResponse(201, {snapshot_id: "write-snap"});
    }
    const total = url.match(/^https:\/\/api\.spotify\.com\/v1\/playlists\/([^/?]+)\?fields=items\.total$/);
    if (total !== null && backend.find(total[1]) !== null) {
      return jsonResponse(200, {items: {total: (backend.find(total[1]).contents || []).length}});
    }
    return null;
  };
  return backend;
}

// Routes write-path URLs to the backend and everything else on the
// playlists prefix to the source read handler.
function backendOptions(backend, sourceTrackHandler) {
  return {
    createPlaylistHandler: backend.handle,
    trackHandler: (url, requestOptions) =>
      backend.handle(url, requestOptions) ||
      (sourceTrackHandler || ((unexpected) => {
        throw new Error("unexpected source request: " + unexpected);
      }))(url, requestOptions)
  };
}

function createHarness(options) {
  options = options || {};
  const statusElement = new FakeElement(false);
  const connectButton = new FakeElement(true);
  const logoutButton = new FakeElement(true);
  const playlistStatusElement = new FakeElement(true);
  const trackStatusElement = new FakeElement(true);
  const trackProgressElement = new FakeElement(true);
  const openTargetLink = new FakeElement(true);
  const waitStatusElement = new FakeElement(true);
  const cancelButton = new FakeElement(true);
  const playlistsElement = new FakeElement(true);
  const backgroundSelect = new FakeElement(false);
  backgroundSelect.value = "ribbon";
  const elements = {
    background: backgroundSelect,
    status: statusElement,
    connect: connectButton,
    logout: logoutButton,
    "playlist-status": playlistStatusElement,
    "track-status": trackStatusElement,
    "track-progress": trackProgressElement,
    "open-target": openTargetLink,
    "wait-status": waitStatusElement,
    cancel: cancelButton,
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
  const telemetryReports = [];
  const clock = options.clock || null;
  const window = {
    crypto: webcrypto,
    localStorage: localStorage,
    sessionStorage: sessionStorage,
    // Monotonic-enough for tests: durations only need to be non-negative.
    // A manual clock takes over time and timers for pacing cases; without
    // one, timers fire on the next microtask so paced waits cost nothing.
    performance: {now: () => (clock ? clock.now : Date.now())},
    setTimeout(callback, milliseconds) {
      if (clock) {
        clock.timers.push({at: clock.now + milliseconds, callback: callback});
      } else {
        Promise.resolve().then(callback);
      }
      return 0;
    },
    // Left undefined unless a test supplies a fake: the app must degrade to
    // uncached reads in a browser without usable IndexedDB.
    indexedDB: options.indexedDB,
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
      if (requestOptions && requestOptions.signal && requestOptions.signal.aborted) {
        const abortError = new Error("the operation was aborted");
        abortError.name = "AbortError";
        throw abortError;
      }
      requests.push({url: url, options: requestOptions, at: clock ? clock.now : null});
      if (url === "/api/config") {
        return jsonResponse(200, {spotify_client_id: "test-client-id"});
      }
      if (url === "/api/telemetry") {
        if (options.telemetryFailure) {
          throw new Error("telemetry intake unavailable");
        }
        telemetryReports.push(JSON.parse(requestOptions.body));
        return jsonResponse(options.telemetryStatus || 204, null);
      }
      if (url === tokenEndpoint && options.tokenHandler) {
        return options.tokenHandler(requestOptions);
      }
      if (url.startsWith(playlistsEndpoint + "?")) {
        return (options.playlistHandler || (() => playlistPage([])))(url, requestOptions);
      }
      if (url.startsWith("https://api.spotify.com/v1/me/tracks") && options.likedHandler) {
        return options.likedHandler(url, requestOptions);
      }
      if (url === playlistsEndpoint && options.createPlaylistHandler) {
        return options.createPlaylistHandler(url, requestOptions);
      }
      if (url.startsWith("https://api.spotify.com/v1/playlists/") && options.trackHandler) {
        return options.trackHandler(url, requestOptions);
      }
      throw new Error("unexpected fetch: " + url);
    }
  };
  const document = {
    documentElement: {dataset: {}},
    getElementById(id) {
      return elements[id];
    },
    createElement(_tagName) {
      return new FakeElement(false);
    }
  };
  const contextGlobals = {
    AbortController: AbortController,
    Buffer: Buffer,
    TextEncoder: TextEncoder,
    URL: URL,
    URLSearchParams: URLSearchParams,
    Uint8Array: Uint8Array,
    document: document,
    window: window
  };
  if (clock) {
    // Shadow the realm Date so app time follows the manual clock; the
    // subclass keeps `new Date(value)` working for message formatting.
    contextGlobals.Date = class extends Date {
      static now() {
        return clock.now;
      }
    };
  }
  const context = vm.createContext(contextGlobals);

  // Match the served page: pure.js defines the TrueShuffle global app.js reads.
  vm.runInContext(pureSource, context, {filename: "web/pure.js"});
  vm.runInContext(appSource, context, {filename: "web/app.js"});
  return {
    backgroundSelect: backgroundSelect,
    cancelButton: cancelButton,
    connectButton: connectButton,
    historyPaths: historyPaths,
    localStorage: localStorage,
    location: location,
    logoutButton: logoutButton,
    playlistStatusElement: playlistStatusElement,
    playlistsElement: playlistsElement,
    requests: requests,
    sessionStorage: sessionStorage,
    statusElement: statusElement,
    openTargetLink: openTargetLink,
    telemetryReports: telemetryReports,
    trackProgressElement: trackProgressElement,
    trackStatusElement: trackStatusElement,
    waitStatusElement: waitStatusElement,
    documentElement: document.documentElement
  };
}

function playlistButtons(harness) {
  return harness.playlistsElement.children.map((item) => item.children[0]);
}

// A manually advanced clock for pacing and cooldown cases: timers queue
// against it and fire only when time moves. run() alternates settling
// microtasks with firing due timers until neither produces work; drain()
// keeps jumping to the next timer until none remain.
function manualClock(startAt) {
  const clock = {
    now: startAt || 1770000000000,
    timers: [],
    async run() {
      for (;;) {
        await settle(4);
        const due = clock.timers.filter((timer) => timer.at <= clock.now);
        if (due.length === 0) {
          return;
        }
        clock.timers = clock.timers.filter((timer) => timer.at > clock.now);
        due.sort((a, b) => a.at - b.at).forEach((timer) => timer.callback());
      }
    },
    async advance(milliseconds) {
      clock.now += milliseconds;
      await clock.run();
    },
    async drain() {
      for (;;) {
        await clock.run();
        if (clock.timers.length === 0) {
          return;
        }
        clock.now = Math.min(...clock.timers.map((timer) => timer.at));
      }
    }
  };
  return clock;
}

async function settle(rounds) {
  for (let index = 0; index < (rounds || 12); index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// Authorization flows await a real subtle-crypto digest whose timing varies
// under load; wait on the observable outcome instead of a fixed round count.
async function settleUntil(condition) {
  for (let index = 0; index < 400; index += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a stored background preference is restored", async () => {
  const localStorage = new FakeStorage({[backgroundStorageKey]: "veil"});
  const harness = createHarness({localStorage: localStorage});

  await settle();

  assert.equal(harness.backgroundSelect.value, "veil");
  assert.equal(harness.documentElement.dataset.background, "veil");
});

test("an invalid background preference falls back to the ribbon default", async () => {
  const localStorage = new FakeStorage({[backgroundStorageKey]: "unknown"});
  const harness = createHarness({localStorage: localStorage});

  await settle();

  assert.equal(harness.backgroundSelect.value, "ribbon");
  assert.equal("background" in harness.documentElement.dataset, false);
  assert.equal(localStorage.getItem(backgroundStorageKey), null);
});

test("background changes apply immediately and persist when storage works", async () => {
  const localStorage = new FakeStorage();
  const harness = createHarness({localStorage: localStorage});
  await settle();

  harness.backgroundSelect.value = "orbit";
  harness.backgroundSelect.change();
  assert.equal(harness.documentElement.dataset.background, "orbit");
  assert.equal(localStorage.getItem(backgroundStorageKey), "orbit");

  harness.backgroundSelect.value = "ribbon";
  harness.backgroundSelect.change();
  assert.equal("background" in harness.documentElement.dataset, false);
  assert.equal(localStorage.getItem(backgroundStorageKey), null);
});

test("background changes remain page-local when storage is unavailable", async () => {
  const localStorage = new FakeStorage({}, {get: true, set: true});
  const harness = createHarness({localStorage: localStorage});
  await settle();

  harness.backgroundSelect.value = "tide";
  harness.backgroundSelect.change();

  assert.equal(harness.backgroundSelect.value, "tide");
  assert.equal(harness.documentElement.dataset.background, "tide");
});

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
    assert.equal(
      harness.statusElement.textContent,
      "Spotify could not be reached. Reload to try again, or disconnect this browser and connect again."
    );
    assert.equal(harness.connectButton.hidden, true);
    assert.equal(harness.logoutButton.hidden, false,
      "the kept-token failure state must offer the disconnect escape");
    assert.equal(harness.logoutButton.disabled, false);
  });
}

test("the refresh-failure disconnect escape recovers to the connect screen", async () => {
  const rawToken = JSON.stringify(expiredToken());
  const localStorage = new FakeStorage({[tokenStorageKey]: rawToken});
  const harness = createHarness({
    localStorage: localStorage,
    tokenHandler: () => jsonResponse(500, {error: "server_error"})
  });

  await settle();
  assert.equal(localStorage.getItem(tokenStorageKey), rawToken,
    "nothing is cleared until the user taps the button");

  harness.logoutButton.click();
  await settle();

  assert.equal(localStorage.getItem(tokenStorageKey), null, "the stale token is gone");
  assert.equal(harness.statusElement.textContent, "Spotify was disconnected from this browser.");
  assert.equal(harness.connectButton.hidden, false);
  assert.equal(harness.connectButton.disabled, false);
  assert.equal(harness.logoutButton.hidden, true);
});

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
          {id: "first", name: "Morning", items: {total: 1}},
          null,
          {id: "second", name: "Evening", items: {total: 4212}}
        ], secondPage);
      }
      assert.equal(url, secondPage);
      return playlistPage([{id: "third", name: "Late", items: {total: 0}}]);
    }
  });

  await settle();

  assert.deepEqual(
    playlistButtons(harness).map((button) => button.textContent),
    [
      "Liked Songs (reconnect Spotify to enable)",
      "Morning (1 track)",
      "Evening (4212 tracks)",
      "Late (0 tracks)"
    ],
    "Liked Songs leads the list; the scope-less token labels it as the reconnect"
  );
  assert.equal(harness.playlistsElement.hidden, false);
  assert.equal(harness.playlistStatusElement.textContent, "Select a playlist to shuffle it.");
  assert.equal(harness.statusElement.textContent, "Spotify is connected in this browser.");

  const playlistRequests = harness.requests.filter((request) => request.url.startsWith(playlistsEndpoint));
  assert.equal(playlistRequests.length, 2);
  assert.equal(playlistRequests[0].options.headers.Authorization, "Bearer current-access-token");
});

test("an account without playlists still lists the Liked Songs row", async () => {
  const harness = createHarness({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    playlistHandler: () => playlistPage([])
  });

  await settle();

  assert.deepEqual(
    playlistButtons(harness).map((button) => button.textContent),
    ["Liked Songs"]
  );
  assert.equal(harness.playlistsElement.hidden, false);
  assert.equal(harness.playlistStatusElement.textContent, "Select a playlist to shuffle it.");
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
      [{id: "first", name: "Morning", items: {total: 1}}],
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

// Selection now runs the whole chain: read, shuffle, and write to the
// derived target; the click lands on index 1 because Liked Songs leads.
test("selecting a playlist marks it and moves the mark on reselection", async () => {
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    playlistHandler: () => playlistPage([
      {id: "first", name: "Morning", items: {total: 1}},
      {id: "second", name: "Evening", items: {total: 1}}
    ])
  }, backendOptions(backend, (url, requestOptions) => {
    const playlistId = url.includes("/playlists/first") ? "first" : "second";
    return steadyTrackHandler(playlistId, "snap-" + playlistId, 50, ["spotify:track:" + playlistId])(url);
  })));

  await settle();
  const buttons = playlistButtons(harness);

  buttons[1].click();
  await settle();
  assert.equal(buttons[1].getAttribute("aria-pressed"), "true");
  assert.equal(harness.playlistStatusElement.textContent, "Selected Morning.");
  assert.match(harness.trackStatusElement.textContent, /^Created "Morning TrueShuffle" /);

  buttons[2].click();
  await settle();
  assert.equal(buttons[1].getAttribute("aria-pressed"), "false");
  assert.equal(buttons[2].getAttribute("aria-pressed"), "true");
  assert.equal(harness.playlistStatusElement.textContent, "Selected Evening.");
  assert.match(harness.trackStatusElement.textContent, /^Created "Evening TrueShuffle" /);
  assert.deepEqual(
    backend.createBodies.map((body) => body.name),
    ["Morning TrueShuffle", "Evening TrueShuffle"],
    "each source shuffles into its own derived target"
  );
});

test("disconnecting clears a rendered playlist list and track state", async () => {
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    playlistHandler: () => playlistPage([{id: "first", name: "Morning", items: {total: 1}}])
  }, backendOptions(backend, steadyTrackHandler("first", "snap-1", 50, ["spotify:track:a"]))));

  await settle();
  assert.equal(playlistButtons(harness).length, 2);
  playlistButtons(harness)[1].click();
  await settle();
  assert.match(harness.trackStatusElement.textContent, /^Created "Morning TrueShuffle" /);

  harness.logoutButton.click();

  assert.deepEqual(harness.playlistsElement.children, []);
  assert.equal(harness.playlistsElement.hidden, true);
  assert.equal(harness.playlistStatusElement.hidden, true);
  assert.equal(harness.trackStatusElement.hidden, true);
  assert.equal(harness.trackStatusElement.textContent, "");
  assert.equal(harness.statusElement.textContent, "Spotify was disconnected from this browser.");
});

test("a playlist chain reads every page and writes batched to its target", async () => {
  const uris = [];
  for (let index = 0; index < 250; index += 1) {
    uris.push("spotify:track:" + index);
  }
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    playlistHandler: () => playlistPage([{id: "big", name: "Big", items: {total: 250}}])
  }, backendOptions(backend, steadyTrackHandler("big", "snap-1", 50, uris))));

  await settle();
  playlistButtons(harness)[1].click();
  await settle();

  const sourceReads = harness.requests.filter(
    (request) => request.url.includes("/v1/playlists/big")
  );
  assert.deepEqual(sourceReads.map((request) => request.url), [
    snapshotURL("big"),
    trackURL("big", 0),
    trackURL("big", 50),
    trackURL("big", 100),
    trackURL("big", 150),
    trackURL("big", 200),
    snapshotURL("big")
  ]);
  assert.equal(sourceReads[0].options.headers.Authorization, "Bearer current-access-token");
  assert.deepEqual(backend.writes.map((write) => write.uris.length), [100, 100, 50]);
  assert.deepEqual(
    backend.writes.map((write) => write.uris).flat().slice().sort(),
    uris.slice().sort()
  );
  assert.match(
    harness.trackStatusElement.textContent,
    /^Created "Big TrueShuffle" with 250 tracks in \d+\.\ds\.$/
  );
  assert.equal(harness.trackProgressElement.hidden, true, "the bar hides once the chain settles");
  assert.equal(playlistButtons(harness)[1].disabled, false);
});

test("track pages read sequentially in offset order with paced starts", async () => {
  const uris = [];
  for (let index = 0; index < 4; index += 1) {
    uris.push("spotify:track:" + index);
  }
  const clock = manualClock();
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    clock: clock,
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    playlistHandler: () => playlistPage([{id: "big", name: "Big", items: {total: 4}}])
  }, backendOptions(backend, (url) => {
    if (url === snapshotURL("big")) {
      return snapshotPage("snap-1");
    }
    const offset = Number(new URL(url).searchParams.get("offset"));
    // The echoed limit of 1 is what the remaining offsets step by, so
    // documentation assumptions about the page size cannot matter.
    return playlistItemPageResponse(1, 4, [uris[offset]]);
  })));

  await clock.drain();
  playlistButtons(harness)[1].click();
  await clock.drain();

  assert.match(harness.trackStatusElement.textContent, /^Created "Big TrueShuffle" with 4 tracks in \d+\.\ds\.$/);
  const spotify = harness.requests.filter(
    (request) => request.url.startsWith("https://api.spotify.com/")
  );
  const pageOffsets = spotify
    .filter((request) => request.url.includes("/items?"))
    .map((request) => Number(new URL(request.url).searchParams.get("offset")));
  assert.deepEqual(pageOffsets, [0, 1, 2, 3], "pages dispatch in offset order");
  for (let index = 1; index < spotify.length; index += 1) {
    assert.ok(spotify[index].at - spotify[index - 1].at >= 250,
      "starts are at least the paced gap apart, including across phases");
  }
  const shuffle = harness.telemetryReports.find((report) => report.kind === "playlist-shuffle");
  assert.equal(shuffle.policy, "serial-250ms-v1");
  assert.equal(shuffle.policy_min_gap_ms, 250);
  assert.equal(shuffle.policy_retry_ceiling, 1);
  assert.ok(shuffle.events.slice(1).every((event) => event.scheduled_wait_ms >= 250 - 1),
    "every request after the first records its paced wait");
});
test("a snapshot change during the read fails it and disturbs nothing else", async () => {
  let snapshotCalls = 0;
  const rawToken = JSON.stringify(currentToken());
  const localStorage = new FakeStorage({[tokenStorageKey]: rawToken});
  const harness = createHarness({
    localStorage: localStorage,
    playlistHandler: () => playlistPage([{id: "torn", name: "Morning", items: {total: 1}}]),
    trackHandler: (url) => {
      if (url === snapshotURL("torn")) {
        snapshotCalls += 1;
        return snapshotPage(snapshotCalls === 1 ? "snap-1" : "snap-2");
      }
      return playlistItemPageResponse(50, 1, ["spotify:track:a"]);
    }
  });

  await settle();
  playlistButtons(harness)[1].click();
  await settle();

  assert.equal(
    harness.trackStatusElement.textContent,
    "This playlist changed while loading. Select it again."
  );
  assert.equal(localStorage.getItem(tokenStorageKey), rawToken);
  assert.equal(harness.playlistsElement.hidden, false);
  assert.equal(harness.statusElement.textContent, "Spotify is connected in this browser.");
  assert.equal(harness.playlistStatusElement.textContent, "Selected Morning.");
  assert.equal(playlistButtons(harness)[1].disabled, false);
  // max === 1 proves the bar appeared during the read; hidden proves the
  // failed settle removed it.
  assert.equal(harness.trackProgressElement.max, 1);
  assert.equal(harness.trackProgressElement.hidden, true);
});

test("a track count short of the total fails the read", async () => {
  const harness = createHarness({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(currentToken())}),
    playlistHandler: () => playlistPage([{id: "short", name: "Morning", items: {total: 3}}]),
    trackHandler: (url) => url === snapshotURL("short")
      ? snapshotPage("snap-1")
      : playlistItemPageResponse(50, 3, ["spotify:track:a", "spotify:track:b"])
  });

  await settle();
  playlistButtons(harness)[1].click();
  await settle();

  assert.equal(
    harness.trackStatusElement.textContent,
    "This playlist changed while loading. Select it again."
  );
});

test("a failed track read leaves the listing and token intact", async () => {
  const rawToken = JSON.stringify(currentToken());
  const localStorage = new FakeStorage({[tokenStorageKey]: rawToken});
  const harness = createHarness({
    localStorage: localStorage,
    playlistHandler: () => playlistPage([{id: "down", name: "Morning", items: {total: 1}}]),
    trackHandler: () => jsonResponse(500, {error: {status: 500}})
  });

  await settle();
  playlistButtons(harness)[1].click();
  await settle();

  assert.equal(
    harness.trackStatusElement.textContent,
    "Tracks could not be loaded (Spotify returned 500 at /v1/playlists/down). Select the playlist again to retry."
  );
  assert.equal(localStorage.getItem(tokenStorageKey), rawToken);
  assert.equal(harness.playlistsElement.hidden, false);
  assert.equal(harness.statusElement.textContent, "Spotify is connected in this browser.");
  assert.equal(playlistButtons(harness)[1].disabled, false);
});

// Objects built inside the vm realm carry that realm's prototypes, which
// strict deep equality rejects; compare plain content instead.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("re-selecting an unchanged playlist reaches the write with zero track requests", async () => {
  const indexedDB = new FakeIndexedDB();
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    indexedDB: indexedDB,
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    playlistHandler: () => playlistPage([
      {id: "steady", name: "Morning", items: {total: 2}, snapshot_id: "snap-1"}
    ])
  }, backendOptions(backend, steadyTrackHandler("steady", "snap-1", 50, ["spotify:track:a", "spotify:track:b"]))));

  await settle();
  playlistButtons(harness)[1].click();
  await settle();

  assert.match(
    harness.trackStatusElement.textContent,
    /^Created "Morning TrueShuffle" with 2 tracks in \d+\.\ds\.$/
  );
  const stored = indexedDB.record("trueshuffle", "playlists", "steady");
  assert.equal(stored.snapshot_id, "snap-1");
  assert.deepEqual(plain(stored.uris), ["spotify:track:a", "spotify:track:b"]);
  assert.equal(typeof stored.cached_at, "number");

  const sourceReads = harness.requests.filter(
    (request) => request.url.includes("/v1/playlists/steady")
  ).length;
  playlistButtons(harness)[1].click();
  await settle();

  assert.equal(
    harness.requests.filter((request) => request.url.includes("/v1/playlists/steady")).length,
    sourceReads,
    "a cache hit issues zero source track requests"
  );
  assert.deepEqual(backend.writes.map((write) => write.method), ["POST", "PUT"],
    "the cache hit still reaches the write, overwriting the same target");
  assert.match(
    harness.trackStatusElement.textContent,
    /^Updated "Morning TrueShuffle" with 2 tracks in \d+\.\ds\.$/
  );
});


test("a snapshot mismatch re-reads, stores, and reports added and removed counts", async () => {
  const indexedDB = new FakeIndexedDB({
    seed: {
      trueshuffle: {
        playlists: {
          changed: {
            snapshot_id: "snap-old",
            uris: ["spotify:track:a", "spotify:track:b", "spotify:track:b"],
            cached_at: 1
          }
        }
      }
    }
  });
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    indexedDB: indexedDB,
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    playlistHandler: () => playlistPage([
      {id: "changed", name: "Morning", items: {total: 3}, snapshot_id: "snap-new"}
    ])
  }, backendOptions(backend, steadyTrackHandler("changed", "snap-new", 50,
    ["spotify:track:b", "spotify:track:c", "spotify:track:c"]))));

  await settle();
  playlistButtons(harness)[1].click();
  await settle();

  assert.match(
    harness.trackStatusElement.textContent,
    /^Created "Morning TrueShuffle" with 3 tracks in \d+\.\ds\. 2 added, 2 removed since last read\.$/,
    "the write result keeps the membership difference visible"
  );
  const stored = indexedDB.record("trueshuffle", "playlists", "changed");
  assert.equal(stored.snapshot_id, "snap-new");
  assert.deepEqual(plain(stored.uris), ["spotify:track:b", "spotify:track:c", "spotify:track:c"]);
});

test("a membership-identical change renders the plain count", async () => {
  const indexedDB = new FakeIndexedDB({
    seed: {
      trueshuffle: {
        playlists: {
          reordered: {
            snapshot_id: "snap-old",
            uris: ["spotify:track:a", "spotify:track:b"],
            cached_at: 1
          }
        }
      }
    }
  });
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    indexedDB: indexedDB,
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    playlistHandler: () => playlistPage([
      {id: "reordered", name: "Morning", items: {total: 2}, snapshot_id: "snap-new"}
    ])
  }, backendOptions(backend, steadyTrackHandler("reordered", "snap-new", 50,
    ["spotify:track:b", "spotify:track:a"]))));

  await settle();
  playlistButtons(harness)[1].click();
  await settle();

  assert.match(
    harness.trackStatusElement.textContent,
    /^Created "Morning TrueShuffle" with 2 tracks in \d+\.\ds\.$/,
    "a membership-identical change renders no added/removed suffix"
  );
});

test("an unavailable cache degrades to an uncached read", async () => {
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    indexedDB: new FakeIndexedDB({unavailable: true}),
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    playlistHandler: () => playlistPage([
      {id: "nocache", name: "Morning", items: {total: 1}, snapshot_id: "snap-1"}
    ])
  }, backendOptions(backend, steadyTrackHandler("nocache", "snap-1", 50, ["spotify:track:a"]))));

  await settle();
  playlistButtons(harness)[1].click();
  await settle();

  assert.match(
    harness.trackStatusElement.textContent,
    /^Created "Morning TrueShuffle" with 1 track in \d+\.\ds\.$/
  );
  assert.equal(playlistButtons(harness)[1].disabled, false);
});

test("a failed re-read preserves the previous cache record", async () => {
  const indexedDB = new FakeIndexedDB({
    seed: {
      trueshuffle: {
        playlists: {
          kept: {snapshot_id: "snap-old", uris: ["spotify:track:a"], cached_at: 1}
        }
      }
    }
  });
  const harness = createHarness({
    indexedDB: indexedDB,
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(currentToken())}),
    playlistHandler: () => playlistPage([
      {id: "kept", name: "Morning", items: {total: 1}, snapshot_id: "snap-new"}
    ]),
    trackHandler: () => jsonResponse(500, {error: {status: 500}})
  });

  await settle();
  playlistButtons(harness)[1].click();
  await settle();

  assert.equal(
    harness.trackStatusElement.textContent,
    "Tracks could not be loaded (Spotify returned 500 at /v1/playlists/kept). Select the playlist again to retry."
  );
  assert.deepEqual(plain(indexedDB.record("trueshuffle", "playlists", "kept")), {
    snapshot_id: "snap-old",
    uris: ["spotify:track:a"],
    cached_at: 1
  });
});

test("disconnecting deletes the track cache database", async () => {
  const indexedDB = new FakeIndexedDB({
    seed: {
      trueshuffle: {
        playlists: {
          gone: {snapshot_id: "snap-1", uris: ["spotify:track:a"], cached_at: 1}
        }
      }
    }
  });
  const harness = createHarness({
    indexedDB: indexedDB,
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(currentToken())}),
    playlistHandler: () => playlistPage([
      {id: "gone", name: "Morning", items: {total: 1}, snapshot_id: "snap-1"}
    ])
  });

  await settle();
  harness.logoutButton.click();

  assert.deepEqual(indexedDB.deletedDatabases, ["trueshuffle"]);
  assert.equal(indexedDB.databases.has("trueshuffle"), false);
});

test("disconnecting during a track read renders nothing afterward", async () => {
  const entry = deferred();
  const harness = createHarness({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(currentToken())}),
    playlistHandler: () => playlistPage([{id: "slow", name: "Morning", items: {total: 1}}]),
    trackHandler: (url) => url === snapshotURL("slow") ? snapshotPage("snap-1") : entry.promise
  });

  await settle();
  playlistButtons(harness)[1].click();
  await settle();
  assert.equal(harness.trackStatusElement.textContent, "Loading tracks...");

  harness.logoutButton.click();
  entry.resolve(playlistItemPageResponse(50, 1, ["spotify:track:a"]));
  await settle();

  assert.equal(harness.trackStatusElement.hidden, true);
  assert.equal(harness.trackStatusElement.textContent, "");
});

test("connect recovers from a partial pending authorization write", async () => {
  const sessionStorage = new FakeStorage({}, {setAt: 2});
  const harness = createHarness({sessionStorage: sessionStorage});
  await settle();
  assert.equal(harness.connectButton.hidden, false);

  harness.connectButton.click();
  await settleUntil(() => harness.statusElement.textContent === "Spotify authorization could not be started.");

  assert.equal(harness.location.assigned, null);
  assert.equal(sessionStorage.getItem(stateStorageKey), null);
  assert.equal(sessionStorage.getItem(verifierStorageKey), null);
  assert.equal(harness.statusElement.textContent, "Spotify authorization could not be started.");
  assert.equal(harness.connectButton.hidden, false);
  assert.equal(harness.connectButton.disabled, false);
});

test("a token without the library scope shows the reconnect row", async () => {
  const harness = createHarness({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(currentToken())}),
    playlistHandler: () => playlistPage([{id: "first", name: "Morning", items: {total: 1}}])
  });

  await settle();
  const buttons = playlistButtons(harness);
  assert.equal(buttons[0].textContent, "Liked Songs (reconnect Spotify to enable)");
  assert.equal(buttons[1].textContent, "Morning (1 track)");

  buttons[0].click();
  await settleUntil(() => harness.location.assigned !== null);

  assert.ok(harness.location.assigned, "the liked row starts the authorization flow");
  assert.ok(
    harness.location.assigned.includes("user-library-read"),
    "the authorize URL requests the library scope"
  );
});

test("one click on Liked Songs loads, shuffles, and writes the derived target", async () => {
  const uris = [];
  for (let index = 0; index < 120; index += 1) {
    uris.push("spotify:track:liked" + index);
  }
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    likedHandler: steadyLikedHandler(50, uris)
  }, backendOptions(backend)));

  await settle();
  const buttons = playlistButtons(harness);
  assert.equal(buttons[0].textContent, "Liked Songs");

  buttons[0].click();
  await settle();

  const likedRequests = harness.requests
    .filter((request) => request.url.startsWith("https://api.spotify.com/v1/me/tracks"))
    .map((request) => request.url);
  assert.deepEqual(likedRequests, [likedURL(0), likedURL(50), likedURL(100), likedURL(0)],
    "page 0, the pooled offsets, then the verification probe");
  assert.equal(backend.createBodies.length, 1);
  assert.equal(backend.createBodies[0].name, "Liked Songs TrueShuffle");
  assert.equal(backend.createBodies[0].public, false);
  assert.deepEqual(backend.writes.map((write) => write.method), ["POST", "POST"],
    "a freshly created target only appends");
  assert.deepEqual(backend.writes.map((write) => write.uris.length), [100, 20]);
  const written = backend.writes.map((write) => write.uris).flat();
  assert.deepEqual(written.slice().sort(), uris.slice().sort(),
    "the target holds exactly the liked tracks, reordered");
  assert.match(
    harness.trackStatusElement.textContent,
    /^Created "Liked Songs TrueShuffle" with 120 tracks in \d+\.\ds\.$/
  );
  assert.equal(harness.trackProgressElement.hidden, true);
  assert.equal(buttons[0].disabled, false);
});

test("an existing derived target is overwritten and hidden from the list", async () => {
  const uris = ["spotify:track:a", "spotify:track:b", "spotify:track:c"];
  const backend = makeWriteBackend();
  backend.targets.push({
    id: "target-9",
    name: "Liked Songs TrueShuffle",
    contents: ["spotify:track:stale"]
  });
  const harness = createHarness(Object.assign({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    playlistHandler: () => playlistPage([
      {id: "target-9", name: "Liked Songs TrueShuffle", items: {total: 1}, snapshot_id: "snap-t"},
      {id: "first", name: "Morning", items: {total: 1}, snapshot_id: "snap-1"}
    ]),
    likedHandler: steadyLikedHandler(50, uris)
  }, backendOptions(backend)));

  await settle();
  const buttons = playlistButtons(harness);
  assert.deepEqual(
    buttons.map((button) => button.textContent),
    ["Liked Songs", "Morning (1 track)"],
    "the derived playlist is hidden from the rendered list"
  );

  buttons[0].click();
  await settle();

  assert.equal(backend.createBodies.length, 0, "no playlist is created when the target exists");
  assert.equal(
    harness.requests.every((request) => request.url !== "https://api.spotify.com/v1/me"),
    true,
    "an overwrite needs no profile read"
  );
  assert.deepEqual(backend.writesFor("target-9").map((write) => write.method), ["PUT"],
    "the first batch replaces the contents");
  assert.deepEqual(
    backend.find("target-9").contents.slice().sort(),
    uris.slice().sort(),
    "the stale contents are fully replaced"
  );
  assert.match(
    harness.trackStatusElement.textContent,
    /^Updated "Liked Songs TrueShuffle" with 3 tracks in \d+\.\ds\.$/
  );
});

test("a second shuffle in the same page load overwrites the created target", async () => {
  const uris = ["spotify:track:a", "spotify:track:b", "spotify:track:c"];
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    likedHandler: steadyLikedHandler(50, uris)
  }, backendOptions(backend)));

  await settle();
  playlistButtons(harness)[0].click();
  await settle();
  assert.match(harness.trackStatusElement.textContent, /^Created /);

  playlistButtons(harness)[0].click();
  await settle();

  assert.equal(backend.createBodies.length, 1, "the second shuffle creates nothing");
  assert.deepEqual(backend.writes.map((write) => write.method), ["POST", "PUT"],
    "the second shuffle replaces the target created moments earlier");
  assert.match(
    harness.trackStatusElement.textContent,
    /^Updated "Liked Songs TrueShuffle" with 3 tracks in \d+\.\ds\.$/
  );
});

test("a mid-write failure names the possibly partial target", async () => {
  const uris = [];
  for (let index = 0; index < 150; index += 1) {
    uris.push("spotify:track:" + index);
  }
  const backend = makeWriteBackend();
  const options = Object.assign({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    likedHandler: steadyLikedHandler(50, uris)
  }, backendOptions(backend));
  const workingTrackHandler = options.trackHandler;
  options.trackHandler = (url, requestOptions) => {
    if (url === "https://api.spotify.com/v1/playlists/target-1/items" &&
        backend.writes.length === 1) {
      return jsonResponse(500, {error: {status: 500, message: "Server error"}});
    }
    return workingTrackHandler(url, requestOptions);
  };
  const harness = createHarness(options);

  await settle();
  playlistButtons(harness)[0].click();
  await settle();

  assert.match(
    harness.trackStatusElement.textContent,
    /^"Liked Songs TrueShuffle" may be incomplete \(Spotify returned 500 at \/v1\/playlists\/target-1\/items: Server error\)\. Shuffle again to rewrite it\.$/
  );
  assert.equal(harness.trackProgressElement.hidden, true);
});

test("a verification shortfall never claims success", async () => {
  const backend = makeWriteBackend();
  const options = Object.assign({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    likedHandler: steadyLikedHandler(50, ["spotify:track:a", "spotify:track:b"])
  }, backendOptions(backend));
  const workingTrackHandler = options.trackHandler;
  options.trackHandler = (url, requestOptions) => {
    if (url === "https://api.spotify.com/v1/playlists/target-1?fields=items.total") {
      return jsonResponse(200, {items: {total: 1}});
    }
    return workingTrackHandler(url, requestOptions);
  };
  const harness = createHarness(options);

  await settle();
  playlistButtons(harness)[0].click();
  await settle();

  assert.match(harness.trackStatusElement.textContent, /may be incomplete/);
});

test("a library above the playlist cap writes nothing", async () => {
  const uris = [];
  for (let index = 0; index < 10001; index += 1) {
    uris.push("spotify:track:" + index);
  }
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    likedHandler: steadyLikedHandler(50, uris)
  }, backendOptions(backend)));

  await settle();
  playlistButtons(harness)[0].click();
  await settle();

  assert.equal(
    harness.trackStatusElement.textContent,
    "\"Liked Songs\" holds more than 10,000 tracks, the most a playlist can contain."
  );
  assert.equal(backend.createBodies.length, 0);
  assert.equal(backend.writes.length, 0);
});

test("a source with no tracks reports that and writes nothing", async () => {
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    playlistHandler: () => playlistPage([{id: "empty", name: "Empty", items: {total: 0}}]),
    likedHandler: steadyLikedHandler(50, [])
  }, backendOptions(backend, steadyTrackHandler("empty", "snap-1", 50, []))));

  await settle();
  const buttons = playlistButtons(harness);

  buttons[0].click();
  await settle();
  assert.equal(harness.trackStatusElement.textContent, "\"Liked Songs\" has no tracks to shuffle.");

  buttons[1].click();
  await settle();
  assert.equal(harness.trackStatusElement.textContent, "\"Empty\" has no tracks to shuffle.");

  assert.equal(backend.createBodies.length, 0);
  assert.equal(backend.writes.length, 0);
});

test("a token without the write scope stops before any write", async () => {
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    localStorage: new FakeStorage({
      [tokenStorageKey]: JSON.stringify(Object.assign(currentToken(), {
        scope: "playlist-read-private user-library-read"
      }))
    },),
    likedHandler: steadyLikedHandler(50, ["spotify:track:a"])
  }, backendOptions(backend)));

  await settle();
  playlistButtons(harness)[0].click();
  await settle();

  assert.equal(
    harness.trackStatusElement.textContent,
    "Disconnect this browser and reconnect Spotify to allow creating playlists."
  );
  assert.equal(backend.createBodies.length, 0);
  assert.equal(
    harness.requests.every((request) => request.url !== "https://api.spotify.com/v1/me"),
    true,
    "no write-path request is issued without the scope"
  );
});

test("a chain in flight disables every row", async () => {
  const entry = deferred();
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    playlistHandler: () => playlistPage([{id: "first", name: "Morning", items: {total: 1}}]),
    likedHandler: () => entry.promise
  }, backendOptions(backend)));

  await settle();
  const buttons = playlistButtons(harness);
  buttons[0].click();
  await settle();

  assert.equal(buttons[0].disabled, true);
  assert.equal(buttons[1].disabled, true);

  entry.resolve(savedTrackPageResponse(50, 1, ["spotify:track:a"]));
  await settle();

  assert.equal(buttons[0].disabled, false);
  assert.equal(buttons[1].disabled, false);
  assert.match(harness.trackStatusElement.textContent, /^Created "Liked Songs TrueShuffle" /);
});

test("duplicate-named rows dedupe with a note; unique listings render none", async () => {
  const harness = createHarness({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    playlistHandler: () => playlistPage([
      {id: "a", name: "Morning", items: {total: 1}},
      {id: "b", name: "Liked Songs", items: {total: 2}},
      {id: "c", name: "Morning", items: {total: 3}}
    ])
  });

  await settle();

  assert.deepEqual(
    playlistButtons(harness).map((button) => button.textContent),
    ["Liked Songs", "Morning (1 track)"],
    "no two rows share a name; the liked row is the first \"Liked Songs\""
  );
  assert.equal(
    harness.playlistStatusElement.textContent,
    "Select a playlist to shuffle it. " +
      "2 playlists with duplicate names are hidden; rename them in Spotify to shuffle them."
  );
});

function likedRecordSeed(record) {
  return {seed: {trueshuffle: {playlists: {"liked-songs": record}}}};
}

test("a liked fingerprint match shuffles from cache with one library request", async () => {
  const uris = [];
  for (let index = 0; index < 120; index += 1) {
    uris.push("spotify:track:liked" + index);
  }
  const indexedDB = new FakeIndexedDB(likedRecordSeed({
    total: 120,
    head: uris.slice(0, 50),
    uris: uris,
    cached_at: 1
  }));
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    indexedDB: indexedDB,
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    likedHandler: steadyLikedHandler(50, uris)
  }, backendOptions(backend)));

  await settle();
  playlistButtons(harness)[0].click();
  await settle();

  const likedRequests = harness.requests
    .filter((request) => request.url.startsWith("https://api.spotify.com/v1/me/tracks"))
    .map((request) => request.url);
  assert.deepEqual(likedRequests, [likedURL(0)],
    "a fingerprint match needs only the page-0 fetch");
  const written = backend.writes.map((write) => write.uris).flat();
  assert.deepEqual(written.slice().sort(), uris.slice().sort(),
    "the cached URIs reach the write");
  assert.match(
    harness.trackStatusElement.textContent,
    /^Created "Liked Songs TrueShuffle" with 120 tracks in \d+\.\ds\.$/
  );
});

test("a count-neutral library change re-reads and reports the difference", async () => {
  const indexedDB = new FakeIndexedDB(likedRecordSeed({
    total: 2,
    head: ["spotify:track:a", "spotify:track:b"],
    uris: ["spotify:track:a", "spotify:track:b"],
    cached_at: 1
  }));
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    indexedDB: indexedDB,
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    likedHandler: steadyLikedHandler(50, ["spotify:track:c", "spotify:track:b"])
  }, backendOptions(backend)));

  await settle();
  playlistButtons(harness)[0].click();
  await settle();

  assert.match(
    harness.trackStatusElement.textContent,
    /^Created "Liked Songs TrueShuffle" with 2 tracks in \d+\.\ds\. 1 added, 1 removed since last read\.$/,
    "the swap that held the count still is detected and reported"
  );
  const stored = indexedDB.record("trueshuffle", "playlists", "liked-songs");
  assert.equal(stored.total, 2);
  assert.deepEqual(plain(stored.head), ["spotify:track:c", "spotify:track:b"]);
  assert.deepEqual(plain(stored.uris), ["spotify:track:c", "spotify:track:b"]);
  assert.equal(typeof stored.cached_at, "number");
});

test("a verified liked read stores a record the next click hits", async () => {
  const indexedDB = new FakeIndexedDB();
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    indexedDB: indexedDB,
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    likedHandler: steadyLikedHandler(50, ["spotify:track:a", "spotify:track:b"])
  }, backendOptions(backend)));

  await settle();
  playlistButtons(harness)[0].click();
  await settle();
  assert.match(harness.trackStatusElement.textContent, /^Created /);
  const coldRequests = harness.requests
    .filter((request) => request.url.startsWith("https://api.spotify.com/v1/me/tracks")).length;
  assert.equal(coldRequests, 2, "page 0 and the verification probe");

  playlistButtons(harness)[0].click();
  await settle();

  assert.equal(
    harness.requests.filter(
      (request) => request.url.startsWith("https://api.spotify.com/v1/me/tracks")
    ).length,
    coldRequests + 1,
    "the second click hits the stored record after one page-0 fetch"
  );
  assert.match(harness.trackStatusElement.textContent, /^Updated /);
});

test("a mid-read head drift with a steady total fails the read", async () => {
  let pageZeroCalls = 0;
  const harness = createHarness({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    likedHandler: (url) => {
      if (url === likedURL(0)) {
        pageZeroCalls += 1;
        return savedTrackPageResponse(50, 1,
          [pageZeroCalls === 1 ? "spotify:track:a" : "spotify:track:b"]);
      }
      throw new Error("unexpected liked request: " + url);
    }
  });

  await settle();
  playlistButtons(harness)[0].click();
  await settle();

  assert.equal(
    harness.trackStatusElement.textContent,
    "Liked Songs changed while loading. Select it again."
  );
});

test("an unavailable cache degrades the liked read to the full pull", async () => {
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    indexedDB: new FakeIndexedDB({unavailable: true}),
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    likedHandler: steadyLikedHandler(50, ["spotify:track:a"])
  }, backendOptions(backend)));

  await settle();
  playlistButtons(harness)[0].click();
  await settle();

  assert.deepEqual(
    harness.requests
      .filter((request) => request.url.startsWith("https://api.spotify.com/v1/me/tracks"))
      .map((request) => request.url),
    [likedURL(0), likedURL(0)],
    "the read proceeds uncached"
  );
  assert.match(harness.trackStatusElement.textContent, /^Created /);
});

test("one click on a cold playlist reports sanitized full-chain evidence", async () => {
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    playlistHandler: () => playlistPage([
      {id: "steady", name: "Morning", items: {total: 2}, snapshot_id: "snap-1"}
    ])
  }, backendOptions(backend, steadyTrackHandler("steady", "snap-1", 50, ["spotify:track:a", "spotify:track:b"]))));

  await settle();
  playlistButtons(harness)[1].click();
  await settle();

  assert.equal(harness.telemetryReports.length, 2, "the listing and the shuffle each report once");
  const listing = harness.telemetryReports[0];
  assert.equal(listing.kind, "playlist-list");
  assert.equal(listing.terminal_phase, "complete");
  assert.equal(listing.policy, "serial-250ms-v1");
  assert.deepEqual(listing.events.map((event) => event.role), ["playlist-list-page"]);

  const shuffle = harness.telemetryReports[1];
  assert.equal(shuffle.kind, "playlist-shuffle");
  assert.equal(shuffle.terminal_phase, "complete");
  assert.equal(shuffle.source_disposition, "network-read");
  assert.equal(shuffle.target_disposition, "created");
  assert.equal(shuffle.source_total, 2);
  assert.equal(shuffle.request_count, 6);
  assert.equal(shuffle.truncated, false);
  assert.deepEqual(shuffle.events.map((event) => event.role), [
    "playlist-snapshot-pin", "playlist-items-page", "playlist-snapshot-verify",
    "target-create", "target-append", "target-total-verify"
  ]);
  assert.equal(shuffle.events[0].window_count, 2,
    "the rolling window spans the listing operation");
  assert.equal(shuffle.page_session_id, listing.page_session_id);
  assert.notEqual(shuffle.report_id, listing.report_id);
  const itemsPage = shuffle.events[1];
  assert.equal(itemsPage.page_offset, 0);
  assert.equal(itemsPage.page_limit, 50);
  assert.equal(itemsPage.server_total, 2);
  assert.equal(itemsPage.response_items, 2);
  assert.equal(itemsPage.method, "GET");
  assert.equal(itemsPage.result, "ok");
  assert.equal(shuffle.events[3].method, "POST");
  assert.equal(shuffle.events[4].request_items, 2);

  const serialized = JSON.stringify(harness.telemetryReports);
  for (const secret of ["spotify:track", "Morning", "steady", "access-token", "Bearer", "TrueShuffle\\\"", "snap-1"]) {
    assert.equal(serialized.includes(secret), false,
      "telemetry must not contain " + secret);
  }
});

test("a 429 with Retry-After and a structured reason is recorded", async () => {
  const harness = createHarness({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    playlistHandler: () => jsonResponse(
      429,
      {error: {status: 429, message: "rate limited", reason: "QUOTA_EXCEEDED"}},
      null,
      {"Retry-After": "7"}
    )
  });

  await settle();

  assert.equal(harness.telemetryReports.length, 1);
  const listing = harness.telemetryReports[0];
  assert.equal(listing.terminal_phase, "listing-failed");
  const event = listing.events[0];
  assert.equal(event.result, "http-error");
  assert.equal(event.status, 429);
  assert.equal(event.retry_after_state, "valid");
  assert.equal(event.retry_after_seconds, 7);
  assert.equal(event.reason, "QUOTA_EXCEEDED");
  assert.equal(JSON.stringify(listing).includes("rate limited"), false,
    "Spotify's message text stays out of telemetry");
});

test("a liked fingerprint hit reports its disposition and single read request", async () => {
  const uris = ["spotify:track:a", "spotify:track:b"];
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    indexedDB: new FakeIndexedDB(likedRecordSeed({
      total: 2, head: uris, uris: uris, cached_at: 1
    })),
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    likedHandler: steadyLikedHandler(50, uris)
  }, backendOptions(backend)));

  await settle();
  playlistButtons(harness)[0].click();
  await settle();

  const shuffle = harness.telemetryReports[1];
  assert.equal(shuffle.kind, "liked-shuffle");
  assert.equal(shuffle.source_disposition, "liked-fingerprint-hit");
  assert.equal(shuffle.terminal_phase, "complete");
  const likedEvents = shuffle.events.filter((event) => event.endpoint_class === "liked-tracks");
  assert.deepEqual(likedEvents.map((event) => event.role), ["liked-fingerprint-open"],
    "a hit costs exactly the fingerprint page");
});

test("telemetry transport failure never disturbs the operation", async () => {
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    telemetryFailure: true,
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    likedHandler: steadyLikedHandler(50, ["spotify:track:a"])
  }, backendOptions(backend)));

  await settle();
  playlistButtons(harness)[0].click();
  await settle();

  assert.equal(harness.telemetryReports.length, 0);
  assert.match(harness.trackStatusElement.textContent, /^Created "Liked Songs TrueShuffle" /);
});

test("an oversized library stops after page zero with capacity evidence", async () => {
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    likedHandler: (url) => {
      assert.equal(url, likedURL(0), "no request beyond page zero is dispatched");
      return savedTrackPageResponse(50, 13000, ["spotify:track:a"]);
    }
  }, backendOptions(backend)));

  await settle();
  playlistButtons(harness)[0].click();
  await settle();

  assert.equal(backend.writes.length, 0, "an oversized library writes nothing");
  assert.equal(
    harness.requests.filter((request) =>
      request.url.startsWith("https://api.spotify.com/v1/me/tracks")).length,
    1,
    "the read spends exactly its opening page"
  );
  assert.match(harness.trackStatusElement.textContent, /holds more than 10,000 tracks/);
  const shuffle = harness.telemetryReports.find((report) => report.kind === "liked-shuffle");
  assert.equal(shuffle.terminal_phase, "capacity-rejected");
  assert.equal(shuffle.source_disposition, "capacity-rejected");
  assert.equal(shuffle.source_total, 13000);
  assert.equal(shuffle.request_count, 1);
  assert.equal(shuffle.truncated, false);
});
test("an unacknowledged report stays queued and a reload delivers it", async () => {
  const indexedDB = new FakeIndexedDB();
  const backend = makeWriteBackend();
  const rejected = createHarness(Object.assign({
    indexedDB: indexedDB,
    telemetryStatus: 503,
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    likedHandler: steadyLikedHandler(50, ["spotify:track:a"])
  }, backendOptions(backend)));

  await settle();
  playlistButtons(rejected)[0].click();
  await settle();

  assert.match(rejected.trackStatusElement.textContent, /^Created /,
    "a rejected telemetry delivery never disturbs the operation");
  const stored = indexedDB.record("trueshuffle-telemetry", "queue", "envelope");
  assert.equal(stored.entries.length, 2,
    "the listing and shuffle reports remain queued until acknowledged");

  const reloaded = createHarness({
    indexedDB: indexedDB,
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    likedHandler: steadyLikedHandler(50, ["spotify:track:a"])
  });
  await settle();

  const drained = indexedDB.record("trueshuffle-telemetry", "queue", "envelope");
  assert.equal(drained.entries.length, 0, "initialization drains the queue oldest first");
  assert.equal(reloaded.telemetryReports.length >= 2, true);
  assert.equal(reloaded.telemetryReports[0].kind, "playlist-list",
    "the oldest pending report is delivered first");
  assert.equal(reloaded.telemetryReports[0].delivery_storage, "indexeddb");
});

test("a transport failure leaves reports queued without any fallback send", async () => {
  const indexedDB = new FakeIndexedDB();
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    indexedDB: indexedDB,
    telemetryFailure: true,
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    likedHandler: steadyLikedHandler(50, ["spotify:track:a"])
  }, backendOptions(backend)));

  await settle();
  playlistButtons(harness)[0].click();
  await settle();

  assert.match(harness.trackStatusElement.textContent, /^Created /);
  const stored = indexedDB.record("trueshuffle-telemetry", "queue", "envelope");
  assert.equal(stored.entries.length, 2, "reports persist across a dead intake");
});

test("a seeded drop count reaches newly delivered reports", async () => {
  const indexedDB = new FakeIndexedDB({
    seed: {
      "trueshuffle-telemetry": {
        queue: {
          envelope: {
            version: 1,
            dropped: 3,
            entries: [{id: "seeded", failed: true, body: "{\"seeded\":true}"}]
          }
        }
      }
    }
  });
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    indexedDB: indexedDB,
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    likedHandler: steadyLikedHandler(50, ["spotify:track:a"])
  }, backendOptions(backend)));

  await settle();
  playlistButtons(harness)[0].click();
  await settle();

  assert.deepEqual(harness.telemetryReports[0], {seeded: true},
    "the seeded pending report is delivered before new ones");
  const listing = harness.telemetryReports[1];
  assert.equal(listing.delivery_storage, "indexeddb");
  assert.equal(listing.reports_dropped_before, 3,
    "the persisted drop counter reaches the report");
  const stored = indexedDB.record("trueshuffle-telemetry", "queue", "envelope");
  assert.equal(stored.entries.length, 0);
  assert.equal(stored.dropped, 3, "acknowledgement does not reset the counter");
});

test("a corrupt queue record degrades that report to one-shot and resets", async () => {
  const indexedDB = new FakeIndexedDB();
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    indexedDB: indexedDB,
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    likedHandler: steadyLikedHandler(50, ["spotify:track:a"])
  }, backendOptions(backend)));

  await settle();
  indexedDB.databases.get("trueshuffle-telemetry").get("queue").set("envelope", {bogus: true});
  playlistButtons(harness)[0].click();
  await settle();

  const shuffle = harness.telemetryReports.find((report) => report.kind === "liked-shuffle");
  assert.equal(shuffle.delivery_storage, "queue-unavailable",
    "corruption is reported honestly, never interpreted");
  const stored = indexedDB.record("trueshuffle-telemetry", "queue", "envelope");
  assert.equal(TrueShuffle_validEnvelope(stored), true,
    "the corrupt record is discarded so the queue heals");
});

// The pure validator, reachable from the test realm for the corruption case.
function TrueShuffle_validEnvelope(value) {
  const context = vm.createContext({});
  vm.runInContext(pureSource, context, {filename: "web/pure.js"});
  return context.TrueShuffle.validTelemetryQueueEnvelope(
    JSON.parse(JSON.stringify(value))
  );
}

test("without usable IndexedDB delivery degrades to one-shot and says so", async () => {
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    likedHandler: steadyLikedHandler(50, ["spotify:track:a"])
  }, backendOptions(backend)));

  await settle();
  playlistButtons(harness)[0].click();
  await settle();

  assert.equal(harness.telemetryReports.length, 2);
  for (const report of harness.telemetryReports) {
    assert.equal(report.delivery_storage, "queue-unavailable");
  }
  assert.match(harness.trackStatusElement.textContent, /^Created /);
});

test("a short 429 is retried once after the advertised delay", async () => {
  const clock = manualClock();
  let listingCalls = 0;
  const harness = createHarness({
    clock: clock,
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    playlistHandler: () => {
      listingCalls += 1;
      return listingCalls === 1
        ? jsonResponse(429, {error: {status: 429, message: "slow down"}}, null, {"Retry-After": "7"})
        : playlistPage([{id: "first", name: "Morning", items: {total: 1}}]);
    }
  });

  await clock.drain();

  assert.equal(listingCalls, 2, "the 429 is retried exactly once");
  assert.match(harness.playlistStatusElement.textContent, /^Select a playlist/);
  const spotify = harness.requests.filter((request) => request.url.startsWith(playlistsEndpoint));
  assert.ok(spotify[1].at - spotify[0].at >= 7000, "the retry honors the advertised delay");
  const listing = harness.telemetryReports[0];
  assert.deepEqual(listing.events.map((event) => [event.attempt, event.result]),
    [[1, "http-error"], [2, "ok"]]);
  assert.ok(listing.events[1].scheduled_wait_ms >= 7000);
});

test("a 429 without usable guidance waits the 30-second fallback", async () => {
  const clock = manualClock();
  let listingCalls = 0;
  const harness = createHarness({
    clock: clock,
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    playlistHandler: () => {
      listingCalls += 1;
      return listingCalls === 1
        ? jsonResponse(429, {error: {status: 429, message: "slow down"}}, null, {"Retry-After": "soon"})
        : playlistPage([]);
    }
  });

  await clock.drain();

  assert.equal(listingCalls, 2);
  const spotify = harness.requests.filter((request) => request.url.startsWith(playlistsEndpoint));
  assert.ok(spotify[1].at - spotify[0].at >= 30000, "invalid guidance becomes the 30-second fallback");
  assert.equal(harness.telemetryReports[0].events[0].retry_after_state, "invalid");
});

test("a second 429 stops without another retry", async () => {
  const clock = manualClock();
  let listingCalls = 0;
  const harness = createHarness({
    clock: clock,
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    playlistHandler: () => {
      listingCalls += 1;
      return jsonResponse(429, {error: {status: 429, message: "still limited"}}, null, {"Retry-After": "5"});
    }
  });

  await clock.drain();

  assert.equal(listingCalls, 2, "no third attempt is ever dispatched");
  assert.match(
    harness.playlistStatusElement.textContent,
    /^Spotify asked for a pause\. Try again after \d{2}:\d{2}:\d{2}\. Reload afterward\.$/,
    "a limited retry surfaces the pause with its absolute time"
  );
  assert.deepEqual(
    harness.telemetryReports[0].events.map((event) => [event.attempt, event.status]),
    [[1, 429], [2, 429]]
  );
});

test("network failures and other statuses are never retried", async () => {
  let networkCalls = 0;
  const networkHarness = createHarness({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    playlistHandler: () => {
      networkCalls += 1;
      throw new Error("network unavailable");
    }
  });
  await settle();
  assert.equal(networkCalls, 1);
  assert.match(networkHarness.playlistStatusElement.textContent, /^Playlists could not be loaded/);

  let serverCalls = 0;
  const serverHarness = createHarness({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    playlistHandler: () => {
      serverCalls += 1;
      return jsonResponse(500, {error: {status: 500, message: "boom"}});
    }
  });
  await settle();
  assert.equal(serverCalls, 1);
  assert.match(serverHarness.playlistStatusElement.textContent, /^Playlists could not be loaded/);
});

test("a long cooldown blocks locally, survives reload, and expires", async () => {
  const clock = manualClock();
  const localStorage = new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())});
  let listingCalls = 0;
  const first = createHarness({
    clock: clock,
    localStorage: localStorage,
    playlistHandler: () => {
      listingCalls += 1;
      return jsonResponse(429, {error: {status: 429, message: "cool down"}}, null, {"Retry-After": "3600"});
    }
  });
  await clock.drain();

  assert.equal(listingCalls, 1, "a long deadline is never retried");
  assert.match(
    first.playlistStatusElement.textContent,
    /^Spotify asked for a pause\. Try again after \d{2}:\d{2}:\d{2}\. Reload afterward\.$/
  );
  assert.ok(localStorage.getItem("trueshuffle.spotify-cooldown.v1") !== null,
    "the deadline is persisted");

  const blocked = createHarness({
    clock: clock,
    localStorage: localStorage,
    playlistHandler: () => {
      throw new Error("no Spotify call may happen during the cooldown");
    }
  });
  await clock.drain();

  assert.equal(
    blocked.requests.filter((request) => request.url.startsWith("https://api.spotify.com/")).length,
    0,
    "a reload during the cooldown issues no Spotify call"
  );
  assert.match(blocked.playlistStatusElement.textContent, /^Spotify asked for a pause/);
  const blockedEvent = blocked.telemetryReports[0].events[0];
  assert.equal(blockedEvent.result, "cooldown-blocked");
  assert.equal(blockedEvent.status, null, "no Spotify status is invented");

  clock.now += 3601 * 1000;
  const recovered = createHarness({
    clock: clock,
    localStorage: localStorage,
    playlistHandler: () => playlistPage([])
  });
  await clock.drain();
  assert.match(recovered.playlistStatusElement.textContent, /^Select a playlist/);
  assert.equal(localStorage.getItem("trueshuffle.spotify-cooldown.v1"), null,
    "the expired record is removed");
});

test("disconnect aborts a pending paced wait and dispatches nothing after", async () => {
  const clock = manualClock();
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    clock: clock,
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    likedHandler: steadyLikedHandler(50, Array.from({length: 150}, (_, index) => "spotify:track:" + index))
  }, backendOptions(backend)));

  await clock.drain();
  playlistButtons(harness)[0].click();
  await clock.advance(1000);
  const likedRequestsBefore = harness.requests.filter(
    (request) => request.url.startsWith("https://api.spotify.com/v1/me/tracks")
  ).length;
  assert.ok(likedRequestsBefore >= 1, "the read began before disconnect");

  harness.logoutButton.click();
  await clock.drain();

  assert.equal(
    harness.requests.filter(
      (request) => request.url.startsWith("https://api.spotify.com/v1/me/tracks")
    ).length,
    likedRequestsBefore,
    "no page is dispatched after the abort"
  );
  assert.equal(backend.writes.length, 0, "no write batch follows a cancelled chain");
  assert.equal(harness.trackStatusElement.textContent, "");
});

test("a rate-limit wait shows a live countdown that ticks and clears", async () => {
  const clock = manualClock();
  let listingCalls = 0;
  const harness = createHarness({
    clock: clock,
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    playlistHandler: () => {
      listingCalls += 1;
      return listingCalls === 1
        ? jsonResponse(429, {error: {status: 429, message: "slow down"}}, null, {"Retry-After": "30"})
        : playlistPage([]);
    }
  });

  await clock.run();
  assert.equal(harness.waitStatusElement.hidden, false, "the wait is visible");
  assert.match(harness.waitStatusElement.textContent,
    /^Spotify asked us to slow down -- retrying in 30s\.$/);

  await clock.advance(5000);
  assert.equal(harness.waitStatusElement.hidden, false);
  assert.match(harness.waitStatusElement.textContent, /retrying in 2[0-9]s\.$/,
    "the countdown ticks down as time passes");

  await clock.drain();
  assert.equal(harness.waitStatusElement.hidden, true, "the countdown clears on resume");
  assert.equal(harness.waitStatusElement.textContent, "");
  assert.equal(listingCalls, 2);
  assert.match(harness.playlistStatusElement.textContent, /^Select a playlist/);
});

test("routine pacing gaps never show the countdown", async () => {
  const clock = manualClock();
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    clock: clock,
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    playlistHandler: () => playlistPage([{id: "steady", name: "Morning", items: {total: 2}, snapshot_id: "snap-1"}])
  }, backendOptions(backend, steadyTrackHandler("steady", "snap-1", 50, ["spotify:track:a", "spotify:track:b"]))));

  await clock.drain();
  playlistButtons(harness)[1].click();
  for (let step = 0; step < 15; step += 1) {
    assert.equal(harness.waitStatusElement.hidden, true,
      "a one-second pacing gap is silent");
    await clock.advance(1000);
  }
  assert.match(harness.trackStatusElement.textContent, /^Created "Morning TrueShuffle" /);
  assert.equal(harness.waitStatusElement.hidden, true);
});

test("cancel during a rate-limit wait ends the chain cleanly", async () => {
  const clock = manualClock();
  const backend = makeWriteBackend();
  const harness = createHarness(Object.assign({
    clock: clock,
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    playlistHandler: () => playlistPage([{id: "slow", name: "Morning", items: {total: 1}, snapshot_id: "snap-1"}])
  }, backendOptions(backend, (url) => {
    if (url === snapshotURL("slow")) {
      return snapshotPage("snap-1");
    }
    return jsonResponse(429, {error: {status: 429, message: "limited"}}, null, {"Retry-After": "45"});
  })));

  await clock.drain();
  playlistButtons(harness)[1].click();
  assert.equal(harness.cancelButton.hidden, false, "cancel accompanies the chain");
  for (let step = 0; step < 6 && harness.waitStatusElement.hidden; step += 1) {
    await clock.advance(1000);
  }
  assert.equal(harness.waitStatusElement.hidden, false, "the retry wait is visible");
  const spotifyRequests = () => harness.requests.filter(
    (request) => request.url.startsWith("https://api.spotify.com/")
  ).length;
  const requestsBefore = spotifyRequests();

  harness.cancelButton.click();
  await clock.drain();

  assert.equal(harness.trackStatusElement.textContent, "Cancelled.");
  assert.equal(harness.waitStatusElement.hidden, true);
  assert.equal(harness.cancelButton.hidden, true);
  assert.equal(playlistButtons(harness)[1].disabled, false, "rows re-enable immediately");
  assert.equal(spotifyRequests(), requestsBefore, "no Spotify request follows the cancel");
  assert.equal(backend.writes.length, 0);
  const shuffle = harness.telemetryReports.find((report) => report.kind === "playlist-shuffle");
  assert.equal(shuffle.terminal_phase, "abandoned");
});

test("cancel during writing names the possibly partial target", async () => {
  const backend = makeWriteBackend();
  const options = backendOptions(backend);
  const baseTrackHandler = options.trackHandler;
  const firstAppend = deferred();
  let held = null;
  options.trackHandler = (url, requestOptions) => {
    if (/\/items$/.test(url) && held === null) {
      held = {url: url, requestOptions: requestOptions};
      return firstAppend.promise.then(() => baseTrackHandler(url, requestOptions));
    }
    return baseTrackHandler(url, requestOptions);
  };
  const harness = createHarness(Object.assign({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    likedHandler: steadyLikedHandler(50, Array.from({length: 150}, (_, index) => "spotify:track:" + index))
  }, options));

  await settle();
  playlistButtons(harness)[0].click();
  await settleUntil(() => held !== null);

  harness.cancelButton.click();
  firstAppend.resolve();
  await settle();

  assert.equal(
    harness.trackStatusElement.textContent,
    "Cancelled. \"Liked Songs TrueShuffle\" may be incomplete; shuffle again to rewrite it."
  );
  assert.equal(backend.writes.length, 1, "the in-flight batch lands; no later batch is sent");
  assert.equal(harness.cancelButton.hidden, true);
  assert.equal(playlistButtons(harness)[0].disabled, false);
});

test("the result link follows the standing result through its whole lifecycle", async () => {
  const uris = ["spotify:track:a", "spotify:track:b"];
  const backend = makeWriteBackend();
  let writeGate = null;
  let failWrites = false;
  const options = Object.assign({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    likedHandler: steadyLikedHandler(50, uris)
  }, backendOptions(backend));
  const writeThrough = options.trackHandler;
  options.trackHandler = (url, requestOptions) => {
    if (failWrites && requestOptions && requestOptions.method) {
      return jsonResponse(500, {error: {status: 500, message: "Server error"}});
    }
    if (writeGate !== null) {
      const gate = writeGate;
      return gate.promise.then(() => writeThrough(url, requestOptions));
    }
    return writeThrough(url, requestOptions);
  };
  const harness = createHarness(options);

  await settle();
  assert.equal(harness.openTargetLink.hidden, true, "no link before any result");

  playlistButtons(harness)[0].click();
  await settle();
  assert.equal(harness.openTargetLink.hidden, false, "a created result offers the link");
  assert.equal(harness.openTargetLink.href, "https://open.spotify.com/playlist/target-1");
  assert.match(harness.trackStatusElement.textContent, /^Created /);

  writeGate = deferred();
  playlistButtons(harness)[0].click();
  await settle();
  assert.equal(harness.openTargetLink.hidden, true,
    "the link never outlives its result into a running chain");

  const gate = writeGate;
  writeGate = null;
  gate.resolve();
  await settle();
  assert.equal(harness.openTargetLink.hidden, false);
  assert.equal(harness.openTargetLink.href, "https://open.spotify.com/playlist/target-1",
    "an updated result points at the same derived target");
  assert.match(harness.trackStatusElement.textContent, /^Updated /);

  failWrites = true;
  playlistButtons(harness)[0].click();
  await settle();
  assert.match(harness.trackStatusElement.textContent, /may be incomplete/);
  assert.equal(harness.openTargetLink.hidden, true, "a failure leaves no link standing");

  failWrites = false;
  playlistButtons(harness)[0].click();
  await settle();
  assert.equal(harness.openTargetLink.hidden, false);

  harness.logoutButton.click();
  assert.equal(harness.openTargetLink.hidden, true, "disconnect retires the link");
});
