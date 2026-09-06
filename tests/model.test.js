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
    names
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

test("maxDigits sizes a column to its widest number", () => {
  const rows = [{ views: 7, copies: 12345, hearts: 0 }, { views: 536, copies: 1, hearts: 0 }]
  assert.equal(Model.maxDigits(rows, "views"), 3)
  // 12345 formats as "12 345" — six cells, not five.
  assert.equal(Model.maxDigits(rows, "copies"), 6)
  assert.equal(Model.maxDigits([], "views"), 1)
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
