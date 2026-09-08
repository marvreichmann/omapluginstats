// Unit tests for Model.js, the plugin's pure-function layer.
//
// Nothing here touches QML, a shell, or the network: the point of Model.js is
// that the response parsing, the watchlist edits and the row assembly are all
// decidable from their arguments alone. Run with:
//
//   node --test tests/
//
// The QML files are still exercised by hand — see CLAUDE.md's test loop.

const test = require("node:test")
const assert = require("node:assert/strict")
const Model = require("./model.js")

const NOW = Date.parse("2026-09-06T12:00:00Z")

// Shaped like a real answer from https://api.omarchyplugins.com/v1/stats,
// trimmed to a handful of ids. The real response carries some 2500 of these.
const RESPONSE = JSON.stringify({
  schemaVersion: 1,
  plugins: {
    "com.github.marvreichmann.omavibrance": { views: 27, copies: 1, hearts: 0 },
    "3lymn.plugin-drawer": { views: 536, copies: 191, hearts: 16 },
    "37signals.hey": { views: 251, copies: 20, hearts: 11 }
  }
})

test("parseStats reads the documented response shape", () => {
  const stats = Model.parseStats(RESPONSE)
  assert.deepEqual(stats["3lymn.plugin-drawer"], { views: 536, copies: 191, hearts: 16 })
  assert.equal(Object.keys(stats).length, 3)
})

test("parseStats returns null for anything unreadable", () => {
  // The caller keeps its existing numbers on null, and blanks every row to zero
  // on an empty object — so these two must not be confused.
  assert.equal(Model.parseStats(""), null)
  assert.equal(Model.parseStats("<html>captive portal</html>"), null)
  assert.equal(Model.parseStats(JSON.stringify({ schemaVersion: 1 })), null)
  assert.equal(Model.parseStats(JSON.stringify({ plugins: [] })), null)
  assert.deepEqual(Model.parseStats(JSON.stringify({ plugins: {} })), {})
})

test("parseStats drops entries it cannot trust", () => {
  const stats = Model.parseStats(JSON.stringify({
    plugins: {
      "good.id": { views: 3, copies: 2, hearts: 1 },
      "__proto__": { views: 9, copies: 9, hearts: 9 },
      "not a plugin id": { views: 4, copies: 4, hearts: 4 },
      "bad.payload": "12",
      "negative.counts": { views: -5, copies: 1.7, hearts: "many" }
    }
  }))
  assert.deepEqual(Object.keys(stats).sort(), ["good.id", "negative.counts"])
  assert.deepEqual(stats["negative.counts"], { views: 0, copies: 1, hearts: 0 })
  assert.equal(Object.prototype.hasOwnProperty.call(stats, "__proto__"), false)
})

test("validPluginId matches the marketplace's own rule", () => {
  assert.equal(Model.validPluginId("com.github.you.plugin"), true)
  assert.equal(Model.validPluginId("3lymn.plugin-drawer"), true)
  assert.equal(Model.validPluginId(""), false)
  assert.equal(Model.validPluginId(".leading-dot"), false)
  assert.equal(Model.validPluginId("has space"), false)
  assert.equal(Model.validPluginId("has/slash"), false)
  assert.equal(Model.validPluginId("__proto__"), false)
  assert.equal(Model.validPluginId("a".repeat(129)), false)
})

test("statsFor separates zero from unlisted", () => {
  const stats = Model.parseStats(RESPONSE)
  assert.deepEqual(Model.statsFor(stats, "com.github.marvreichmann.omavibrance"),
    { views: 27, copies: 1, hearts: 0, known: true })
  assert.deepEqual(Model.statsFor(stats, "typo.no-such-plugin"),
    { views: 0, copies: 0, hearts: 0, known: false })
})

// --- the id-keyed maps ------------------------------------------------------

test("pickMap keeps only the entries asked for", () => {
  const stats = Model.parseStats(RESPONSE)
  // What is stored is narrowed to the watchlist, so an id nobody watches — or
  // one the response never carried — must not survive the trip to disk.
  assert.deepEqual(Object.keys(Model.pickMap(stats, ["37signals.hey", "typo.no-such-plugin"])),
    ["37signals.hey"])
  assert.deepEqual(Model.pickMap({ "a.one": 1 }, ["not an id"]), {})
  assert.deepEqual(Model.pickMap(null, ["a.one"]), {})
  assert.deepEqual(Model.pickMap({ "a.one": 1 }, "a.one"), {})
})

test("mergeMaps lets the newer map win without touching either", () => {
  const base = { "a.one": "x", "b.two": "y" }
  const merged = Model.mergeMaps(base, { "b.two": "z", "c.three": "w" })
  assert.deepEqual(merged, { "a.one": "x", "b.two": "z", "c.three": "w" })
  // QML only notices a var property changing when it is reassigned, so these
  // must return a new object rather than edit one in place.
  assert.deepEqual(base, { "a.one": "x", "b.two": "y" })
  assert.notEqual(merged, base)
})

test("withEntry treats an empty value as a removal", () => {
  const map = { "a.one": "Name" }
  assert.deepEqual(Model.withEntry(map, "b.two", "Other"), { "a.one": "Name", "b.two": "Other" })
  // An absent name and a name of "" mean the same thing; only one of them
  // should ever reach the state file.
  assert.deepEqual(Model.withEntry(map, "a.one", ""), {})
  assert.deepEqual(Model.withEntry(map, "a.one", undefined), {})
  assert.deepEqual(map, { "a.one": "Name" })
})

test("isEmptyMap tells an empty answer from no answer", () => {
  assert.equal(Model.isEmptyMap({}), true)
  assert.equal(Model.isEmptyMap({ "a.one": 1 }), false)
})

test("normalizeStats is reused for the cached copy in the state file", () => {
  // loadState feeds it the map straight out of the file rather than a response
  // body, so it has to hold up on its own.
  assert.deepEqual(Model.normalizeStats({ "a.one": { views: 5, copies: 1, hearts: 0 } }),
    { "a.one": { views: 5, copies: 1, hearts: 0 } })
  assert.equal(Model.normalizeStats(null), null)
  assert.equal(Model.normalizeStats([]), null)
  assert.equal(Model.normalizeStats("{}"), null)
})

test("addToWatchlist refuses duplicates and junk, and says so by identity", () => {
  const list = ["a.one"]
  assert.deepEqual(Model.addToWatchlist(list, "b.two"), ["a.one", "b.two"])
  // The service compares lengths to decide whether anything changed.
  assert.equal(Model.addToWatchlist(list, "a.one").length, list.length)
  assert.equal(Model.addToWatchlist(list, "not an id").length, list.length)
  assert.deepEqual(Model.addToWatchlist(list, "  b.two  "), ["a.one", "b.two"])
})

test("removeFromWatchlist takes out exactly one id", () => {
  assert.deepEqual(Model.removeFromWatchlist(["a.one", "b.two", "c.three"], "b.two"),
    ["a.one", "c.three"])
  assert.deepEqual(Model.removeFromWatchlist(["a.one"], "b.two"), ["a.one"])
})

test("normalizeWatchlist survives a hand-edited state file", () => {
  assert.deepEqual(Model.normalizeWatchlist(["a.one", "a.one", "bad id", 7, null, "b.two"]),
    ["a.one", "b.two"])
  assert.deepEqual(Model.normalizeWatchlist("a.one"), [])
  assert.equal(Model.normalizeWatchlist(new Array(200).fill(0).map((_, i) => `p.${i}`)).length, 64)
})

test("watchlistToWrite can only ever add, except for the one id removed", () => {
  const disk = ["a.one", "b.two", "c.three"]
  // An instance holding a short list must not be able to destroy the rest.
  assert.deepEqual(Model.watchlistToWrite(["a.one"], disk), ["a.one", "b.two", "c.three"])
  // A removal takes away exactly the id named, and nothing else — even when
  // the instance doing the writing has lost sight of the other entries.
  assert.deepEqual(Model.watchlistToWrite(["a.one"], disk, "b.two"), ["a.one", "c.three"])
  assert.deepEqual(Model.watchlistToWrite([], disk, "a.one"), ["b.two", "c.three"])
  // Additions land, and the added id keeps its position.
  assert.deepEqual(Model.watchlistToWrite(["a.one", "d.four"], disk),
    ["a.one", "d.four", "b.two", "c.three"])
  assert.deepEqual(Model.watchlistToWrite([], []), [])
})

test("manifestName reads a name, and tolerates anything else", () => {
  assert.equal(Model.manifestName(JSON.stringify({ id: "x.y", name: " Omavibrance " })), "Omavibrance")
  assert.equal(Model.manifestName(JSON.stringify({ id: "x.y" })), "")
  assert.equal(Model.manifestName("not json"), "")
  assert.equal(Model.manifestName(""), "")
})

test("rows rank by views and carry the id when it is not the name", () => {
  const stats = Model.parseStats(RESPONSE)
  const names = { "com.github.marvreichmann.omavibrance": "Omavibrance" }
  const rows = Model.rows(
    ["com.github.marvreichmann.omavibrance", "37signals.hey", "3lymn.plugin-drawer", "typo.no-such-plugin"],
    stats,
    names,
    {},
    NOW
  )
  assert.deepEqual(rows.map((r) => r.id), [
    "3lymn.plugin-drawer",
    "37signals.hey",
    "com.github.marvreichmann.omavibrance",
    "typo.no-such-plugin"
  ])
  // Named and installed: the id goes on the second line.
  assert.equal(rows[2].name, "Omavibrance")
  assert.equal(rows[2].subtitle, "com.github.marvreichmann.omavibrance")
  // Not installed: the id *is* the name, so there is no second line to show.
  assert.equal(rows[1].name, "37signals.hey")
  assert.equal(rows[1].subtitle, "")
  assert.equal(rows[3].known, false)
})


test("formatCount groups only where a number is hard to read", () => {
  assert.equal(Model.formatCount(0), "0")
  assert.equal(Model.formatCount(536), "536")
  assert.equal(Model.formatCount(9999), "9999")
  assert.equal(Model.formatCount(10000), "10 000")
  assert.equal(Model.formatCount(1234567), "1 234 567")
})

test("maxChars sizes a column to its widest rendered value", () => {
  const rows = [{ viewsText: "7", copiesText: "12 345" }, { viewsText: "536", copiesText: "1" }]
  assert.equal(Model.maxChars(rows, "viewsText"), 3)
  // "12 345" is six cells, not five: the separator takes a column too.
  assert.equal(Model.maxChars(rows, "copiesText"), 6)
  assert.equal(Model.maxChars([], "viewsText"), 1)
})

// --- views per day ---------------------------------------------------------

// Verbatim from the catalog, piped through the same grep the service runs, so
// the parser is tested against the real indentation and key order rather than
// a tidied-up version of it.
const CATALOG_LINES = [
  '      "id": "io.github.woogy7.vitals",',
  '      "listedAt": "2026-08-15T14:35:09.035Z",',
  '      "repositoryLayout": "single",',
  '      "id": "omarchy.agents",',
  '      "name": "Agents",',
  '      "id": "3lymn.plugin-drawer",',
  '      "listedAt": "2026-08-20T09:00:00.000Z",'
].join("\n")

test("parseListingDates pairs each date with the id above it", () => {
  const dates = Model.parseListingDates(CATALOG_LINES)
  assert.deepEqual(dates, {
    "io.github.woogy7.vitals": "2026-08-15T14:35:09.035Z",
    "3lymn.plugin-drawer": "2026-08-20T09:00:00.000Z"
  })
  // A first-party plugin has no listedAt line, and must not inherit the next
  // plugin's date.
  assert.equal(dates["omarchy.agents"], undefined)
  assert.deepEqual(Model.parseListingDates(""), {})
})

test("listingDays counts inclusively and refuses to divide by zero", () => {
  const listed = "2026-09-01T00:00:00.000Z"
  assert.equal(Model.listingDays(Date.parse("2026-09-01T09:00:00Z"), listed), 1)
  assert.equal(Model.listingDays(Date.parse("2026-09-02T00:00:00Z"), listed), 2)
  assert.equal(Model.listingDays(Date.parse("2026-09-08T00:00:00Z"), listed), 8)
  // Absent, unparseable, or from the future: no denominator, not a zero one.
  assert.equal(Model.listingDays(NOW, ""), 0)
  assert.equal(Model.listingDays(NOW, "not a date"), 0)
  assert.equal(Model.listingDays(NOW, undefined), 0)
  assert.equal(Model.listingDays(Date.parse("2026-08-01T00:00:00Z"), listed), 1)
})

test("formatRate keeps a decimal only where it carries information", () => {
  assert.equal(Model.formatRate(0), "0.0")
  assert.equal(Model.formatRate(2.14), "2.1")
  assert.equal(Model.formatRate(9.96), "10")
  assert.equal(Model.formatRate(137.4), "137")
  assert.equal(Model.formatRate(NaN), "0.0")
})

test("rows rate views over the days the listing has been up", () => {
  const stats = Model.parseStats(RESPONSE)
  const listings = {
    "3lymn.plugin-drawer": "2026-09-01T00:00:00.000Z",
    "37signals.hey": "2026-08-01T00:00:00.000Z"
  }
  const now = Date.parse("2026-09-08T00:00:00Z")
  const rows = Model.rows(
    ["3lymn.plugin-drawer", "37signals.hey", "com.github.marvreichmann.omavibrance"],
    stats, {}, listings, now
  )
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
  // 536 views over 8 days.
  assert.equal(byId["3lymn.plugin-drawer"].days, 8)
  assert.equal(byId["3lymn.plugin-drawer"].rateText, "67")
  // 251 views over 39 days.
  assert.equal(byId["37signals.hey"].rateText, "6.4")
  // Listed on the marketplace, but we have no date for it yet.
  assert.equal(byId["com.github.marvreichmann.omavibrance"].rated, false)
  assert.equal(byId["com.github.marvreichmann.omavibrance"].rateText, "—")
})

test("rows show a dash rather than a rate for a plugin with no listing", () => {
  const rows = Model.rows(["typo.no-such-plugin"], {}, {},
    { "typo.no-such-plugin": "2026-09-01T00:00:00.000Z" }, NOW)
  // A date without a listing is not a rate: there are no views to average.
  assert.equal(rows[0].rated, false)
  assert.equal(rows[0].rateText, "—")
  assert.equal(rows[0].viewsText, "—")
})

test("relativeAge says how stale the numbers are", () => {
  const now = 1_700_000_000_000
  assert.equal(Model.relativeAge(now, 0), "never fetched")
  assert.equal(Model.relativeAge(now, now - 1000), "updated just now")
  // A clock that moved backwards must not produce a fetch from the future.
  assert.equal(Model.relativeAge(now, now + 60_000), "updated just now")
  assert.equal(Model.relativeAge(now, now - 5 * 60_000), "updated 5 min ago")
  assert.equal(Model.relativeAge(now, now - 3 * 3600_000), "updated 3 hours ago")
  assert.equal(Model.relativeAge(now, now - 26 * 3600_000), "updated 1 day ago")
})

test("fetchError turns curl's exit code into something actionable", () => {
  // Every code the switch names, so a reworded message cannot slip through on
  // the strength of its neighbours being tested.
  const messages = {
    0: "",
    6: "Cannot resolve api.omarchyplugins.com",
    7: "Cannot reach the marketplace API",
    22: "The marketplace API refused the request",
    28: "The marketplace API timed out",
    35: "TLS handshake with the marketplace API failed",
    60: "TLS handshake with the marketplace API failed"
  }
  for (const code of Object.keys(messages)) {
    assert.equal(Model.fetchError(Number(code)), messages[code], "curl exit " + code)
  }
  assert.match(Model.fetchError(99), /curl exit 99/)
})

test("pluralize keeps the hero line grammatical", () => {
  assert.equal(Model.pluralize(1, "plugin"), "1 plugin")
  assert.equal(Model.pluralize(3, "plugin"), "3 plugins")
})

// --- decisions the QML used to make -----------------------------------------

test("shouldFetchListings only downloads the catalog when it can help", () => {
  const watchlist = ["a.one", "b.two"]
  const complete = { "a.one": "2026-09-01T00:00:00.000Z", "b.two": "2026-09-01T00:00:00.000Z" }
  const day = 24 * 60 * 60 * 1000

  // Nothing missing: never, however long ago it was checked.
  assert.equal(Model.shouldFetchListings(watchlist, complete, 0, NOW, day), false)
  // Missing and never checked.
  assert.equal(Model.shouldFetchListings(watchlist, {}, 0, NOW, day), true)
  // Missing but checked a moment ago. Some ids never get a date — a first-party
  // plugin has no listing — so this is what stops the panel re-downloading
  // 830 KB on every open for the rest of time.
  assert.equal(Model.shouldFetchListings(watchlist, { "a.one": "2026-09-01T00:00:00.000Z" },
    NOW - 60_000, NOW, day), false)
  // Missing and the window has passed.
  assert.equal(Model.shouldFetchListings(watchlist, {}, NOW - day - 1, NOW, day), true)
  // A clock that moved backwards must not lock the fetch out indefinitely.
  assert.equal(Model.shouldFetchListings(watchlist, {}, NOW + day, NOW, day), true)
})

test("missingListings names the ids still without a date", () => {
  assert.deepEqual(Model.missingListings(["a.one", "b.two"], { "a.one": "2026-09-01T00:00:00.000Z" }),
    ["b.two"])
  assert.deepEqual(Model.missingListings(["a.one"], null), ["a.one"])
  assert.deepEqual(Model.missingListings([], {}), [])
})

test("summaryLine puts a problem ahead of a number", () => {
  const fetched = NOW - 5 * 60_000
  assert.equal(Model.summaryLine(3, false, "", fetched, NOW), "3 plugins · updated 5 min ago")
  assert.equal(Model.summaryLine(1, false, "", fetched, NOW), "1 plugin · updated 5 min ago")
  assert.equal(Model.summaryLine(0, false, "", fetched, NOW), "No plugins watched yet")
  // Numbers sitting there with no note beside them read as current ones, so a
  // failure has to outrank the count.
  assert.equal(Model.summaryLine(3, false, "Cannot reach the marketplace API", fetched, NOW),
    "Cannot reach the marketplace API")
  assert.equal(Model.summaryLine(3, true, "", fetched, NOW), "Fetching…")
})

// --- odds and ends the panel leans on ---------------------------------------

test("displayName falls back to the id", () => {
  assert.equal(Model.displayName({ "a.one": "Alpha" }, "a.one"), "Alpha")
  assert.equal(Model.displayName({ "a.one": "" }, "a.one"), "a.one")
  assert.equal(Model.displayName({}, "a.one"), "a.one")
  assert.equal(Model.displayName(null, "a.one"), "a.one")
})

test("statsFor survives a service that has fetched nothing yet", () => {
  assert.deepEqual(Model.statsFor(null, "a.one"), { views: 0, copies: 0, hearts: 0, known: false })
  assert.deepEqual(Model.statsFor({}, "not an id"), { views: 0, copies: 0, hearts: 0, known: false })
})

test("viewsPerDay refuses to divide by no days", () => {
  assert.equal(Model.viewsPerDay(100, 4), 25)
  assert.equal(Model.viewsPerDay(100, 0), 0)
  assert.equal(Model.viewsPerDay(-5, 4), 0)
})

test("addToWatchlist stops at the cap", () => {
  const full = Array.from({ length: 64 }, (_, i) => `p.${i}`)
  assert.equal(Model.addToWatchlist(full, "one.more").length, 64)
  assert.equal(Model.addToWatchlist(full.slice(0, 63), "one.more").length, 64)
})

test("rows break ties by name and then by id", () => {
  // Same view count, so the order has to come from somewhere stable — two rows
  // swapping places between refreshes would be its own kind of wrong.
  const stats = {
    "b.same": { views: 10, copies: 0, hearts: 0 },
    "a.same": { views: 10, copies: 0, hearts: 0 },
    "c.other": { views: 10, copies: 0, hearts: 0 }
  }
  const names = { "b.same": "Alpha", "a.same": "Alpha" }
  const expected = ["a.same", "b.same", "c.other"]
  const watchlist = ["c.other", "b.same", "a.same"]
  assert.deepEqual(Model.rows(watchlist, stats, names, {}, NOW).map((r) => r.id), expected)
  // The same rows in the opposite order have to land the same way: a watchlist
  // is in the order the user added to it, and the panel's order must not be.
  assert.deepEqual(Model.rows(watchlist.slice().reverse(), stats, names, {}, NOW)
    .map((r) => r.id), expected)
})

test("maxChars copes with a key a row does not carry", () => {
  assert.equal(Model.maxChars([{ viewsText: "12" }, {}], "viewsText"), 2)
  assert.equal(Model.maxChars([null], "viewsText"), 1)
})

// --------------------------------------------------------------------- ticker

test("tickerFieldKeys keeps the table's own column order", () => {
  // Whatever order they were asked for: the board is read down the frames, and
  // a table whose columns depend on how someone typed them is not one.
  assert.deepEqual(Model.tickerFieldKeys(["hearts", "views"]), ["views", "hearts"])
  assert.deepEqual(Model.tickerFieldKeys("hearts, copies"), ["copies", "hearts"])
  // Anything unusable falls back to all of them rather than to a stats display
  // with no stats on it.
  assert.deepEqual(Model.tickerFieldKeys(undefined), ["views", "rate", "copies", "hearts"])
  assert.deepEqual(Model.tickerFieldKeys([]), ["views", "rate", "copies", "hearts"])
  assert.deepEqual(Model.tickerFieldKeys(["nonsense"]), ["views", "rate", "copies", "hearts"])
})

test("flapPath steps forward through the drum and wraps", () => {
  const drum = Model.flapDrum(true)
  assert.deepEqual(Model.flapPath("A", "D", drum), ["B", "C", "D"])
  // Already there is no movement at all, which is what stops a cell re-flapping
  // to the character it is showing on every refresh.
  assert.deepEqual(Model.flapPath("Q", "Q", drum), [])
  // The ring only turns one way, so Z to B is the long way round.
  const wrapped = Model.flapPath("Z", "B", drum)
  assert.equal(wrapped[wrapped.length - 1], "B")
  assert.equal(wrapped.length, drum.length - drum.indexOf("Z") + drum.indexOf("B"))
})

test("flapPath lands on a character the drum has no card for", () => {
  const drum = Model.flapDrum(true)
  const path = Model.flapPath("A", "(", drum)
  assert.equal(path[path.length - 1], "(")
  assert.equal(path.length, 4)
  // And can leave it again: a cell sitting on a card the ring has no index for
  // counts as though it were on the blank — a real position — rather than
  // refusing to move, so the path is the one from the blank onwards.
  assert.equal(Model.flapPath("(", "B", drum).join(""), "AB")
})

test("flapPath treats a blank and an empty string as the same card", () => {
  assert.deepEqual(Model.flapPath("", " ", Model.flapDrum(true)), [])
  assert.deepEqual(Model.flapPath(undefined, " ", Model.flapDrum(true)), [])
})

test("the dwell is never shorter than the board takes to settle", () => {
  const drum = Model.flapDrum(true)
  const settle = Model.flapSettleMs(drum, 26)
  assert.equal(settle, drum.length * 26)
  // Asking for a fast cycle cannot start the next frame over a board still in
  // motion — the slider raises the dwell, it does not lower it below this.
  assert.ok(Model.tickerCycleMs(1200, 26, "flap", true) >= settle)
  // The other motions are a single short slide, so they take the ask.
  assert.equal(Model.tickerCycleMs(1200, 26, "roll", true), 1200)
  assert.equal(Model.tickerCycleMs(1200, 26, "none", true), 1200)
  // A mixed-case drum is nearly twice as long, and takes nearly twice as long.
  assert.ok(Model.tickerCycleMs(1200, 26, "flap", false) > Model.tickerCycleMs(1200, 26, "flap", true))
  // Above the floor the ask is simply honoured, or the slider would be a
  // control that only sometimes controls something.
  assert.equal(Model.tickerCycleMs(9000, 26, "flap", true), 9000)
})

test("the dwell floor is where the slider starts, and moves with the motion", () => {
  // Exactly the point tickerCycleMs stops raising the dwell — the panel starts
  // its slider here so no part of the track is a no-op.
  const floor = Model.tickerDwellFloorMs(26, "flap", true)
  assert.equal(floor, Model.tickerCycleMs(1, 26, "flap", true))
  assert.equal(Model.tickerCycleMs(floor, 26, "flap", true), floor)
  // Nothing to settle without the cards, so the floor drops to the clamp.
  assert.equal(Model.tickerDwellFloorMs(26, "roll", true), 1200)
  assert.equal(Model.tickerDwellFloorMs(26, "none", true), 1200)
  // A faster card is a lower floor.
  assert.ok(Model.tickerDwellFloorMs(8, "flap", true) < floor)
})

test("the flip switch and the quiet setting resolve to one motion", () => {
  // The switch is the panel's; which quiet it falls back to is shell.json's.
  assert.equal(Model.tickerMotionFor(true, "none"), "flap")
  assert.equal(Model.tickerMotionFor(undefined, undefined), "flap")
  assert.equal(Model.tickerMotionFor(false, undefined), "roll")
  assert.equal(Model.tickerMotionFor(false, "none"), "none")
  // A quiet motion that is not one of the two, including "flap" itself, cannot
  // smuggle the flipping back in behind a switch that is off.
  assert.equal(Model.tickerMotionFor(false, "flap"), "roll")
  assert.equal(Model.tickerQuietMotion("NONE"), "none")
  assert.equal(Model.tickerQuietMotion("nonsense"), "roll")
})

test("formatSeconds reads a duration the way the rate column reads a rate", () => {
  assert.equal(Model.formatSeconds(4200), "4.2 s")
  assert.equal(Model.formatSeconds(1922), "1.9 s")
  // One decimal below ten, none above, so a column of them does not jitter.
  assert.equal(Model.formatSeconds(12000), "12 s")
  assert.equal(Model.formatSeconds(9960), "10 s")
})

test("ticker settings are clamped rather than trusted", () => {
  // These come out of shell.json, where a mistake is a number rather than an
  // error: a two-millisecond flap or a one-minute poll would both be bugs
  // reported against this plugin.
  assert.equal(Model.tickerFlapMs(0), 8)
  assert.equal(Model.tickerFlapMs(9999), 250)
  assert.equal(Model.tickerFlapMs("nonsense"), 26)
  assert.equal(Model.tickerDwellMs(10), 1200)
  assert.equal(Model.tickerDwellMs(999999), 30000)
  assert.equal(Model.tickerDwellMs(undefined), 4200)
  // The poll floor is the marketplace's, not the user's: one request is every
  // listing on it. A setting can make this politer and not ruder.
  assert.equal(Model.tickerPollMs(1), 15 * 60000)
  assert.equal(Model.tickerPollMs(undefined), 15 * 60000)
  assert.equal(Model.tickerPollMs(60), 60 * 60000)
  assert.equal(Model.tickerPollMs(99999), 360 * 60000)
})

test("tickerModel pads every column to the widest value in it", () => {
  const stats = {
    "a.big": { views: 5361, copies: 191, hearts: 16 },
    "b.small": { views: 27, copies: 1, hearts: 0 }
  }
  const rows = Model.rows(["a.big", "b.small"], stats, { "a.big": "Drawer" }, {}, NOW)
  const board = Model.tickerModel(rows, {})

  assert.deepEqual(board.columns, ["name", "views", "rate", "copies", "hearts"])
  // Every frame is the same shape, which is what keeps the widget's width — and
  // therefore the rest of the bar — still while it cycles.
  const lengths = board.frames.map((f) => board.columns.map((k) => f.texts[k].length))
  assert.deepEqual(lengths[0], lengths[1])
  assert.deepEqual(lengths[0], board.columns.map((k) => board.widths[k]))
  // Numbers right-align so their digits stack down the frames; the name pads on
  // the right so it stays against the left edge of the board.
  assert.equal(board.frames[0].texts.views, "5361")
  assert.equal(board.frames[1].texts.views, "  27")
  assert.equal(board.frames[0].texts.name, "DRAWER ")
  assert.equal(board.frames[1].texts.name, "B.SMALL")
})

test("tickerValueText answers only for the columns that exist", () => {
  const row = { viewsText: "12", rateText: "1.5", copiesText: "3", heartsText: "4" }
  assert.equal(Model.tickerValueText(row, "views"), "12")
  assert.equal(Model.tickerValueText(row, "rate"), "1.5")
  assert.equal(Model.tickerValueText(row, "copies"), "3")
  assert.equal(Model.tickerValueText(row, "hearts"), "4")
  // tickerFieldKeys cannot let a fifth key through, so these two are guards
  // rather than paths — but they are the guards that keep a hand-edited
  // `tickerFields` from putting `undefined` on the bar.
  assert.equal(Model.tickerValueText(row, "nonsense"), "")
  assert.equal(Model.tickerValueText(null, "views"), "")
})

test("tickerModel shows the panel's own strings", () => {
  // An em dash for a plugin the marketplace has never heard of, and the same
  // grouping of long numbers — the two faces of this plugin must not disagree
  // about what a count is.
  const rows = Model.rows(["a.known", "b.unknown"], { "a.known": { views: 12345, copies: 0, hearts: 0 } }, {}, {}, NOW)
  const board = Model.tickerModel(rows, { fields: ["views"] })
  assert.equal(board.frames[0].texts.views, "12 345")
  assert.equal(board.frames[1].texts.views, "     —")
})

test("tickerModel drops leading id segments before it truncates", () => {
  // A long id cut from the right is "COM.GITHUB.MA…", which names the author's
  // host and nothing else.
  const id = "com.github.marvreichmann.omavibrance"
  const rows = Model.rows([id], { [id]: { views: 27, copies: 1, hearts: 0 } }, {}, {}, NOW)
  assert.equal(Model.tickerModel(rows, {}).frames[0].texts.name, "OMAVIBRANCE")
  // A real name is the author's own words, and gets cut where it runs out of
  // room rather than rewritten.
  const named = Model.rows([id], { [id]: { views: 27, copies: 1, hearts: 0 } },
    { [id]: "Omarchy Vibrance Toggle" }, {}, NOW)
  assert.equal(Model.tickerModel(named, {}).frames[0].texts.name, "OMARCHY VIBRA…")
})

test("tickerModel copes with an empty watchlist and with nonsense", () => {
  assert.deepEqual(Model.tickerModel([], {}).frames, [])
  assert.deepEqual(Model.tickerModel(null, null).frames, [])
  // Still a shape the board can lay itself out from, so an empty watchlist is a
  // widget with nothing to say rather than a broken one.
  assert.deepEqual(Model.tickerModel([], {}).columns, ["name", "views", "rate", "copies", "hearts"])
  assert.equal(Model.tickerModel([], {}).widths.views, 1)
})

test("statsDelta reports only what actually grew, for watched ids only", () => {
  const before = { "a.one": { views: 10, copies: 2, hearts: 1 }, "b.two": { views: 5, copies: 0, hearts: 0 } }
  const after = { "a.one": { views: 14, copies: 2, hearts: 2 }, "b.two": { views: 5, copies: 0, hearts: 0 }, "c.new": { views: 900, copies: 9, hearts: 9 } }
  const delta = Model.statsDelta(before, after, ["a.one", "b.two", "c.new"])
  assert.deepEqual(delta["a.one"], { views: 4, copies: 0, hearts: 1 })
  // Unchanged is absent, not a row of zeroes.
  assert.equal("b.two" in delta, false)
  // An id the marketplace has only just started reporting has no earlier number
  // to have grown from; counting its whole total as a jump would light the
  // board up over nothing.
  assert.equal("c.new" in delta, false)
})

test("tickerModel marks the columns that moved", () => {
  const stats = { "a.one": { views: 14, copies: 2, hearts: 2 } }
  const rows = Model.rows(["a.one"], stats, {}, {}, NOW)
  const deltas = Model.statsDelta({ "a.one": { views: 10, copies: 2, hearts: 1 } }, stats, ["a.one"])
  const changed = Model.tickerModel(rows, { deltas: deltas }).frames[0].changed
  assert.equal(changed.views, true)
  assert.equal(changed.hearts, true)
  assert.equal(changed.copies, false)
  // The name did not move, and the rate is derived rather than reported.
  assert.equal(changed.name, false)
  assert.equal(changed.rate, false)
})

test("stepIndex wraps in both directions and refuses to produce a NaN", () => {
  assert.equal(Model.stepIndex(2, 3, 1), 0)
  assert.equal(Model.stepIndex(0, 3, -1), 2)
  assert.equal(Model.stepIndex(7, 3, 0), 1)
  // An empty board and a nonsense index both land on the first frame rather
  // than propagating into a Repeater.
  assert.equal(Model.stepIndex(0, 0, 1), 0)
  assert.equal(Model.stepIndex(NaN, 3, 1), 1)
  assert.equal(Model.stepIndex(1, 3, NaN), 1)
})

test("tickerTooltip says which plugin and where in the list", () => {
  const stats = { "a.one": { views: 10, copies: 0, hearts: 0 }, "b.two": { views: 5, copies: 0, hearts: 0 } }
  const rows = Model.rows(["a.one", "b.two"], stats, { "a.one": "Alpha" }, {}, NOW)
  assert.equal(Model.tickerTooltip(rows, 0), "Alpha\na.one\n1 of 2")
  // No subtitle line when the name is already the id.
  assert.equal(Model.tickerTooltip(rows, 1), "b.two\n2 of 2")
  assert.equal(Model.tickerTooltip([], 0), "No plugins watched yet")
})

test("padTo pads on the side it is asked to and never truncates", () => {
  assert.equal(Model.padTo("7", 3, true), "  7")
  assert.equal(Model.padTo("7", 3, false), "7  ")
  assert.equal(Model.padTo("toolong", 3, true), "toolong")
  assert.equal(Model.padTo(null, 2, true), "  ")
})

// ------------------------------------------------------------------ manifest

// The manifest declares the ticker's tunable settings twice over: a range for a
// settings UI to offer, and a default. Model.js clamps the values that actually
// arrive. Nothing checks the two against each other at run time — a settings UI
// would happily offer a number this plugin then silently clamps — so they are
// checked here.
test("the manifest's schema ranges are the ones Model enforces", () => {
  const manifest = require("../manifest.json")
  const schema = Object.fromEntries(manifest.barWidget.schema.map((f) => [f.key, f]))

  const ranges = [
    ["tickerNameChars", Model.tickerNameMinChars, Model.tickerNameMaxChars, Model.tickerNameDefaultChars],
    ["tickerFlapMs", Model.tickerFlapMinMs, Model.tickerFlapMaxMs, Model.tickerFlapDefaultMs],
    ["refreshMinutes", Model.tickerPollMinMinutes, Model.tickerPollMaxMinutes, Model.tickerPollDefaultMinutes]
  ]
  for (const [key, min, max, fallback] of ranges) {
    assert.equal(schema[key].type, "integer", key + " type")
    assert.equal(schema[key].min, min, key + " min")
    assert.equal(schema[key].max, max, key + " max")
    assert.equal(schema[key].defaultValue, fallback, key + " default")
  }

  // The quiet motions are exactly the ones tickerQuietMotion resolves to, so a
  // settings UI cannot offer a third that silently becomes "roll".
  assert.deepEqual(schema.tickerQuietMotion.options, ["roll", "none"])
  for (const option of schema.tickerQuietMotion.options) {
    assert.equal(Model.tickerQuietMotion(option), option)
  }

  // The columns offered are the ones the ticker can draw, in its own order.
  assert.deepEqual(schema.tickerFields.options.map((o) => o.value), Model.tickerFieldOrder)

  // `defaults` mirrors the per-field defaults, the way the first-party
  // manifests that carry both do.
  for (const field of manifest.barWidget.schema) {
    if ("defaultValue" in field) {
      assert.equal(manifest.barWidget.defaults[field.key], field.defaultValue, field.key + " in defaults")
    }
  }
})
