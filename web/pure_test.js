"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// The module must evaluate with nothing injected: an empty context proves it
// depends on no browser or platform interface.
const context = vm.createContext({});
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "pure.js"), "utf8"),
  context,
  {filename: "web/pure.js"}
);
const TrueShuffle = context.TrueShuffle;

const now = 1770000000000;

// Objects built inside the vm realm carry that realm's prototypes, which
// strict deep equality rejects; compare plain content instead.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function tokenPayload(overrides) {
  return Object.assign({
    access_token: "access-token",
    refresh_token: "refresh-token",
    token_type: "Bearer",
    scope: "playlist-read-private",
    expires_in: 3600
  }, overrides);
}

test("module exposes one global with the expected members", () => {
  assert.deepEqual(Object.keys(context), ["TrueShuffle"]);
  assert.ok(new TrueShuffle.AuthorizationRevokedError("x") instanceof TrueShuffle.TokenRejectedError,
    "revocation must remain a rejection subtype for app.js catch logic");
});

test("playlistLabel pluralizes and omits unknown totals", () => {
  assert.equal(TrueShuffle.playlistLabel({name: "Morning", total: 1}), "Morning (1 track)");
  assert.equal(TrueShuffle.playlistLabel({name: "Morning", total: 0}), "Morning (0 tracks)");
  assert.equal(TrueShuffle.playlistLabel({name: "Morning", total: 4212}), "Morning (4212 tracks)");
  assert.equal(TrueShuffle.playlistLabel({name: "Morning", total: null}), "Morning");
});

test("readPlaylistPage parses items and skips null placeholders", () => {
  assert.deepEqual(plain(TrueShuffle.readPlaylistPage({
    items: [
      {id: "first", name: "Morning", tracks: {total: 3}},
      null,
      {id: "", name: "unexposed"},
      {id: "second", name: "", tracks: {total: "many"}},
      {id: "third"}
    ]
  })), [
    {id: "first", name: "Morning", total: 3},
    {id: "second", name: "Untitled playlist", total: null},
    {id: "third", name: "Untitled playlist", total: null}
  ]);
});

test("readPlaylistPage rejects malformed payloads", () => {
  for (const payload of [null, undefined, {}, {items: "x"}, {items: {}}]) {
    assert.throws(() => TrueShuffle.readPlaylistPage(payload), /invalid playlist page/);
  }
});

test("validPlaylistCursor accepts only same-endpoint query cursors", () => {
  const endpoint = TrueShuffle.playlistsEndpoint;
  assert.equal(TrueShuffle.validPlaylistCursor(endpoint + "?offset=50&limit=50"), true);
  assert.equal(TrueShuffle.validPlaylistCursor(endpoint), false);
  assert.equal(TrueShuffle.validPlaylistCursor(endpoint + "/extra?offset=50"), false);
  assert.equal(TrueShuffle.validPlaylistCursor("https://attacker.example/v1/me/playlists?offset=50"), false);
  assert.equal(TrueShuffle.validPlaylistCursor("http://api.spotify.com/v1/me/playlists?offset=50"), false);
});

test("track URLs are built on the API origin with the id encoded", () => {
  assert.equal(
    TrueShuffle.playlistSnapshotURL("abc123"),
    "https://api.spotify.com/v1/playlists/abc123?fields=snapshot_id"
  );
  assert.equal(
    TrueShuffle.playlistSnapshotURL("a/b?c#d"),
    "https://api.spotify.com/v1/playlists/a%2Fb%3Fc%23d?fields=snapshot_id"
  );
  assert.equal(
    TrueShuffle.trackPageURL("abc123", 200),
    "https://api.spotify.com/v1/playlists/abc123/tracks" +
      "?fields=limit,total,items(track(uri))&limit=100&offset=200"
  );
  assert.equal(
    TrueShuffle.trackPageURL("a/b?c#d", 0),
    "https://api.spotify.com/v1/playlists/a%2Fb%3Fc%23d/tracks" +
      "?fields=limit,total,items(track(uri))&limit=100&offset=0"
  );
});

test("readPlaylistSnapshot requires a non-empty snapshot string", () => {
  assert.equal(TrueShuffle.readPlaylistSnapshot({snapshot_id: "snap-1"}), "snap-1");
  for (const payload of [null, undefined, {}, {snapshot_id: ""}, {snapshot_id: 7}]) {
    assert.throws(() => TrueShuffle.readPlaylistSnapshot(payload), /invalid playlist snapshot/);
  }
});

test("readTrackPage keeps URIs and counts every raw item", () => {
  const page = TrueShuffle.readTrackPage({
    limit: 100,
    total: 250,
    items: [
      {track: {uri: "spotify:track:a"}},
      null,
      {track: null},
      {track: {uri: ""}},
      {track: {uri: 7}},
      {track: {uri: "spotify:track:b"}}
    ]
  });
  assert.equal(page.limit, 100);
  assert.equal(page.total, 250);
  assert.equal(page.count, 6, "skipped items still count toward completeness");
  assert.deepEqual(plain(page.uris), ["spotify:track:a", "spotify:track:b"]);
});

test("readTrackPage rejects malformed payloads", () => {
  const valid = {limit: 100, total: 0, items: []};
  const cases = [
    null,
    undefined,
    {},
    Object.assign({}, valid, {items: "x"}),
    Object.assign({}, valid, {limit: 0}),
    Object.assign({}, valid, {limit: "100"}),
    Object.assign({}, valid, {limit: 1.5}),
    Object.assign({}, valid, {total: -1}),
    Object.assign({}, valid, {total: "250"})
  ];
  for (const payload of cases) {
    assert.throws(() => TrueShuffle.readTrackPage(payload), /invalid track page/);
  }
});

test("remainingTrackOffsets steps by the echoed limit below the cap", () => {
  assert.deepEqual(plain(TrueShuffle.remainingTrackOffsets(100, 0)), []);
  assert.deepEqual(plain(TrueShuffle.remainingTrackOffsets(100, 100)), []);
  assert.deepEqual(plain(TrueShuffle.remainingTrackOffsets(100, 101)), [100]);
  assert.deepEqual(plain(TrueShuffle.remainingTrackOffsets(100, 250)), [100, 200]);
  assert.deepEqual(plain(TrueShuffle.remainingTrackOffsets(50, 150)), [50, 100]);
  assert.equal(TrueShuffle.remainingTrackOffsets(100, 10000).length, 99);
  assert.throws(
    () => TrueShuffle.remainingTrackOffsets(100, 10001),
    /more tracks than a playlist can hold/
  );
});

test("assembleTrackPages orders by offset regardless of input order", () => {
  const uris = TrueShuffle.assembleTrackPages([
    {offset: 200, count: 1, uris: ["spotify:track:e"]},
    {offset: 0, count: 2, uris: ["spotify:track:a", "spotify:track:b"]},
    {offset: 100, count: 2, uris: ["spotify:track:c", "spotify:track:a"]}
  ], 5);
  assert.deepEqual(plain(uris), [
    "spotify:track:a",
    "spotify:track:b",
    "spotify:track:c",
    "spotify:track:a",
    "spotify:track:e"
  ]);
  assert.deepEqual(plain(TrueShuffle.assembleTrackPages([], 0)), []);
});

test("assembleTrackPages fails a count short of the reported total", () => {
  // A skipped URI-less item still counts, so only a genuinely short or long
  // read -- a mutation mid-flight -- can trip the check.
  assert.deepEqual(plain(TrueShuffle.assembleTrackPages(
    [{offset: 0, count: 2, uris: ["spotify:track:a"]}], 2
  )), ["spotify:track:a"]);
  for (const total of [1, 3]) {
    assert.throws(
      () => TrueShuffle.assembleTrackPages([{offset: 0, count: 2, uris: []}], total),
      TrueShuffle.PlaylistChangedError
    );
  }
});

test("validTokenRecord requires every field with its exact type", () => {
  const valid = {
    access_token: "a",
    refresh_token: "r",
    token_type: "Bearer",
    scope: "",
    expires_at: now
  };
  assert.equal(TrueShuffle.validTokenRecord(valid), true);
  assert.equal(TrueShuffle.validTokenRecord(null), false);
  assert.equal(TrueShuffle.validTokenRecord("record"), false);
  for (const field of ["access_token", "refresh_token", "token_type"]) {
    assert.equal(TrueShuffle.validTokenRecord(Object.assign({}, valid, {[field]: ""})), false, field);
  }
  assert.equal(TrueShuffle.validTokenRecord(Object.assign({}, valid, {scope: null})), false);
  assert.equal(TrueShuffle.validTokenRecord(Object.assign({}, valid, {expires_at: Infinity})), false);
  assert.equal(TrueShuffle.validTokenRecord(Object.assign({}, valid, {expires_at: "soon"})), false);
});

test("buildTokenRecord computes expiry from the supplied time", () => {
  const record = TrueShuffle.buildTokenRecord(tokenPayload(), null, now);
  assert.deepEqual(plain(record), {
    access_token: "access-token",
    refresh_token: "refresh-token",
    token_type: "Bearer",
    scope: "playlist-read-private",
    expires_at: now + (3600 * 1000)
  });
});

test("buildTokenRecord preserves omitted fields from the previous token", () => {
  const previous = {
    access_token: "old-access",
    refresh_token: "saved-refresh",
    token_type: "Bearer",
    scope: "playlist-read-private",
    expires_at: now - 1000
  };
  const record = TrueShuffle.buildTokenRecord(
    {access_token: "new-access", expires_in: 60},
    previous,
    now
  );
  assert.equal(record.refresh_token, "saved-refresh");
  assert.equal(record.token_type, "Bearer");
  assert.equal(record.scope, "playlist-read-private");
  assert.equal(record.expires_at, now + (60 * 1000));
});

test("buildTokenRecord rejects incomplete responses as TokenRejectedError", () => {
  const cases = [
    tokenPayload({access_token: ""}),
    tokenPayload({expires_in: 0}),
    tokenPayload({expires_in: "3600"}),
    tokenPayload({expires_in: Infinity}),
    {access_token: "a", expires_in: 60}
  ];
  for (const payload of cases) {
    assert.throws(
      () => TrueShuffle.buildTokenRecord(payload, null, now),
      TrueShuffle.TokenRejectedError
    );
  }
});
