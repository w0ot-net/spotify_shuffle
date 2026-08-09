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
  const playlistsElement = new FakeElement(true);
  const elements = {
    status: statusElement,
    connect: connectButton,
    logout: logoutButton,
    "playlist-status": playlistStatusElement,
    "track-status": trackStatusElement,
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
    trackStatusElement: trackStatusElement
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
  assert.equal(harness.trackStatusElement.textContent, "Loaded 1 track.");

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
  assert.equal(harness.trackStatusElement.textContent, "Loaded 1 track.");

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

  assert.equal(harness.trackStatusElement.textContent, "Loaded 250 tracks.");
  assert.equal(harness.trackStatusElement.hidden, false);
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

  assert.equal(harness.trackStatusElement.textContent, "Loaded 0 tracks.");
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

  deferredByOffset.get(3).resolve(trackPageResponse(1, 8, [uris[3]]));
  await settle();
  assert.ok(deferredByOffset.has(7), "a freed slot dispatches the next page");

  for (const offset of [7, 1, 6, 2, 5, 4]) {
    deferredByOffset.get(offset).resolve(trackPageResponse(1, 8, [uris[offset]]));
  }
  await settle();

  assert.equal(harness.trackStatusElement.textContent, "Loaded 8 tracks.");
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
    "Tracks could not be loaded. Select the playlist again to retry."
  );
  assert.equal(localStorage.getItem(tokenStorageKey), rawToken);
  assert.equal(harness.playlistsElement.hidden, false);
  assert.equal(harness.statusElement.textContent, "Spotify is connected in this browser.");
  assert.equal(playlistButtons(harness)[0].disabled, false);
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
