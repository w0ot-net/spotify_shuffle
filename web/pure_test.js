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
