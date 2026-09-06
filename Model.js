.pragma library

// Pure functions behind the panel. Everything here is decidable from its
// arguments alone, which is what makes it testable without a running shell —
// see tests/model.test.js.

// The marketplace's own id rule, copied from its assets/js/engagement.js. An id
// this plugin accepts is therefore exactly one the API will answer for, and the
// three keys it refuses are the ones that would land on Object.prototype rather
// than on the map we think we are filling.
var pluginIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
var reservedIds = ["__proto__", "constructor", "prototype"]

// A watchlist is something you curate by hand. The cap is only here so a
// hand-edited state file cannot turn the panel into an unscrollable wall.
var maxWatchlist = 64

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function validPluginId(value) {
  // Strict about the type as well as the shape: a state file edited by hand can
  // hold a number, and String(7) would otherwise pass as a plugin id.
  if (typeof value !== "string") return false
  return pluginIdPattern.test(value) && reservedIds.indexOf(value.toLowerCase()) < 0
}

function safeCount(value) {
  var count = Math.trunc(Number(value))
  return Number.isSafeInteger(count) && count >= 0 ? count : 0
}

// An id-to-counts map, keeping only the entries that are shaped like one.
// Returns null — not an empty map — for anything unreadable, so the caller can
// keep showing the numbers it already had instead of blanking every row to 0.
// Used for both the API response and the copy cached in the state file.
function normalizeStats(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null

  var out = {}
  for (var id in source) {
    if (!hasOwn(source, id) || !validPluginId(id)) continue
    var value = source[id]
    if (!value || typeof value !== "object") continue
    out[id] = {
      views: safeCount(value.views),
      copies: safeCount(value.copies),
      hearts: safeCount(value.hearts)
    }
  }
  return out
}

// The API answers with { schemaVersion, plugins: { id: { views, copies, hearts } } }.
function parseStats(text) {
  var payload = null
  try {
    payload = JSON.parse(String(text === undefined || text === null ? "" : text))
  } catch (e) {
    return null
  }
  return normalizeStats(payload ? payload.plugins : null)
}

// The response carries every listing on the marketplace — some 2500 of them.
// Only the watched ones are worth persisting, so the state file stays a few
// hundred bytes instead of 160 KB of plugins nobody here asked about.
function pickStats(stats, ids) {
  var out = {}
  if (!stats || !Array.isArray(ids)) return out
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i]
    if (validPluginId(id) && hasOwn(stats, id)) out[id] = stats[id]
  }
  return out
}

// `known` separates "the marketplace reports zero" from "the marketplace has
// never heard of this id" — a typo'd id otherwise reads as a real listing that
// nobody has ever opened.
function statsFor(stats, id) {
  if (stats && validPluginId(id) && hasOwn(stats, id)) {
    var entry = stats[id]
    return {
      views: safeCount(entry.views),
      copies: safeCount(entry.copies),
      hearts: safeCount(entry.hearts),
      known: true
    }
  }
  return { views: 0, copies: 0, hearts: 0, known: false }
}

function normalizeWatchlist(list) {
  var out = []
  if (!Array.isArray(list)) return out
  for (var i = 0; i < list.length && out.length < maxWatchlist; i++) {
    var id = list[i]
    if (validPluginId(id) && out.indexOf(id) < 0) out.push(id)
  }
  return out
}

// Returns the same list when the id is invalid or already watched, so callers
// can compare identity to decide whether anything needs saving.
function addToWatchlist(list, id) {
  var current = normalizeWatchlist(list)
  var trimmed = typeof id === "string" ? id.replace(/^\s+|\s+$/g, "") : ""
  if (!validPluginId(trimmed) || current.indexOf(trimmed) >= 0) return current
  if (current.length >= maxWatchlist) return current
  return current.concat([trimmed])
}

function removeFromWatchlist(list, id) {
  var current = normalizeWatchlist(list)
  var at = current.indexOf(String(id))
  if (at < 0) return current
  return current.slice(0, at).concat(current.slice(at + 1))
}

// What a write should actually put on disk.
//
// Every write merges what this instance holds into what the file holds, so a
// write can only ever add ids — an instance that somehow ends up holding a
// short list cannot destroy a longer one already on disk. The worst it can do
// is show fewer rows than it saved, until its next reload.
//
// A removal is the one write that takes something away, and it takes away
// exactly the id the user removed. It is not "store my view of the list",
// because that would let a truncated instance wipe the rest on the way past.
//
// This is a belt on top of the file being watched: that keeps the two copies in
// step, this makes the failure non-destructive when they are not.
function watchlistToWrite(current, onDisk, removedId) {
  var next = normalizeWatchlist(current)
  var disk = normalizeWatchlist(onDisk)
  for (var i = 0; i < disk.length; i++) {
    if (next.indexOf(disk[i]) < 0) next.push(disk[i])
  }
  if (typeof removedId === "string" && removedId !== "") {
    var at = next.indexOf(removedId)
    if (at >= 0) next = next.slice(0, at).concat(next.slice(at + 1))
  }
  return next
}

// The stats endpoint knows ids, not names. A watched plugin that happens to be
// installed has its name sitting in its own manifest, which is where the panel
// gets one; anything else is shown by id.
function manifestName(text) {
  try {
    var parsed = JSON.parse(String(text === undefined || text === null ? "" : text))
    var name = parsed ? parsed.name : null
    return typeof name === "string" ? name.replace(/^\s+|\s+$/g, "") : ""
  } catch (e) {
    return ""
  }
}

function displayName(names, id) {
  var key = String(id)
  if (names && hasOwn(names, key)) {
    var name = String(names[key] || "")
    if (name !== "") return name
  }
  return key
}

// Listing dates, read out of the marketplace catalog. The catalog is 6.3 MB of
// pretty-printed JSON — far too much to hand to the QML engine for three dozen
// bytes of it — so the service pipes it through grep and this parses what comes
// back: the `"id"` and `"listedAt"` lines, in document order.
//
// That pairing is only sound because of how the catalog is shaped, which was
// checked rather than assumed: exactly one `"id"` line per plugin, all at the
// same nesting depth, and every `"listedAt"` line belongs to the plugin whose
// id last appeared. Verified against a full parse of all 2538 listings — 2502
// dates, no mismatches. The 36 without one are the first-party `omarchy.*`
// plugins, which are not community listings and have no listing date at all.
function parseListingDates(text) {
  var out = {}
  var lines = String(text === undefined || text === null ? "" : text).split("\n")
  var current = null
  for (var i = 0; i < lines.length; i++) {
    var match = /^\s*"(id|listedAt)":\s*"([^"]*)"/.exec(lines[i])
    if (!match) continue
    if (match[1] === "id") {
      current = validPluginId(match[2]) ? match[2] : null
    } else if (current !== null) {
      out[current] = match[2]
      // One date per id: anything further before the next id line is not ours.
      current = null
    }
  }
  return out
}

// Days the listing has been up, counted inclusively — a plugin listed this
// morning has been listed for one day, not zero, and dividing by zero views per
// day helps nobody. Returns 0 for "no listing date", which is a different thing
// from a rate of zero.
function listingDays(nowMs, listedAt) {
  if (typeof listedAt !== "string" || listedAt === "") return 0
  var listed = Date.parse(listedAt)
  if (!Number.isFinite(listed)) return 0
  var elapsed = Number(nowMs) - listed
  if (!Number.isFinite(elapsed)) return 0
  return Math.max(1, Math.floor(elapsed / 86400000) + 1)
}

// Views since listing, averaged over the days it has been listed. This is the
// only rate the marketplace's data can support: it publishes running totals and
// no history, so a genuine "views this week" would mean sampling the totals
// ourselves for a week first.
function viewsPerDay(views, days) {
  return days > 0 ? safeCount(views) / days : 0
}

// One decimal below ten, none above: the difference between 2.1 and 2.4 a day
// is worth seeing, the difference between 137 and 137.4 is noise.
function formatRate(value) {
  var rate = Number(value)
  if (!Number.isFinite(rate) || rate < 0) return "0.0"
  // Round before choosing the format, not after: 9.96 rounds to 10, and
  // deciding first would print it as "10.0" among a column of bare integers.
  var rounded = Math.round(rate * 10) / 10
  return rounded >= 10 ? String(Math.round(rounded)) : rounded.toFixed(1)
}

// One row per watched plugin, most-viewed first. Views are the ranking because
// they are the number that moves: a listing collects them without anyone
// deciding to act, so ordering by anything else leaves the busiest plugin
// somewhere in the middle of the list.
function rows(watchlist, stats, names, listings, nowMs) {
  var list = normalizeWatchlist(watchlist)
  var out = []
  for (var i = 0; i < list.length; i++) {
    var id = list[i]
    var s = statsFor(stats, id)
    var name = displayName(names, id)
    var days = listings && hasOwn(listings, id) ? listingDays(nowMs, listings[id]) : 0
    var rated = s.known && days > 0
    // The strings the panel draws are built here, not in the QML, because the
    // columns are sized by counting their characters — measuring anything the
    // panel then renders differently would leave the numbers misaligned.
    out.push({
      id: id,
      name: name,
      // Only worth showing under the name when it is not the name already.
      subtitle: name === id ? "" : id,
      views: s.views,
      copies: s.copies,
      hearts: s.hearts,
      known: s.known,
      days: days,
      perDay: rated ? viewsPerDay(s.views, days) : 0,
      rated: rated,
      // An em dash, not a zero: a plugin the marketplace has never heard of has
      // no views, which is a different fact from having none yet — and a
      // first-party plugin has no listing date to average over at all.
      viewsText: s.known ? formatCount(s.views) : "—",
      copiesText: s.known ? formatCount(s.copies) : "—",
      heartsText: s.known ? formatCount(s.hearts) : "—",
      rateText: rated ? formatRate(viewsPerDay(s.views, days)) : "—"
    })
  }
  out.sort(function(a, b) {
    if (a.views !== b.views) return b.views - a.views
    if (a.name !== b.name) return a.name < b.name ? -1 : 1
    return a.id < b.id ? -1 : 1
  })
  return out
}


// Exact counts, grouped for reading. A stats panel that rounds 1049 to "1k" is
// hiding the digit you opened it for.
function formatCount(value) {
  var count = safeCount(value)
  var text = String(count)
  if (count < 10000) return text
  var out = ""
  for (var i = 0; i < text.length; i++) {
    if (i > 0 && (text.length - i) % 3 === 0) out += " "
    out += text.charAt(i)
  }
  return out
}

// How wide one column has to be, in characters. The bar font is monospaced, so
// this is all it takes to have the columns line up down the panel without
// measuring every row — and to keep them no wider than the values in them.
// `key` names one of the `*Text` fields on a row, so what is counted is exactly
// what is drawn.
function maxChars(rowList, key) {
  var most = 1
  if (!Array.isArray(rowList)) return most
  for (var i = 0; i < rowList.length; i++) {
    var text = rowList[i] ? String(rowList[i][key] || "") : ""
    if (text.length > most) most = text.length
  }
  return most
}

function pluralize(count, noun) {
  return count === 1 ? "1 " + noun : count + " " + noun + "s"
}

// Deliberately coarse: the point is "are these numbers from this session or
// from yesterday", not the second they arrived.
function relativeAge(nowMs, thenMs) {
  var then = Number(thenMs)
  if (!Number.isFinite(then) || then <= 0) return "never fetched"
  var delta = Number(nowMs) - then
  // A state file written on a machine whose clock has since moved backwards
  // would otherwise report a fetch from the future.
  if (!Number.isFinite(delta) || delta < 45000) return "updated just now"
  var minutes = Math.round(delta / 60000)
  if (minutes < 60) return "updated " + minutes + " min ago"
  var hours = Math.round(delta / 3600000)
  if (hours < 24) return "updated " + hours + (hours === 1 ? " hour ago" : " hours ago")
  var days = Math.round(delta / 86400000)
  return "updated " + days + (days === 1 ? " day ago" : " days ago")
}

// curl's own exit codes, narrowed to the ones this single request can produce.
// The number alone tells the user nothing; "no network" tells them whether to
// bother pressing Refresh again.
function fetchError(exitCode) {
  switch (exitCode) {
  case 0: return ""
  case 6: return "Cannot resolve api.omarchyplugins.com"
  case 7: return "Cannot reach the marketplace API"
  case 22: return "The marketplace API refused the request"
  case 28: return "The marketplace API timed out"
  case 35:
  case 60: return "TLS handshake with the marketplace API failed"
  default: return "Could not fetch stats (curl exit " + exitCode + ")"
  }
}
