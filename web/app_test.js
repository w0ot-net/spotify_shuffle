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

function snapshotPage(snapshotId) {
  return jsonResponse(200, {snapshot_id: snapshotId});
}

function trackPageResponse(limit, total, uris) {
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
    "/tracks?fields=limit,total,items(track(uri))&limit=100&offset=" + offset;
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
    return trackPageResponse(limit, uris.length, uris.slice(offset, offset + limit));
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
    return trackPageResponse(limit, uris.length, uris.slice(offset, offset + limit));
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return {promise: promise, resolve: resolve};
}

function createHarness(options) {
  options = options || {};
  const statusElement = new FakeElement(false);
  const connectButton = new FakeElement(true);
  const logoutButton = new FakeElement(true);
  const playlistStatusElement = new FakeElement(true);
  const trackStatusElement = new FakeElement(true);
  const trackProgressElement = new FakeElement(true);
  const playlistsElement = new FakeElement(true);
  const likedStatusElement = new FakeElement(true);
  const likedConnectButton = new FakeElement(true);
  const likedLoadButton = new FakeElement(true);
  const likedShuffleButton = new FakeElement(true);
  const elements = {
    status: statusElement,
    connect: connectButton,
    logout: logoutButton,
    "playlist-status": playlistStatusElement,
    "track-status": trackStatusElement,
    "track-progress": trackProgressElement,
    playlists: playlistsElement,
    "liked-status": likedStatusElement,
    "liked-connect": likedConnectButton,
    "liked-load": likedLoadButton,
    "liked-shuffle": likedShuffleButton
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
      if (url.startsWith("https://api.spotify.com/v1/me/tracks") && options.likedHandler) {
        return options.likedHandler(url, requestOptions);
      }
      if (url === "https://api.spotify.com/v1/me" && options.meHandler) {
        return options.meHandler(url, requestOptions);
      }
      if (url.startsWith("https://api.spotify.com/v1/users/") && options.createPlaylistHandler) {
        return options.createPlaylistHandler(url, requestOptions);
      }
      if (url.startsWith("https://api.spotify.com/v1/playlists/") && options.trackHandler) {
        return options.trackHandler(url, requestOptions);
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
    statusElement: statusElement,
    trackProgressElement: trackProgressElement,
    trackStatusElement: trackStatusElement,
    likedStatusElement: likedStatusElement,
    likedConnectButton: likedConnectButton,
    likedLoadButton: likedLoadButton,
    likedShuffleButton: likedShuffleButton
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

// Selection now loads tracks, so the former assertion that selecting issues
// no request moved with the behavior: each selection reads the playlist.
test("selecting a playlist marks it and moves the mark on reselection", async () => {
  const harness = createHarness({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(currentToken())}),
    playlistHandler: () => playlistPage([
      {id: "first", name: "Morning", tracks: {total: 1}},
      {id: "second", name: "Evening", tracks: {total: 1}}
    ]),
    trackHandler: (url) => {
      const playlistId = url.includes("/playlists/first") ? "first" : "second";
      return steadyTrackHandler(playlistId, "snap-" + playlistId, 100, ["spotify:track:" + playlistId])(url);
    }
  });

  await settle();
  const buttons = playlistButtons(harness);

  buttons[0].click();
  await settle();
  assert.equal(buttons[0].getAttribute("aria-pressed"), "true");
  assert.equal(harness.playlistStatusElement.textContent, "Selected Morning.");
  assert.match(harness.trackStatusElement.textContent, /^Loaded 1 track in \d+\.\ds\.$/);

  buttons[1].click();
  await settle();
  assert.equal(buttons[0].getAttribute("aria-pressed"), "false");
  assert.equal(buttons[1].getAttribute("aria-pressed"), "true");
  assert.equal(harness.playlistStatusElement.textContent, "Selected Evening.");
});

test("disconnecting clears a rendered playlist list and track state", async () => {
  const harness = createHarness({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(currentToken())}),
    playlistHandler: () => playlistPage([{id: "first", name: "Morning", tracks: {total: 1}}]),
    trackHandler: steadyTrackHandler("first", "snap-1", 100, ["spotify:track:a"])
  });

  await settle();
  assert.equal(playlistButtons(harness).length, 1);
  playlistButtons(harness)[0].click();
  await settle();
  assert.match(harness.trackStatusElement.textContent, /^Loaded 1 track in \d+\.\ds\.$/);

  harness.logoutButton.click();

  assert.deepEqual(harness.playlistsElement.children, []);
  assert.equal(harness.playlistsElement.hidden, true);
  assert.equal(harness.playlistStatusElement.hidden, true);
  assert.equal(harness.trackStatusElement.hidden, true);
  assert.equal(harness.trackStatusElement.textContent, "");
  assert.equal(harness.statusElement.textContent, "Spotify was disconnected from this browser.");
});

test("selecting a playlist reads every page and renders the count", async () => {
  const uris = [];
  for (let index = 0; index < 250; index += 1) {
    uris.push("spotify:track:" + index);
  }
  const harness = createHarness({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(currentToken())}),
    playlistHandler: () => playlistPage([{id: "big", name: "Big", tracks: {total: 250}}]),
    trackHandler: steadyTrackHandler("big", "snap-1", 100, uris)
  });

  await settle();
  playlistButtons(harness)[0].click();
  await settle();

  assert.match(harness.trackStatusElement.textContent, /^Loaded 250 tracks in \d+\.\ds\.$/);
  assert.equal(harness.trackStatusElement.hidden, false);
  assert.equal(harness.trackProgressElement.hidden, true, "the bar hides once the load settles");
  const trackRequests = harness.requests.filter(
    (request) => request.url.startsWith("https://api.spotify.com/v1/playlists/")
  );
  assert.deepEqual(trackRequests.map((request) => request.url), [
    snapshotURL("big"),
    trackURL("big", 0),
    trackURL("big", 100),
    trackURL("big", 200),
    snapshotURL("big")
  ]);
  assert.equal(trackRequests[0].options.headers.Authorization, "Bearer current-access-token");
  assert.equal(playlistButtons(harness)[0].disabled, false);
});

test("an empty playlist renders a zero count", async () => {
  const harness = createHarness({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(currentToken())}),
    playlistHandler: () => playlistPage([{id: "empty", name: "Empty", tracks: {total: 0}}]),
    trackHandler: steadyTrackHandler("empty", "snap-1", 100, [])
  });

  await settle();
  playlistButtons(harness)[0].click();
  await settle();

  assert.match(harness.trackStatusElement.textContent, /^Loaded 0 tracks in \d+\.\ds\.$/);
  assert.equal(harness.trackProgressElement.max, undefined,
    "a zero-total read never shows the progress bar");
});

test("track pages dispatch through a bounded pool and assemble out of order", async () => {
  const uris = [];
  for (let index = 0; index < 8; index += 1) {
    uris.push("spotify:track:" + index);
  }
  const deferredByOffset = new Map();
  const harness = createHarness({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(currentToken())}),
    playlistHandler: () => playlistPage([{id: "big", name: "Big", tracks: {total: 8}}]),
    trackHandler: (url) => {
      if (url === snapshotURL("big")) {
        return snapshotPage("snap-1");
      }
      if (url === trackURL("big", 0)) {
        // The echoed limit of 1 is what the remaining offsets step by, so
        // documentation assumptions about the page size cannot matter.
        return trackPageResponse(1, 8, [uris[0]]);
      }
      const offset = Number(new URL(url).searchParams.get("offset"));
      const entry = deferred();
      deferredByOffset.set(offset, entry);
      return entry.promise;
    }
  });

  await settle();
  playlistButtons(harness)[0].click();
  await settle();

  // Page 0 revealed 7 remaining pages; the pool holds 6 in flight.
  assert.deepEqual([...deferredByOffset.keys()], [1, 2, 3, 4, 5, 6]);
  assert.equal(harness.trackStatusElement.textContent, "Loading tracks...");
  assert.equal(playlistButtons(harness)[0].disabled, true);
  // Page 0 also made progress determinate: server-truth max, one page done.
  assert.equal(harness.trackProgressElement.hidden, false);
  assert.equal(harness.trackProgressElement.max, 8);
  assert.equal(harness.trackProgressElement.value, 1);

  deferredByOffset.get(3).resolve(trackPageResponse(1, 8, [uris[3]]));
  await settle();
  assert.ok(deferredByOffset.has(7), "a freed slot dispatches the next page");
  assert.equal(harness.trackProgressElement.value, 2, "a completed page advances the bar");

  for (const offset of [7, 1, 6, 2, 5, 4]) {
    deferredByOffset.get(offset).resolve(trackPageResponse(1, 8, [uris[offset]]));
  }
  await settle();

  assert.match(harness.trackStatusElement.textContent, /^Loaded 8 tracks in \d+\.\ds\.$/);
  assert.equal(harness.trackProgressElement.hidden, true);
  assert.equal(playlistButtons(harness)[0].disabled, false);
});

test("a snapshot change during the read fails it and disturbs nothing else", async () => {
  let snapshotCalls = 0;
  const rawToken = JSON.stringify(currentToken());
  const localStorage = new FakeStorage({[tokenStorageKey]: rawToken});
  const harness = createHarness({
    localStorage: localStorage,
    playlistHandler: () => playlistPage([{id: "torn", name: "Morning", tracks: {total: 1}}]),
    trackHandler: (url) => {
      if (url === snapshotURL("torn")) {
        snapshotCalls += 1;
        return snapshotPage(snapshotCalls === 1 ? "snap-1" : "snap-2");
      }
      return trackPageResponse(100, 1, ["spotify:track:a"]);
    }
  });

  await settle();
  playlistButtons(harness)[0].click();
  await settle();

  assert.equal(
    harness.trackStatusElement.textContent,
    "This playlist changed while loading. Select it again."
  );
  assert.equal(localStorage.getItem(tokenStorageKey), rawToken);
  assert.equal(harness.playlistsElement.hidden, false);
  assert.equal(harness.statusElement.textContent, "Spotify is connected in this browser.");
  assert.equal(harness.playlistStatusElement.textContent, "Selected Morning.");
  assert.equal(playlistButtons(harness)[0].disabled, false);
  // max === 1 proves the bar appeared during the read; hidden proves the
  // failed settle removed it.
  assert.equal(harness.trackProgressElement.max, 1);
  assert.equal(harness.trackProgressElement.hidden, true);
});

test("a track count short of the total fails the read", async () => {
  const harness = createHarness({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(currentToken())}),
    playlistHandler: () => playlistPage([{id: "short", name: "Morning", tracks: {total: 3}}]),
    trackHandler: (url) => url === snapshotURL("short")
      ? snapshotPage("snap-1")
      : trackPageResponse(100, 3, ["spotify:track:a", "spotify:track:b"])
  });

  await settle();
  playlistButtons(harness)[0].click();
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
    playlistHandler: () => playlistPage([{id: "down", name: "Morning", tracks: {total: 1}}]),
    trackHandler: () => jsonResponse(500, {error: {status: 500}})
  });

  await settle();
  playlistButtons(harness)[0].click();
  await settle();

  assert.equal(
    harness.trackStatusElement.textContent,
    "Tracks could not be loaded (Spotify returned 500 at /v1/playlists/down). Select the playlist again to retry."
  );
  assert.equal(localStorage.getItem(tokenStorageKey), rawToken);
  assert.equal(harness.playlistsElement.hidden, false);
  assert.equal(harness.statusElement.textContent, "Spotify is connected in this browser.");
  assert.equal(playlistButtons(harness)[0].disabled, false);
});

// Objects built inside the vm realm carry that realm's prototypes, which
// strict deep equality rejects; compare plain content instead.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("re-selecting an unchanged playlist renders from cache with zero track requests", async () => {
  const indexedDB = new FakeIndexedDB();
  const harness = createHarness({
    indexedDB: indexedDB,
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(currentToken())}),
    playlistHandler: () => playlistPage([
      {id: "steady", name: "Morning", tracks: {total: 2}, snapshot_id: "snap-1"}
    ]),
    trackHandler: steadyTrackHandler("steady", "snap-1", 100, ["spotify:track:a", "spotify:track:b"])
  });

  await settle();
  playlistButtons(harness)[0].click();
  await settle();

  assert.match(harness.trackStatusElement.textContent, /^Loaded 2 tracks in \d+\.\ds\.$/);
  const stored = indexedDB.record("trueshuffle", "playlists", "steady");
  assert.equal(stored.snapshot_id, "snap-1");
  assert.deepEqual(plain(stored.uris), ["spotify:track:a", "spotify:track:b"]);
  assert.equal(typeof stored.cached_at, "number");

  const readRequests = harness.requests.length;
  playlistButtons(harness)[0].click();
  await settle();

  assert.equal(harness.requests.length, readRequests, "a cache hit issues zero requests");
  assert.equal(harness.trackStatusElement.textContent, "Loaded 2 tracks.",
    "a cache hit renders the plain count with no duration");
  assert.equal(playlistButtons(harness)[0].disabled, false);
});

test("a cache hit never shows the progress bar", async () => {
  const indexedDB = new FakeIndexedDB({
    seed: {
      trueshuffle: {
        playlists: {
          hit: {
            snapshot_id: "snap-1",
            uris: ["spotify:track:a", "spotify:track:b"],
            cached_at: 1
          }
        }
      }
    }
  });
  const harness = createHarness({
    indexedDB: indexedDB,
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(currentToken())}),
    playlistHandler: () => playlistPage([
      {id: "hit", name: "Morning", tracks: {total: 2}, snapshot_id: "snap-1"}
    ])
  });

  await settle();
  playlistButtons(harness)[0].click();
  await settle();

  assert.equal(harness.trackStatusElement.textContent, "Loaded 2 tracks.");
  // No trackHandler is configured, so any track request would have failed
  // the read; an untouched max proves the bar was never rendered at all.
  assert.equal(harness.trackProgressElement.max, undefined);
  assert.equal(harness.trackProgressElement.hidden, true);
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
  const harness = createHarness({
    indexedDB: indexedDB,
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(currentToken())}),
    playlistHandler: () => playlistPage([
      {id: "changed", name: "Morning", tracks: {total: 3}, snapshot_id: "snap-new"}
    ]),
    trackHandler: steadyTrackHandler("changed", "snap-new", 100,
      ["spotify:track:b", "spotify:track:c", "spotify:track:c"])
  });

  await settle();
  playlistButtons(harness)[0].click();
  await settle();

  assert.match(
    harness.trackStatusElement.textContent,
    /^Loaded 3 tracks in \d+\.\ds\. 2 added, 2 removed since last read\.$/
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
  const harness = createHarness({
    indexedDB: indexedDB,
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(currentToken())}),
    playlistHandler: () => playlistPage([
      {id: "reordered", name: "Morning", tracks: {total: 2}, snapshot_id: "snap-new"}
    ]),
    trackHandler: steadyTrackHandler("reordered", "snap-new", 100,
      ["spotify:track:b", "spotify:track:a"])
  });

  await settle();
  playlistButtons(harness)[0].click();
  await settle();

  assert.match(harness.trackStatusElement.textContent, /^Loaded 2 tracks in \d+\.\ds\.$/,
    "a membership-identical change renders no added/removed suffix");
});

test("an unavailable cache degrades to an uncached read", async () => {
  const harness = createHarness({
    indexedDB: new FakeIndexedDB({unavailable: true}),
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(currentToken())}),
    playlistHandler: () => playlistPage([
      {id: "nocache", name: "Morning", tracks: {total: 1}, snapshot_id: "snap-1"}
    ]),
    trackHandler: steadyTrackHandler("nocache", "snap-1", 100, ["spotify:track:a"])
  });

  await settle();
  playlistButtons(harness)[0].click();
  await settle();

  assert.match(harness.trackStatusElement.textContent, /^Loaded 1 track in \d+\.\ds\.$/);
  assert.equal(playlistButtons(harness)[0].disabled, false);
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
      {id: "kept", name: "Morning", tracks: {total: 1}, snapshot_id: "snap-new"}
    ]),
    trackHandler: () => jsonResponse(500, {error: {status: 500}})
  });

  await settle();
  playlistButtons(harness)[0].click();
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
      {id: "gone", name: "Morning", tracks: {total: 1}, snapshot_id: "snap-1"}
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
    playlistHandler: () => playlistPage([{id: "slow", name: "Morning", tracks: {total: 1}}]),
    trackHandler: (url) => url === snapshotURL("slow") ? snapshotPage("snap-1") : entry.promise
  });

  await settle();
  playlistButtons(harness)[0].click();
  await settle();
  assert.equal(harness.trackStatusElement.textContent, "Loading tracks...");

  harness.logoutButton.click();
  entry.resolve(trackPageResponse(100, 1, ["spotify:track:a"]));
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
  await settle(40);

  assert.equal(harness.location.assigned, null);
  assert.equal(sessionStorage.getItem(stateStorageKey), null);
  assert.equal(sessionStorage.getItem(verifierStorageKey), null);
  assert.equal(harness.statusElement.textContent, "Spotify authorization could not be started.");
  assert.equal(harness.connectButton.hidden, false);
  assert.equal(harness.connectButton.disabled, false);
});

test("a token without the library scope offers reconnection for Liked Songs", async () => {
  const harness = createHarness({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(currentToken())})
  });

  await settle();

  assert.equal(harness.likedStatusElement.textContent, "Reconnect Spotify to enable Liked Songs.");
  assert.equal(harness.likedConnectButton.hidden, false);
  assert.equal(harness.likedLoadButton.hidden, true);

  harness.likedConnectButton.click();
  await settle(40);

  assert.ok(harness.location.assigned, "reconnection starts the authorization flow");
  assert.ok(
    harness.location.assigned.includes("user-library-read"),
    "the authorize URL requests the library scope"
  );
});

test("loading Liked Songs reads every page and renders the count", async () => {
  const uris = [];
  for (let index = 0; index < 120; index += 1) {
    uris.push("spotify:track:liked" + index);
  }
  const harness = createHarness({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    likedHandler: steadyLikedHandler(50, uris)
  });

  await settle();
  assert.equal(harness.likedStatusElement.textContent, "Liked Songs can be loaded.");
  assert.equal(harness.likedConnectButton.hidden, true);
  assert.equal(harness.likedLoadButton.hidden, false);

  harness.likedLoadButton.click();
  await settle();

  assert.match(harness.likedStatusElement.textContent, /^Loaded 120 tracks in \d+\.\ds\.$/);
  const likedRequests = harness.requests
    .filter((request) => request.url.startsWith("https://api.spotify.com/v1/me/tracks"))
    .map((request) => request.url);
  assert.deepEqual(likedRequests, [
    likedURL(0),
    likedURL(50),
    likedURL(100),
    likedURL(0)
  ], "page 0, the pooled offsets, then the verification probe");
  assert.equal(harness.trackProgressElement.hidden, true);
  assert.equal(harness.likedLoadButton.disabled, false);
});

test("a Liked Songs total drift fails the read", async () => {
  let pageZeroCalls = 0;
  const harness = createHarness({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    likedHandler: (url) => {
      if (url === likedURL(0)) {
        pageZeroCalls += 1;
        return trackPageResponse(50, pageZeroCalls === 1 ? 1 : 2, ["spotify:track:a"]);
      }
      throw new Error("unexpected liked request: " + url);
    }
  });

  await settle();
  harness.likedLoadButton.click();
  await settle();

  assert.equal(
    harness.likedStatusElement.textContent,
    "Liked Songs changed while loading. Load them again."
  );
});

test("a failed Liked Songs read leaves playlists and token intact", async () => {
  const rawToken = JSON.stringify(likedToken());
  const localStorage = new FakeStorage({[tokenStorageKey]: rawToken});
  const harness = createHarness({
    localStorage: localStorage,
    playlistHandler: () => playlistPage([{id: "first", name: "Morning", tracks: {total: 1}}]),
    likedHandler: () => jsonResponse(500, {error: {status: 500}})
  });

  await settle();
  harness.likedLoadButton.click();
  await settle();

  assert.equal(harness.likedStatusElement.textContent, "Liked Songs could not be loaded (Spotify returned 500 at /v1/me/tracks). Try again.");
  assert.equal(localStorage.getItem(tokenStorageKey), rawToken);
  assert.equal(harness.playlistsElement.hidden, false);
  assert.equal(harness.statusElement.textContent, "Spotify is connected in this browser.");
});

test("a Liked Songs load disables the playlist buttons", async () => {
  const entry = deferred();
  const harness = createHarness({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    playlistHandler: () => playlistPage([{id: "first", name: "Morning", tracks: {total: 1}}]),
    likedHandler: () => entry.promise
  });

  await settle();
  harness.likedLoadButton.click();
  await settle();

  assert.equal(playlistButtons(harness)[0].disabled, true);
  assert.equal(harness.likedLoadButton.disabled, true);

  entry.resolve(trackPageResponse(50, 1, ["spotify:track:a"]));
  await settle();

  assert.equal(playlistButtons(harness)[0].disabled, false);
  assert.equal(harness.likedLoadButton.disabled, false);
});

test("disconnecting clears the Liked Songs section", async () => {
  const harness = createHarness({
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    likedHandler: steadyLikedHandler(50, ["spotify:track:a"])
  });

  await settle();
  harness.likedLoadButton.click();
  await settle();
  assert.match(harness.likedStatusElement.textContent, /^Loaded 1 track in \d+\.\ds\.$/);

  harness.logoutButton.click();

  assert.equal(harness.likedStatusElement.hidden, true);
  assert.equal(harness.likedStatusElement.textContent, "");
  assert.equal(harness.likedConnectButton.hidden, true);
  assert.equal(harness.likedLoadButton.hidden, true);
});

// A working write-path world for one liked library: profile, playlist
// creation, batch appends (recorded), and the final total verification.
function shuffleWorld(likedURIs) {
  const world = {appendedBatches: [], createBodies: []};
  world.options = {
    localStorage: new FakeStorage({[tokenStorageKey]: JSON.stringify(likedToken())}),
    likedHandler: steadyLikedHandler(50, likedURIs),
    meHandler: () => jsonResponse(200, {id: "user-1"}),
    createPlaylistHandler: (url, requestOptions) => {
      assert.equal(url, "https://api.spotify.com/v1/users/user-1/playlists");
      assert.equal(requestOptions.method, "POST");
      const body = JSON.parse(requestOptions.body);
      world.createBodies.push(body);
      return jsonResponse(200, {id: "new-pl", name: body.name});
    },
    trackHandler: (url, requestOptions) => {
      if (url === "https://api.spotify.com/v1/playlists/new-pl/tracks") {
        assert.equal(requestOptions.method, "POST");
        world.appendedBatches.push(JSON.parse(requestOptions.body).uris);
        return jsonResponse(201, {snapshot_id: "write-snap"});
      }
      if (url === "https://api.spotify.com/v1/playlists/new-pl?fields=tracks.total") {
        const written = world.appendedBatches.reduce((sum, batch) => sum + batch.length, 0);
        return jsonResponse(200, {tracks: {total: written}});
      }
      throw new Error("unexpected playlist request: " + url);
    }
  };
  return world;
}

async function loadLiked(harness) {
  await settle();
  harness.likedLoadButton.click();
  await settle();
}

test("shuffling Liked Songs creates one new private playlist with every track", async () => {
  const uris = ["spotify:track:a", "spotify:track:b", "spotify:track:c"];
  const world = shuffleWorld(uris);
  const harness = createHarness(world.options);

  await loadLiked(harness);
  assert.equal(harness.likedShuffleButton.hidden, false, "the shuffle action appears after a load");

  harness.likedShuffleButton.click();
  await settle();

  assert.equal(world.createBodies.length, 1, "exactly one playlist is created");
  assert.match(world.createBodies[0].name, /^Liked Shuffle \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(world.createBodies[0].public, false);
  assert.equal(world.appendedBatches.length, 1);
  assert.deepEqual(world.appendedBatches[0].slice().sort(), uris.slice().sort(),
    "the new playlist holds exactly the liked tracks, reordered");
  assert.match(
    harness.likedStatusElement.textContent,
    /^Created "Liked Shuffle .+" with 3 tracks in \d+\.\ds\.$/
  );
  assert.equal(harness.trackProgressElement.hidden, true);
  assert.equal(harness.likedShuffleButton.disabled, false);
});

test("shuffle appends run sequentially in batches of at most 100", async () => {
  const uris = [];
  for (let index = 0; index < 250; index += 1) {
    uris.push("spotify:track:" + index);
  }
  const world = shuffleWorld(uris);
  const harness = createHarness(world.options);

  await loadLiked(harness);
  harness.likedShuffleButton.click();
  await settle();

  assert.deepEqual(world.appendedBatches.map((batch) => batch.length), [100, 100, 50]);
  const written = world.appendedBatches.flat();
  assert.deepEqual(written.slice().sort(), uris.slice().sort());
  assert.match(
    harness.likedStatusElement.textContent,
    /^Created "Liked Shuffle .+" with 250 tracks in \d+\.\ds\.$/
  );
});

test("a failed append names the possibly partial playlist", async () => {
  const uris = [];
  for (let index = 0; index < 150; index += 1) {
    uris.push("spotify:track:" + index);
  }
  const world = shuffleWorld(uris);
  const workingTrackHandler = world.options.trackHandler;
  world.options.trackHandler = (url, requestOptions) => {
    if (url === "https://api.spotify.com/v1/playlists/new-pl/tracks" &&
        world.appendedBatches.length === 1) {
      return jsonResponse(500, {error: {status: 500}});
    }
    return workingTrackHandler(url, requestOptions);
  };
  const harness = createHarness(world.options);

  await loadLiked(harness);
  harness.likedShuffleButton.click();
  await settle();

  assert.match(
    harness.likedStatusElement.textContent,
    /^"Liked Shuffle .+" may be incomplete \(Spotify returned 500 at \/v1\/playlists\/new-pl\/tracks\)\. Delete it in Spotify or shuffle again\.$/
  );
  assert.equal(harness.trackProgressElement.hidden, true);
});

test("a verification shortfall never claims success", async () => {
  const uris = ["spotify:track:a", "spotify:track:b"];
  const world = shuffleWorld(uris);
  const workingTrackHandler = world.options.trackHandler;
  world.options.trackHandler = (url, requestOptions) => {
    if (url === "https://api.spotify.com/v1/playlists/new-pl?fields=tracks.total") {
      return jsonResponse(200, {tracks: {total: 1}});
    }
    return workingTrackHandler(url, requestOptions);
  };
  const harness = createHarness(world.options);

  await loadLiked(harness);
  harness.likedShuffleButton.click();
  await settle();

  assert.match(harness.likedStatusElement.textContent, /may be incomplete/);
});

test("a library above the playlist cap writes nothing", async () => {
  const uris = [];
  for (let index = 0; index < 10001; index += 1) {
    uris.push("spotify:track:" + index);
  }
  const world = shuffleWorld(uris);
  const harness = createHarness(world.options);

  await loadLiked(harness);
  assert.match(harness.likedStatusElement.textContent, /^Loaded 10001 tracks in \d+\.\ds\.$/);

  harness.likedShuffleButton.click();
  await settle();

  assert.equal(
    harness.likedStatusElement.textContent,
    "Liked Songs holds more than 10,000 tracks, the most a playlist can contain."
  );
  assert.equal(world.createBodies.length, 0);
  assert.equal(world.appendedBatches.length, 0);
});

test("an empty library never offers the shuffle action", async () => {
  const world = shuffleWorld([]);
  const harness = createHarness(world.options);

  await loadLiked(harness);

  assert.match(harness.likedStatusElement.textContent, /^Loaded 0 tracks in \d+\.\ds\.$/);
  assert.equal(harness.likedShuffleButton.hidden, true);
});

test("a token without the write scope is offered reconnection before any write", async () => {
  const world = shuffleWorld(["spotify:track:a"]);
  world.options.localStorage = new FakeStorage({
    [tokenStorageKey]: JSON.stringify(Object.assign(currentToken(), {
      scope: "playlist-read-private user-library-read"
    }))
  });
  const harness = createHarness(world.options);

  await loadLiked(harness);
  assert.equal(harness.likedShuffleButton.hidden, false);

  harness.likedShuffleButton.click();
  await settle();

  assert.equal(harness.likedStatusElement.textContent, "Reconnect Spotify to allow creating playlists.");
  assert.equal(harness.likedConnectButton.hidden, false);
  assert.equal(world.createBodies.length, 0, "no playlist is created without the scope");
  assert.equal(
    harness.requests.every((request) => request.url !== "https://api.spotify.com/v1/me"),
    true,
    "no write-path request is issued without the scope"
  );
});
