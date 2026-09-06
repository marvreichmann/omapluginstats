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

// One row per watched plugin, most-viewed first. Views are the ranking because
// they are the number that moves: a listing collects them without anyone
// deciding to act, so ordering by anything else leaves the busiest plugin
// somewhere in the middle of the list.
function rows(watchlist, stats, names) {
  var list = normalizeWatchlist(watchlist)
  var out = []
  for (var i = 0; i < list.length; i++) {
    var id = list[i]
    var s = statsFor(stats, id)
    var name = displayName(names, id)
    out.push({
      id: id,
      name: name,
      // Only worth showing under the name when it is not the name already.
      subtitle: name === id ? "" : id,
      views: s.views,
      copies: s.copies,
      hearts: s.hearts,
      known: s.known
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

// How wide one column of numbers has to be, in digits. The bar font is
// monospaced, so this is all it takes to have the three columns line up down
// the panel without measuring every row — and to keep them no wider than the
// numbers actually in them.
function maxDigits(rowList, key) {
  var most = 1
  if (!Array.isArray(rowList)) return most
  for (var i = 0; i < rowList.length; i++) {
    var text = formatCount(rowList[i] ? rowList[i][key] : 0)
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
