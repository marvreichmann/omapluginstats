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

test("pickStats keeps only the watched ids", () => {
  const stats = Model.parseStats(RESPONSE)
  const picked = Model.pickStats(stats, ["37signals.hey", "typo.no-such-plugin"])
  assert.deepEqual(Object.keys(picked), ["37signals.hey"])
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
