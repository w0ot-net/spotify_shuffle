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
      {id: "first", name: "Morning", items: {total: 3}, snapshot_id: "snap-1"},
      null,
      {id: "", name: "unexposed"},
      {id: "second", name: "", items: {total: "many"}, snapshot_id: ""},
      {id: "third", snapshot_id: 7}
    ]
  })), [
    {id: "first", name: "Morning", total: 3, snapshotId: "snap-1"},
    {id: "second", name: "Untitled playlist", total: null, snapshotId: null},
    {id: "third", name: "Untitled playlist", total: null, snapshotId: null}
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
    "https://api.spotify.com/v1/playlists/abc123/items" +
      "?fields=limit,total,items(item(uri))&limit=50&offset=200"
  );
  assert.equal(
    TrueShuffle.trackPageURL("a/b?c#d", 0),
    "https://api.spotify.com/v1/playlists/a%2Fb%3Fc%23d/items" +
      "?fields=limit,total,items(item(uri))&limit=50&offset=0"
  );
});

test("readPlaylistSnapshot requires a non-empty snapshot string", () => {
  assert.equal(TrueShuffle.readPlaylistSnapshot({snapshot_id: "snap-1"}), "snap-1");
  for (const payload of [null, undefined, {}, {snapshot_id: ""}, {snapshot_id: 7}]) {
    assert.throws(() => TrueShuffle.readPlaylistSnapshot(payload), /invalid playlist snapshot/);
  }
});

test("readPlaylistItemPage keeps URIs and counts every raw item", () => {
  const page = TrueShuffle.readPlaylistItemPage({
    limit: 50,
    total: 250,
    items: [
      {item: {uri: "spotify:track:a"}},
      null,
      {item: null},
      {item: {uri: ""}},
      {item: {uri: 7}},
      {item: {uri: "spotify:track:b"}}
    ]
  });
  assert.equal(page.limit, 50);
  assert.equal(page.total, 250);
  assert.equal(page.count, 6, "skipped items still count toward completeness");
  assert.deepEqual(plain(page.uris), ["spotify:track:a", "spotify:track:b"]);
});

test("playlist and saved-track page readers select their respective item fields", () => {
  const payload = {
    limit: 50,
    total: 1,
    items: [{item: {uri: "spotify:track:playlist"}, track: {uri: "spotify:track:liked"}}]
  };
  assert.deepEqual(plain(TrueShuffle.readPlaylistItemPage(payload).uris), ["spotify:track:playlist"]);
  assert.deepEqual(plain(TrueShuffle.readLikedTrackPage(payload).uris), ["spotify:track:liked"]);
});

test("track page readers reject malformed payloads", () => {
  const valid = {limit: 50, total: 0, items: []};
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
    assert.throws(() => TrueShuffle.readPlaylistItemPage(payload), /invalid track page/);
    assert.throws(() => TrueShuffle.readLikedTrackPage(payload), /invalid track page/);
  }
});

test("remainingTrackOffsets steps by the echoed limit below the caller's cap", () => {
  const cap = TrueShuffle.maxPlaylistTracks;
  assert.equal(cap, 10000);
  assert.deepEqual(plain(TrueShuffle.remainingTrackOffsets(100, 0, cap)), []);
  assert.deepEqual(plain(TrueShuffle.remainingTrackOffsets(100, 100, cap)), []);
  assert.deepEqual(plain(TrueShuffle.remainingTrackOffsets(100, 101, cap)), [100]);
  assert.deepEqual(plain(TrueShuffle.remainingTrackOffsets(100, 250, cap)), [100, 200]);
  assert.deepEqual(plain(TrueShuffle.remainingTrackOffsets(50, 150, cap)), [50, 100]);
  assert.equal(TrueShuffle.remainingTrackOffsets(100, 10000, cap).length, 99);
  assert.throws(
    () => TrueShuffle.remainingTrackOffsets(100, 10001, cap),
    /more tracks than this read allows/
  );
  // The uncapped liked-songs read passes a maximum of its own.
  assert.equal(
    TrueShuffle.remainingTrackOffsets(50, 10001, Number.MAX_SAFE_INTEGER).length,
    200
  );
});

test("likedPageURL addresses the saved-tracks endpoint by offset", () => {
  assert.equal(
    TrueShuffle.likedPageURL(0),
    "https://api.spotify.com/v1/me/tracks?limit=50&offset=0"
  );
  assert.equal(
    TrueShuffle.likedPageURL(4150),
    "https://api.spotify.com/v1/me/tracks?limit=50&offset=4150"
  );
});

test("hasScope matches whole scope words only", () => {
  assert.equal(TrueShuffle.hasScope("playlist-read-private user-library-read", "user-library-read"), true);
  assert.equal(TrueShuffle.hasScope("user-library-read", "user-library-read"), true);
  assert.equal(TrueShuffle.hasScope("", "user-library-read"), false);
  assert.equal(TrueShuffle.hasScope("playlist-read-private", "user-library-read"), false);
  assert.equal(TrueShuffle.hasScope("user-library-read-extra", "user-library-read"), false);
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

test("loadedTracksMessage composes count, duration, and changes", () => {
  assert.equal(TrueShuffle.loadedTracksMessage(1, null, null), "Loaded 1 track.");
  assert.equal(TrueShuffle.loadedTracksMessage(0, null, null), "Loaded 0 tracks.");
  assert.equal(TrueShuffle.loadedTracksMessage(4212, 3760, null), "Loaded 4212 tracks in 3.8s.");
  assert.equal(TrueShuffle.loadedTracksMessage(1, 0, null), "Loaded 1 track in 0.0s.");
  assert.equal(TrueShuffle.loadedTracksMessage(2, 60049, null), "Loaded 2 tracks in 60.0s.");
  assert.equal(TrueShuffle.loadedTracksMessage(2, -5, null), "Loaded 2 tracks in 0.0s.",
    "a non-monotonic clock never renders a negative duration");
  assert.equal(
    TrueShuffle.loadedTracksMessage(3, 2100, {added: 2, removed: 1}),
    "Loaded 3 tracks in 2.1s. 2 added, 1 removed since last read."
  );
  assert.equal(
    TrueShuffle.loadedTracksMessage(3, 2100, {added: 0, removed: 0}),
    "Loaded 3 tracks in 2.1s.",
    "a membership-identical change renders the plain form"
  );
  assert.equal(
    TrueShuffle.loadedTracksMessage(2, null, {added: 1, removed: 0}),
    "Loaded 2 tracks. 1 added, 0 removed since last read."
  );
});

test("validTrackCacheRecord requires the exact record shape", () => {
  const valid = {
    snapshot_id: "snap-1",
    uris: ["spotify:track:a", "spotify:track:a"],
    cached_at: now
  };
  assert.equal(TrueShuffle.validTrackCacheRecord(valid), true);
  assert.equal(TrueShuffle.validTrackCacheRecord(
    Object.assign({}, valid, {uris: []})), true);
  assert.equal(TrueShuffle.validTrackCacheRecord(null), false);
  assert.equal(TrueShuffle.validTrackCacheRecord(undefined), false);
  assert.equal(TrueShuffle.validTrackCacheRecord("record"), false);
  assert.equal(TrueShuffle.validTrackCacheRecord(
    Object.assign({}, valid, {snapshot_id: ""})), false);
  assert.equal(TrueShuffle.validTrackCacheRecord(
    Object.assign({}, valid, {uris: "spotify:track:a"})), false);
  assert.equal(TrueShuffle.validTrackCacheRecord(
    Object.assign({}, valid, {uris: ["spotify:track:a", 7]})), false);
  assert.equal(TrueShuffle.validTrackCacheRecord(
    Object.assign({}, valid, {cached_at: Infinity})), false);
  assert.equal(TrueShuffle.validTrackCacheRecord(
    Object.assign({}, valid, {cached_at: "soon"})), false);
});

test("validLikedCacheRecord requires the exact record shape", () => {
  const valid = {
    total: 2,
    head: ["spotify:track:a", "spotify:track:b"],
    uris: ["spotify:track:a", "spotify:track:b"],
    cached_at: now
  };
  assert.equal(TrueShuffle.validLikedCacheRecord(valid), true);
  assert.equal(TrueShuffle.validLikedCacheRecord(
    Object.assign({}, valid, {total: 0, head: [], uris: []})), true);
  assert.equal(TrueShuffle.validLikedCacheRecord(null), false);
  assert.equal(TrueShuffle.validLikedCacheRecord(undefined), false);
  assert.equal(TrueShuffle.validLikedCacheRecord(
    Object.assign({}, valid, {total: -1})), false);
  assert.equal(TrueShuffle.validLikedCacheRecord(
    Object.assign({}, valid, {total: 2.5})), false);
  assert.equal(TrueShuffle.validLikedCacheRecord(
    Object.assign({}, valid, {head: "spotify:track:a"})), false);
  assert.equal(TrueShuffle.validLikedCacheRecord(
    Object.assign({}, valid, {head: ["spotify:track:a", 7]})), false);
  assert.equal(TrueShuffle.validLikedCacheRecord(
    Object.assign({}, valid, {uris: ["spotify:track:a", 7]})), false);
  assert.equal(TrueShuffle.validLikedCacheRecord(
    Object.assign({}, valid, {cached_at: Infinity})), false);
});

test("likedRecordMatches compares the total and the newest page exactly", () => {
  const record = {total: 60, head: ["spotify:track:a", "spotify:track:b"]};
  const samePage = {total: 60, uris: ["spotify:track:a", "spotify:track:b"]};
  assert.equal(TrueShuffle.likedRecordMatches(record, samePage), true);
  // A removal moves the total.
  assert.equal(TrueShuffle.likedRecordMatches(
    record, {total: 59, uris: ["spotify:track:a", "spotify:track:b"]}), false);
  // A count-neutral swap moves the head even though the total held still.
  assert.equal(TrueShuffle.likedRecordMatches(
    record, {total: 60, uris: ["spotify:track:c", "spotify:track:a"]}), false);
  // A re-like reorders the head without changing membership; that is a
  // change of the newest page and invalidates.
  assert.equal(TrueShuffle.likedRecordMatches(
    record, {total: 60, uris: ["spotify:track:b", "spotify:track:a"]}), false);
  assert.equal(TrueShuffle.likedRecordMatches(
    record, {total: 60, uris: ["spotify:track:a"]}), false);
  const empty = {total: 0, head: []};
  assert.equal(TrueShuffle.likedRecordMatches(empty, {total: 0, uris: []}), true);
});

test("countTrackChanges counts a duplicate-aware multiset difference", () => {
  const changes = (previous, current) => plain(TrueShuffle.countTrackChanges(previous, current));
  assert.deepEqual(changes([], []), {added: 0, removed: 0});
  assert.deepEqual(changes([], ["a", "b"]), {added: 2, removed: 0});
  assert.deepEqual(changes(["a", "b"], []), {added: 0, removed: 2});
  assert.deepEqual(changes(["a", "b"], ["b", "a"]), {added: 0, removed: 0},
    "a reorder is not a membership change");
  assert.deepEqual(changes(["a", "b"], ["a", "b", "c"]), {added: 1, removed: 0});
  assert.deepEqual(changes(["a", "b", "c"], ["a", "c"]), {added: 0, removed: 1});
  // Duplicates in both directions: the counts compare occurrences.
  assert.deepEqual(changes(["a", "a", "b"], ["a", "b", "b"]), {added: 1, removed: 1});
  assert.deepEqual(changes(["a"], ["a", "a", "a"]), {added: 2, removed: 0});
  assert.deepEqual(changes(["a", "a", "a"], ["a"]), {added: 0, removed: 2});
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

test("write-path URLs are built on the API origin with ids encoded", () => {
  assert.equal(
    TrueShuffle.createPlaylistURL(),
    "https://api.spotify.com/v1/me/playlists"
  );
  assert.equal(
    TrueShuffle.addTracksURL("pl?1"),
    "https://api.spotify.com/v1/playlists/pl%3F1/items"
  );
  assert.equal(
    TrueShuffle.playlistTotalURL("pl1"),
    "https://api.spotify.com/v1/playlists/pl1?fields=items.total"
  );
});

test("write-path readers validate their payloads", () => {
  assert.deepEqual(
    plain(TrueShuffle.readCreatedPlaylist({id: "pl-1", name: "Liked Shuffle"})),
    {id: "pl-1", name: "Liked Shuffle"}
  );
  assert.equal(TrueShuffle.readCreatedPlaylist({id: "pl-1", name: ""}).name, "New playlist");
  for (const payload of [null, {}, {id: ""}, {name: "x"}]) {
    assert.throws(() => TrueShuffle.readCreatedPlaylist(payload), /invalid created playlist/);
  }

  assert.equal(TrueShuffle.readPlaylistTotal({items: {total: 0}}), 0);
  assert.equal(TrueShuffle.readPlaylistTotal({items: {total: 4212}}), 4212);
  for (const payload of [null, {}, {items: {}}, {items: {total: -1}}, {items: {total: "3"}}]) {
    assert.throws(() => TrueShuffle.readPlaylistTotal(payload), /invalid playlist total/);
  }
});

test("shuffledURIs applies Fisher-Yates with the injected randomness", () => {
  const sequence = [2, 1, 1];
  const shuffled = TrueShuffle.shuffledURIs(["a", "b", "c", "d"], () => sequence.shift());
  assert.deepEqual(plain(shuffled), ["a", "d", "b", "c"]);
  assert.equal(sequence.length, 0, "one draw per Fisher-Yates step");
});

test("shuffledURIs preserves the multiset and the source array", () => {
  const source = ["a", "b", "a", "c", "b", "a"];
  const copy = source.slice();
  const shuffled = TrueShuffle.shuffledURIs(source, (n) => n - 1);
  assert.deepEqual(plain(source), copy, "the input is never mutated");
  assert.deepEqual(plain(shuffled).slice().sort(), copy.slice().sort());
  assert.deepEqual(plain(TrueShuffle.shuffledURIs([], () => 0)), []);
  assert.deepEqual(plain(TrueShuffle.shuffledURIs(["only"], () => 0)), ["only"]);
});

test("shuffledURIs rejects invalid randomness", () => {
  for (const bad of [() => -1, (n) => n, () => 0.5, () => "0"]) {
    assert.throws(
      () => TrueShuffle.shuffledURIs(["a", "b"], bad),
      /invalid index/
    );
  }
});

test("uriBatches splits at 100 preserving order", () => {
  assert.deepEqual(plain(TrueShuffle.uriBatches([])), []);
  const uris = [];
  for (let index = 0; index < 201; index += 1) {
    uris.push("u" + index);
  }
  assert.deepEqual(plain(TrueShuffle.uriBatches(uris.slice(0, 100))), [uris.slice(0, 100)]);
  const batches = TrueShuffle.uriBatches(uris);
  assert.deepEqual(plain(batches.map((batch) => batch.length)), [100, 100, 1]);
  assert.deepEqual(plain(batches[0][0]), "u0");
  assert.deepEqual(plain(batches[1][0]), "u100");
  assert.deepEqual(plain(batches[2][0]), "u200");
});

test("derivedPlaylistName appends the ownership suffix", () => {
  assert.equal(TrueShuffle.derivedPlaylistName("Liked Songs"), "Liked Songs TrueShuffle");
  assert.equal(TrueShuffle.derivedPlaylistName("Road trip!"), "Road trip! TrueShuffle");
  assert.equal(TrueShuffle.derivedPlaylistName(""), " TrueShuffle");
});

test("findPlaylistByName matches exactly and returns the first hit", () => {
  const playlists = [
    {id: "a", name: "Morning TrueShuffle"},
    {id: "b", name: "morning trueshuffle"},
    {id: "c", name: "Morning TrueShuffle"}
  ];
  assert.equal(TrueShuffle.findPlaylistByName(playlists, "Morning TrueShuffle").id, "a",
    "the first exact match wins");
  assert.equal(TrueShuffle.findPlaylistByName(playlists, "MORNING TRUESHUFFLE"), null,
    "matching is case-sensitive");
  assert.equal(TrueShuffle.findPlaylistByName(playlists, "Evening TrueShuffle"), null);
  assert.equal(TrueShuffle.findPlaylistByName([], "Morning TrueShuffle"), null);
});

test("shuffleResultMessage distinguishes created from updated", () => {
  assert.equal(
    TrueShuffle.shuffleResultMessage(true, "Liked Songs TrueShuffle", 4212, 8160),
    "Created \"Liked Songs TrueShuffle\" with 4212 tracks in 8.2s."
  );
  assert.equal(
    TrueShuffle.shuffleResultMessage(false, "Liked Songs TrueShuffle", 1, 0),
    "Updated \"Liked Songs TrueShuffle\" with 1 track in 0.0s."
  );
  assert.equal(
    TrueShuffle.shuffleResultMessage(false, "X", 2, -9),
    "Updated \"X\" with 2 tracks in 0.0s."
  );
});

test("SpotifyRequestError carries the status, path, and Spotify's message", () => {
  const error = new TrueShuffle.SpotifyRequestError(403, "/v1/me", "Insufficient client scope");
  assert.equal(error.status, 403);
  assert.equal(error.path, "/v1/me");
  assert.equal(error.detail, "Insufficient client scope");
  assert.equal(
    error.message,
    "Spotify request failed with status 403 at /v1/me: Insufficient client scope"
  );
  const bare = new TrueShuffle.SpotifyRequestError(429);
  assert.equal(bare.path, "");
  assert.equal(bare.detail, "");
  assert.equal(bare.message, "Spotify request failed with status 429");
  assert.equal(
    error instanceof TrueShuffle.PlaylistChangedError, false,
    "status failures must not render as changed-while-loading"
  );
});

test("displayedPlaylists hides derived names and keeps near misses", () => {
  const playlists = [
    {id: "a", name: "Morning"},
    {id: "b", name: "Morning TrueShuffle"},
    {id: "c", name: "TrueShuffle"},
    {id: "d", name: "Morning TrueShuffle Backup"},
    {id: "e", name: " TrueShuffle"}
  ];
  const displayed = TrueShuffle.displayedPlaylists(playlists);
  assert.deepEqual(
    plain(displayed.playlists).map((playlist) => playlist.id),
    ["a", "c", "d"],
    "only names ending with the derived suffix are hidden"
  );
  assert.equal(displayed.shadowedCount, 0, "derived hiding is routine and uncounted");
  assert.equal(playlists.length, 5, "the retained listing itself is untouched");
});

test("displayedPlaylists keeps the first instance of each name and counts the shadowed", () => {
  const playlists = [
    {id: "a", name: "Morning"},
    {id: "b", name: "Liked Songs"},
    {id: "c", name: "Morning"},
    {id: "d", name: "Evening"},
    {id: "e", name: "Morning"}
  ];
  const displayed = TrueShuffle.displayedPlaylists(playlists);
  assert.deepEqual(
    plain(displayed.playlists).map((playlist) => playlist.id),
    ["a", "d"],
    "first instance wins; the liked row counts as the first \"Liked Songs\""
  );
  assert.equal(displayed.shadowedCount, 3);
});

test("shadowedRowsNote renders exactly when something was shadowed", () => {
  assert.equal(TrueShuffle.shadowedRowsNote(0), "");
  assert.equal(
    TrueShuffle.shadowedRowsNote(1),
    "1 playlist with a duplicate name is hidden; rename it in Spotify to shuffle it."
  );
  assert.equal(
    TrueShuffle.shadowedRowsNote(3),
    "3 playlists with duplicate names are hidden; rename them in Spotify to shuffle them."
  );
});

test("likedRowLabel names the reconnect gate", () => {
  assert.equal(TrueShuffle.likedRowLabel(true), "Liked Songs");
  assert.equal(TrueShuffle.likedRowLabel(false), "Liked Songs (reconnect Spotify to enable)");
});

test("emptySourceMessage names the source", () => {
  assert.equal(TrueShuffle.emptySourceMessage("Liked Songs"), "\"Liked Songs\" has no tracks to shuffle.");
});

test("trackChangesSuffix is empty for no change and names the counts otherwise", () => {
  assert.equal(TrueShuffle.trackChangesSuffix(null), "");
  assert.equal(TrueShuffle.trackChangesSuffix({added: 0, removed: 0}), "");
  assert.equal(TrueShuffle.trackChangesSuffix({added: 2, removed: 1}), " 2 added, 1 removed since last read.");
});

test("telemetryEndpointClass maps every role and rejects unknown ones", () => {
  assert.equal(TrueShuffle.telemetryEndpointClass("playlist-list-page"), "playlists");
  assert.equal(TrueShuffle.telemetryEndpointClass("playlist-snapshot-pin"), "playlist-metadata");
  assert.equal(TrueShuffle.telemetryEndpointClass("playlist-snapshot-verify"), "playlist-metadata");
  assert.equal(TrueShuffle.telemetryEndpointClass("playlist-items-page"), "playlist-items");
  assert.equal(TrueShuffle.telemetryEndpointClass("liked-fingerprint-open"), "liked-tracks");
  assert.equal(TrueShuffle.telemetryEndpointClass("liked-items-page"), "liked-tracks");
  assert.equal(TrueShuffle.telemetryEndpointClass("liked-fingerprint-verify"), "liked-tracks");
  assert.equal(TrueShuffle.telemetryEndpointClass("target-create"), "playlists");
  assert.equal(TrueShuffle.telemetryEndpointClass("target-replace"), "playlist-items");
  assert.equal(TrueShuffle.telemetryEndpointClass("target-append"), "playlist-items");
  assert.equal(TrueShuffle.telemetryEndpointClass("target-total-verify"), "playlist-metadata");
  assert.throws(() => TrueShuffle.telemetryEndpointClass("surprise"), /unknown telemetry request role/);
});

test("normalizeRetryAfter accepts only a plain bounded delta", () => {
  assert.deepEqual(plain(TrueShuffle.normalizeRetryAfter(null)), {state: "absent", seconds: null});
  assert.deepEqual(plain(TrueShuffle.normalizeRetryAfter(undefined)), {state: "absent", seconds: null});
  assert.deepEqual(plain(TrueShuffle.normalizeRetryAfter("")), {state: "absent", seconds: null});
  assert.deepEqual(plain(TrueShuffle.normalizeRetryAfter("7")), {state: "valid", seconds: 7});
  assert.deepEqual(plain(TrueShuffle.normalizeRetryAfter(" 30 ")), {state: "valid", seconds: 30});
  assert.deepEqual(plain(TrueShuffle.normalizeRetryAfter("1.5")), {state: "invalid", seconds: null});
  assert.deepEqual(plain(TrueShuffle.normalizeRetryAfter("soon")), {state: "invalid", seconds: null});
  assert.deepEqual(plain(TrueShuffle.normalizeRetryAfter("1234567")), {state: "invalid", seconds: null});
});

test("normalizeSpotifyReason keeps only bounded structured reasons", () => {
  assert.equal(TrueShuffle.normalizeSpotifyReason("QUOTA_EXCEEDED"), "QUOTA_EXCEEDED");
  assert.equal(TrueShuffle.normalizeSpotifyReason("rate limited"), null);
  assert.equal(TrueShuffle.normalizeSpotifyReason("A".repeat(41)), null);
  assert.equal(TrueShuffle.normalizeSpotifyReason(429), null);
  assert.equal(TrueShuffle.normalizeSpotifyReason(null), null);
});

test("normalizeTelemetryCount bounds workload numbers", () => {
  assert.equal(TrueShuffle.normalizeTelemetryCount(0), 0);
  assert.equal(TrueShuffle.normalizeTelemetryCount(1000000), 1000000);
  assert.equal(TrueShuffle.normalizeTelemetryCount(-1), null);
  assert.equal(TrueShuffle.normalizeTelemetryCount(1000001), null);
  assert.equal(TrueShuffle.normalizeTelemetryCount(2.5), null);
  assert.equal(TrueShuffle.normalizeTelemetryCount("3"), null);
});

test("rollingRequestHistory keeps a 30-second window including now", () => {
  const now = 1770000030000;
  const rolled = TrueShuffle.rollingRequestHistory(
    [now - 30000, now - 29999, now - 15000], now
  );
  assert.deepEqual(plain(rolled.starts), [now - 29999, now - 15000, now]);
  assert.equal(rolled.count, 3);
  const empty = TrueShuffle.rollingRequestHistory([], now);
  assert.deepEqual(plain(empty.starts), [now]);
  assert.equal(empty.count, 1);
});

test("truncateTelemetryEvents drops oldest successes before failures", () => {
  const ok = (index) => ({result: "ok", index: index});
  const failed = (index) => ({result: "http-error", index: index});
  const under = TrueShuffle.truncateTelemetryEvents([ok(0), failed(1)], 5);
  assert.equal(under.truncated, false);
  assert.deepEqual(plain(under.events).map((event) => event.index), [0, 1]);

  const over = TrueShuffle.truncateTelemetryEvents(
    [ok(0), failed(1), ok(2), ok(3), failed(4)], 3
  );
  assert.equal(over.truncated, true);
  assert.deepEqual(plain(over.events).map((event) => event.index), [1, 3, 4],
    "oldest successes go first; failures survive");

  const allFailed = TrueShuffle.truncateTelemetryEvents(
    [failed(0), failed(1), failed(2)], 2
  );
  assert.deepEqual(plain(allFailed.events).map((event) => event.index), [1, 2],
    "when only failures remain the oldest are dropped");
});

test("encodeTelemetryReport bounds event count and encoded length", () => {
  const smallReport = {report_id: "r", truncated: false, events: [{result: "ok"}]};
  const small = JSON.parse(TrueShuffle.encodeTelemetryReport(smallReport));
  assert.equal(small.truncated, false);
  assert.equal(small.events.length, 1);

  const events = [];
  for (let index = 0; index < 300; index += 1) {
    events.push({
      result: index === 299 ? "http-error" : "ok",
      role: "playlist-items-page",
      endpoint_class: "playlist-items",
      method: "GET",
      attempt: 1,
      scheduled_wait_ms: 0,
      started_at: 1770000000000 + index,
      start_offset_ms: index,
      duration_ms: 100,
      status: null,
      retry_after_state: "absent",
      retry_after_seconds: null,
      reason: null,
      request_items: null,
      response_items: 50,
      page_offset: index * 50,
      page_limit: 50,
      server_total: 15000,
      window_count: index + 1
    });
  }
  const large = JSON.parse(TrueShuffle.encodeTelemetryReport(
    {report_id: "r", truncated: false, events: events}
  ));
  assert.equal(large.truncated, true);
  assert.ok(large.events.length <= TrueShuffle.maxTelemetryEvents);
  assert.ok(JSON.stringify(large).length <= TrueShuffle.maxTelemetryReportLength);
  assert.equal(large.events[large.events.length - 1].result, "http-error",
    "the failure survives length-driven truncation");
});

test("validTelemetryQueueEnvelope requires the exact envelope shape", () => {
  const valid = {version: 1, dropped: 0, entries: [{id: "a", failed: false, body: "{}"}]};
  assert.equal(TrueShuffle.validTelemetryQueueEnvelope(valid), true);
  assert.equal(TrueShuffle.validTelemetryQueueEnvelope({version: 1, dropped: 0, entries: []}), true);
  assert.equal(TrueShuffle.validTelemetryQueueEnvelope(null), false);
  assert.equal(TrueShuffle.validTelemetryQueueEnvelope({}), false);
  assert.equal(TrueShuffle.validTelemetryQueueEnvelope(
    Object.assign({}, valid, {version: 2})), false);
  assert.equal(TrueShuffle.validTelemetryQueueEnvelope(
    Object.assign({}, valid, {dropped: -1})), false);
  assert.equal(TrueShuffle.validTelemetryQueueEnvelope(
    Object.assign({}, valid, {entries: [{id: "", failed: false, body: "{}"}]})), false);
  assert.equal(TrueShuffle.validTelemetryQueueEnvelope(
    Object.assign({}, valid, {entries: [{id: "a", failed: 0, body: "{}"}]})), false);
  assert.equal(TrueShuffle.validTelemetryQueueEnvelope(
    Object.assign({}, valid, {entries: [{id: "a", failed: false, body: ""}]})), false);
});

test("queueTelemetryReport bounds four entries preferring failures", () => {
  const empty = {version: 1, dropped: 0, entries: []};
  const entry = (id, failed) => ({id: id, failed: failed, body: "{}"});

  let envelope = empty;
  for (const [id, failed] of [["a", false], ["b", true], ["c", false], ["d", true]]) {
    envelope = TrueShuffle.queueTelemetryReport(envelope, entry(id, failed), 4);
  }
  assert.equal(envelope.entries.length, 4);
  assert.equal(envelope.dropped, 0);

  const overflowed = TrueShuffle.queueTelemetryReport(envelope, entry("e", false), 4);
  assert.deepEqual(plain(overflowed.entries).map((item) => item.id), ["b", "c", "d", "e"],
    "the oldest success-only entry goes first");
  assert.equal(overflowed.dropped, 0, "displacing a success is not an unavoidable drop");

  let failures = empty;
  for (const id of ["a", "b", "c", "d"]) {
    failures = TrueShuffle.queueTelemetryReport(failures, entry(id, true), 4);
  }
  const forced = TrueShuffle.queueTelemetryReport(failures, entry("e", true), 4);
  assert.deepEqual(plain(forced.entries).map((item) => item.id), ["b", "c", "d", "e"],
    "when only failures remain the oldest is dropped");
  assert.equal(forced.dropped, 1, "an unavoidable failure drop is counted");

  const replaced = TrueShuffle.queueTelemetryReport(envelope, entry("b", true), 4);
  assert.equal(replaced.entries.filter((item) => item.id === "b").length, 1,
    "re-enqueueing a report id replaces rather than duplicates");
});

test("cooldownDeadline uses guidance when valid and 30 seconds otherwise", () => {
  assert.equal(TrueShuffle.cooldownDeadline({state: "valid", seconds: 7}, now), now + 7000);
  assert.equal(TrueShuffle.cooldownDeadline({state: "valid", seconds: 0}, now), now);
  assert.equal(TrueShuffle.cooldownDeadline({state: "absent", seconds: null}, now), now + 30000);
  assert.equal(TrueShuffle.cooldownDeadline({state: "invalid", seconds: null}, now), now + 30000);
  assert.equal(TrueShuffle.fallbackCooldownMs, 30000);
});

test("validCooldownRecord requires a positive finite deadline", () => {
  assert.equal(TrueShuffle.validCooldownRecord({until: now}), true);
  assert.equal(TrueShuffle.validCooldownRecord(null), false);
  assert.equal(TrueShuffle.validCooldownRecord({}), false);
  assert.equal(TrueShuffle.validCooldownRecord({until: 0}), false);
  assert.equal(TrueShuffle.validCooldownRecord({until: Infinity}), false);
  assert.equal(TrueShuffle.validCooldownRecord({until: "soon"}), false);
});

test("shouldRetry429 allows one retry only for a short wait", () => {
  assert.equal(TrueShuffle.shouldRetry429(1, 5000), true);
  assert.equal(TrueShuffle.shouldRetry429(1, TrueShuffle.maxCooldownWaitMs), true);
  assert.equal(TrueShuffle.shouldRetry429(1, TrueShuffle.maxCooldownWaitMs + 1), false);
  assert.equal(TrueShuffle.shouldRetry429(2, 5000), false);
});

test("CooldownActiveError carries its deadline", () => {
  const error = new TrueShuffle.CooldownActiveError("wait", now);
  assert.equal(error.message, "wait");
  assert.equal(error.until, now);
  assert.equal(error instanceof TrueShuffle.CooldownActiveError, true);
});
