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
  assert.equal(Model.fetchError(0), "")
  assert.equal(Model.fetchError(6), "Cannot resolve api.omarchyplugins.com")
  assert.equal(Model.fetchError(28), "The marketplace API timed out")
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
  const rows = Model.rows(["c.other", "b.same", "a.same"], stats, names, {}, NOW)
  assert.deepEqual(rows.map((r) => r.id), ["a.same", "b.same", "c.other"])
})

test("maxChars copes with a key a row does not carry", () => {
  assert.equal(Model.maxChars([{ viewsText: "12" }, {}], "viewsText"), 2)
  assert.equal(Model.maxChars([null], "viewsText"), 1)
})
