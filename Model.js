.pragma library

// Pure functions behind the panel. Everything here is decidable from its
// arguments alone, which is what makes it testable without a running shell —
// see tests/model.test.js. Anything in Service.qml or Panel.qml that amounts to
// a decision rather than a binding belongs here.

// ------------------------------------------------------------------- basics

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

// --------------------------------------------------------------------- maps
//
// The service keeps three id-keyed maps — counts, names, listing dates — and
// QML only notices a `var` property changing when it is reassigned, so each of
// these returns a new object rather than editing one in place.

// Keep only the entries whose key is a plugin id in `ids`. Every map is narrowed
// to the watchlist before it is stored, so dropping a plugin drops everything
// remembered about it rather than leaving an entry in the file forever.
function pickMap(map, ids) {
  var out = {}
  if (!map || !Array.isArray(ids)) return out
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i]
    if (validPluginId(id) && hasOwn(map, id)) out[id] = map[id]
  }
  return out
}

function mergeMaps(base, extra) {
  var out = {}
  var key
  for (key in base) if (hasOwn(base, key)) out[key] = base[key]
  for (key in extra) if (hasOwn(extra, key)) out[key] = extra[key]
  return out
}

// Set one entry, or drop it when the value is empty — an absent name and a name
// of "" mean the same thing here, and only one of them should reach the file.
function withEntry(map, key, value) {
  var out = {}
  for (var k in map) if (hasOwn(map, k)) out[k] = map[k]
  if (value === "" || value === null || value === undefined) delete out[key]
  else out[key] = value
  return out
}

function isEmptyMap(map) {
  for (var key in map) if (hasOwn(map, key)) return false
  return true
}

// ----------------------------------------------------------------- fetching
//
// Both remote documents reach the QML engine through a StdioCollector, which
// keeps everything a process writes, and curl's --max-time bounds how long a
// fetch runs but not how much it sends. So every fetch goes through
// fetchScript, which holds a hard ceiling on the bytes it downloads and on the
// bytes it hands over, and fails closed — exit 63, nothing on stdout — the
// moment either is crossed. Nothing is ever read in part.
//
// The ceilings sit several times above what each document weighs today, so the
// marketplace can grow into them. The catalog one applies after decompression:
// --compressed turns ~830 KB on the wire into 6.3 MB, and it is the unpacked
// size that would otherwise have no limit.
var statsMaxBytes = 1024 * 1024        // /v1/stats is ~160 KB
var catalogMaxBytes = 16 * 1024 * 1024 // catalog.json is ~6.3 MB unpacked
var listingLinesMaxBytes = 1024 * 1024 // grep's share of it is ~215 KB

// Run as
//   sh -c fetchScript sh <max download> <max output> <grep pattern or ""> <curl args…>
// Every value arrives as a positional argument, so nothing — least of all a
// URL — is ever interpolated into the script text.
//
// The download is capped with head before anything else reads it, grep
// included: grep holds a whole line in memory, and a response with no newline
// in it is one line. The pipeline writes to a private temporary directory
// rather than to stdout so its size can be checked before a single byte is
// passed on. POSIX sh has no pipefail, so curl's own status comes back on fd 3.
// 63 is curl's code for "maximum file size exceeded", reused for both ceilings
// so that curl's --max-filesize refusal and ours read the same.
var fetchScript = [
  'download=$1 output=$2 pattern=$3',
  'shift 3',
  'dir=$(mktemp -d) || exit 1',
  'trap \'rm -rf "$dir"\' EXIT',
  'trap \'exit 1\' HUP INT TERM',
  'rc=$( { { curl --max-filesize "$download" "$@"; echo "$?" >&3; } | head -c "$((download + 1))" > "$dir/body"; } 3>&1 )',
  '[ "$(wc -c < "$dir/body")" -le "$download" ] || exit 63',
  '[ "$rc" = 0 ] || exit "${rc:-1}"',
  'if [ -n "$pattern" ]; then',
  '  grep -E -- "$pattern" "$dir/body" | head -c "$((output + 1))" > "$dir/out"',
  'else',
  '  mv "$dir/body" "$dir/out"',
  'fi',
  '[ "$(wc -c < "$dir/out")" -le "$output" ] || exit 63',
  'cat "$dir/out"'
].join("\n")

// -------------------------------------------------------------------- stats

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
  var body = String(text === undefined || text === null ? "" : text)
  // fetchScript never delivers more than this; refusing it here as well keeps
  // the parser bounded even for a caller that bypasses the script. A string's
  // length never exceeds the UTF-8 byte count it was decoded from.
  if (body.length > statsMaxBytes) return null
  var payload = null
  try {
    payload = JSON.parse(body)
  } catch (e) {
    return null
  }
  return normalizeStats(payload ? payload.plugins : null)
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

// ---------------------------------------------------------------- watchlist

function normalizeWatchlist(list) {
  var out = []
  if (!Array.isArray(list)) return out
  for (var i = 0; i < list.length && out.length < maxWatchlist; i++) {
    var id = list[i]
    if (validPluginId(id) && out.indexOf(id) < 0) out.push(id)
  }
  return out
}

// Returns a list of the same length when the id is invalid or already watched,
// so callers can compare lengths to decide whether anything needs saving.
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

// -------------------------------------------------------------------- names

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

// ------------------------------------------------------------ listing dates

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
//
// Like parseStats, it refuses more than fetchScript would deliver, and answers
// an empty map — which the service reads as "no answer", not "no dates".
function parseListingDates(text) {
  var out = {}
  var body = String(text === undefined || text === null ? "" : text)
  if (body.length > listingLinesMaxBytes) return out
  var lines = body.split("\n")
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

function missingListings(watchlist, listings) {
  var out = []
  var list = normalizeWatchlist(watchlist)
  for (var i = 0; i < list.length; i++) {
    if (!listings || !hasOwn(listings, list[i])) out.push(list[i])
  }
  return out
}

// Downloading the catalog is the most expensive thing this plugin does, so it
// only happens when a watched plugin has no date and the last attempt is old
// enough. Some ids never get one — a first-party plugin has no listing, and a
// typo has no listing either — so without the retry window the panel would
// fetch 830 KB every time it opened, forever, chasing a date that will never
// arrive.
function shouldFetchListings(watchlist, listings, checkedAt, nowMs, retryMs) {
  if (missingListings(watchlist, listings).length === 0) return false
  var last = Number(checkedAt)
  if (!Number.isFinite(last) || last <= 0) return true
  var since = Number(nowMs) - last
  // A clock that has moved backwards must not lock the fetch out indefinitely.
  if (!Number.isFinite(since) || since < 0) return true
  return since >= Number(retryMs)
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

// --------------------------------------------------------------- formatting

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

// A duration as the panel says it, on the same rule as the rate column: one
// decimal below ten, none above. The difference between 3.4 and 3.7 seconds is
// worth seeing on a slider; the difference between 18 and 18.2 is not.
function formatSeconds(ms) {
  return formatRate(Number(ms) / 1000) + " s"
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

// --------------------------------------------------------------------- rows

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
    // panel then renders differently would leave the numbers misaligned. An em
    // dash rather than a zero: a plugin the marketplace has never heard of has
    // no views, which is a different fact from having none yet, and a
    // first-party plugin has no listing date to average over at all.
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
      rated: rated,
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

// ----------------------------------------------------------------- messages

// The hero's status line: what the panel is showing, and how old it is. An
// error outranks the count, because numbers sitting there with no note beside
// them read as current ones.
function summaryLine(rowCount, loading, lastError, fetchedAt, nowMs) {
  if (loading) return "Fetching…"
  if (lastError) return String(lastError)
  if (!rowCount) return "No plugins watched yet"
  return pluralize(rowCount, "plugin") + " · " + relativeAge(nowMs, fetchedAt)
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
  // curl's --max-filesize or fetchScript's own ceiling: either way, nothing
  // was read.
  case 63: return "The marketplace API sent more than the plugin will read"
  default: return "Could not fetch stats (curl exit " + exitCode + ")"
  }
}

// ------------------------------------------------------------------- ticker
//
// The bar ticker is an optional second face for the same numbers: instead of a
// panel you open, one plugin at a time cycles past on the bar as a split-flap
// board — the airport kind, where each character reaches its card by stepping
// forward through a fixed drum.
//
// Everything below decides what the board says and how long it takes to say
// it. The QML draws it and nothing else, which is what makes an animation this
// fiddly checkable at all: the frames, the column widths, the path each cell
// takes and every timing are values a test can look at.

// The columns the ticker can show, in the order it shows them. "rate" is the
// lifetime views-per-day average the panel draws — the same figure, not a
// second one computed differently.
var tickerFieldOrder = ["views", "rate", "copies", "hearts"]

// A drum is a fixed ring of cards, and a cell reaches a character by stepping
// forward through the ring, so what is on the drum decides both what can be
// displayed and how long a change takes to settle. Uppercase is the default
// because that is what these boards are: it nearly halves the ring, and it
// makes a plugin id read as a destination rather than as a package name.
var flapDrumUpper = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.·-—_:/+%…"
var flapDrumMixed = " ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.·-—_:/+%…"

// How many cards a cell rattles through on its way to a character the drum has
// no card for. Enough to read as a flip rather than a cut, short enough that a
// name full of them still settles.
var flapStrayCards = 3

// Timings, all in ms and all clamped rather than trusted: these come out of
// shell.json, where a typo is a number like 3 or 300000 rather than an error.
var tickerDwellDefaultMs = 4200
var tickerDwellMinMs = 1200
var tickerDwellMaxMs = 30000
var tickerFlapDefaultMs = 26
var tickerFlapMinMs = 8
var tickerFlapMaxMs = 250

// A beat between the board settling and the next frame starting, so the numbers
// are readable rather than merely displayed.
var tickerSettleGraceMs = 700

// Ticker mode is the one thing here that polls, because a board nobody has
// clicked on is no use showing last night's numbers. Fifteen minutes is the
// floor as well as the default: engagement counts move over hours, the response
// is 160 KB of every listing on the marketplace, and a setting should be able to
// make this politer but never ruder.
var tickerPollDefaultMinutes = 15
var tickerPollMinMinutes = 15
var tickerPollMaxMinutes = 360

// Names are truncated rather than scrolled: a column that changes width as the
// board cycles would move every number to its right on every frame.
var tickerNameDefaultChars = 14
var tickerNameMinChars = 4
var tickerNameMaxChars = 40

function clampInt(value, fallback, min, max) {
  var n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function padTo(text, width, atStart) {
  var out = String(text === undefined || text === null ? "" : text)
  while (out.length < width) out = atStart ? " " + out : out + " "
  return out
}

function flapDrum(upper) {
  return upper === false ? flapDrumMixed : flapDrumUpper
}

// The cards a cell turns through to get from one character to another, in
// order, ending on the target. Empty when it is already there — the cell tests
// this to decide whether to move at all.
function flapPath(from, to, drum) {
  var ring = String(drum === undefined || drum === null || drum === "" ? flapDrumUpper : drum)
  var start = String(from === undefined || from === null ? "" : from).charAt(0)
  var end = String(to === undefined || to === null ? "" : to).charAt(0)
  if (start === end) return []

  var at = ring.indexOf(start)
  // A card the drum does not have — the cell got there through the branch
  // below. It cannot count from a position the ring has no index for, so it
  // counts from the blank, which is both a real position and the longest,
  // best-looking spin.
  if (at < 0) at = 0

  var out = []
  var i
  var target = ring.indexOf(end)
  if (target < 0) {
    // No card for this character at all. Rather than refuse to show it — a
    // blank in the middle of a name is worse than an approximation of a flip —
    // the cell rattles through a few cards and lands on it.
    for (i = 1; i <= flapStrayCards; i++) out.push(ring.charAt((at + i) % ring.length))
    out.push(end)
    return out
  }

  var steps = (target - at + ring.length) % ring.length
  for (i = 1; i <= steps; i++) out.push(ring.charAt((at + i) % ring.length))
  return out
}

// What the board does when the flip animation is switched off. It still has to
// change plugin somehow, and the two ways of doing it quietly are a slide and a
// cut.
function tickerQuietMotion(value) {
  return String(value === undefined || value === null ? "" : value).toLowerCase() === "none" ? "none" : "roll"
}

// The motion in force: the panel's switch chooses between flipping and quiet,
// and the setting chooses which quiet. One switch decides the thing people
// actually want to decide, and it is in the panel rather than in a config file.
function tickerMotionFor(flip, quietValue) {
  return flip === false ? tickerQuietMotion(quietValue) : "flap"
}

function tickerFlapMs(value) {
  return clampInt(value, tickerFlapDefaultMs, tickerFlapMinMs, tickerFlapMaxMs)
}

function tickerDwellMs(value) {
  return clampInt(value, tickerDwellDefaultMs, tickerDwellMinMs, tickerDwellMaxMs)
}

function tickerPollMs(minutes) {
  return clampInt(minutes, tickerPollDefaultMinutes, tickerPollMinMinutes, tickerPollMaxMinutes) * 60000
}

// The worst case for one cell is a full turn of the drum, which is also the
// worst case for the board: every cell steps at the same rate and stops when it
// arrives, which is why a real board settles left to right without anything
// staggering it deliberately.
function flapSettleMs(drum, flapMs) {
  return String(drum === undefined || drum === null ? "" : drum).length * tickerFlapMs(flapMs)
}

// The shortest dwell that changes anything, which is what the panel's slider
// starts at. Below this the board is still turning cards when the next frame is
// called for, so a slider whose left third did nothing would be a control
// lying about what it controls.
function tickerDwellFloorMs(flapValue, motion, upper) {
  if (motion !== "flap") return tickerDwellMinMs
  return Math.max(tickerDwellMinMs, flapSettleMs(flapDrum(upper), flapValue) + tickerSettleGraceMs)
}

// How long one plugin stays up. A dwell shorter than the board takes to settle
// would start the next frame over a display still in motion, so the flap board
// is never given less time than it needs — the setting raises this, it does not
// lower it below the physics.
function tickerCycleMs(dwellValue, flapValue, motion, upper) {
  return Math.max(tickerDwellMs(dwellValue), tickerDwellFloorMs(flapValue, motion, upper))
}

// Which columns to show, from a setting that may be a list, a comma-separated
// string, or nonsense. Always in `tickerFieldOrder`, never in the order asked
// for: the board reads as a table down the frames, and a table whose columns
// depend on how someone typed them is not one.
function tickerFieldKeys(value) {
  var wanted = value
  if (typeof wanted === "string") wanted = wanted.split(",")
  if (!Array.isArray(wanted)) return tickerFieldOrder.slice()

  var out = []
  for (var i = 0; i < tickerFieldOrder.length; i++) {
    for (var j = 0; j < wanted.length; j++) {
      if (String(wanted[j]).replace(/^\s+|\s+$/g, "") === tickerFieldOrder[i]) {
        out.push(tickerFieldOrder[i])
        break
      }
    }
  }
  // An empty or unrecognisable list would leave a stats ticker showing no
  // stats. Fall back to all of them rather than to a name scrolling past.
  return out.length > 0 ? out : tickerFieldOrder.slice()
}

// The already-rendered string for one column of one row. The panel's strings,
// deliberately: an em dash for a plugin the marketplace has never heard of, and
// the same grouping of long numbers, so the two faces of this plugin cannot
// disagree about what a count is.
function tickerValueText(row, key) {
  if (!row) return ""
  if (key === "views") return String(row.viewsText || "")
  if (key === "rate") return String(row.rateText || "")
  if (key === "copies") return String(row.copiesText || "")
  if (key === "hearts") return String(row.heartsText || "")
  return ""
}

function tickerLabel(row, nameChars, upper) {
  var name = row ? String(row.name || row.id || "") : ""

  // A plugin that is not installed locally has no name to show, only its id,
  // and an id cut from the right is "COM.GITHUB.MA…" — the author's host and
  // nothing else. Drop whole leading segments instead, so a board too narrow
  // for the id still says which plugin it is. Only for a row whose name *is*
  // its id: a real name is the author's own words and gets cut where it runs
  // out of room, not rewritten.
  if (row && name.length > nameChars && String(row.id) === name) {
    var parts = name.split(".")
    while (parts.length > 1 && parts.join(".").length > nameChars) parts.shift()
    name = parts.join(".")
  }

  if (upper !== false) name = name.toUpperCase()
  if (name.length > nameChars) name = name.slice(0, Math.max(1, nameChars - 1)) + "…"
  return name
}

// What the board is made of: the columns it has, how many cells wide each one
// is, and one frame per watched plugin with every string already padded to its
// column.
//
// The widths are computed across every frame rather than per frame, which is
// the whole reason this is one function and not a formatting call per cell: a
// split-flap board has a fixed number of cells, and a column that resized as it
// cycled would drag every column right of it sideways on each flip.
//
// `options` carries the settings — `fields`, `nameChars`, `upper` — plus
// `deltas` from Model.statsDelta, which marks the columns that grew at the last
// fetch so the board can point at them.
function tickerModel(rowList, options) {
  var opts = options || {}
  var fields = tickerFieldKeys(opts.fields)
  var nameChars = clampInt(opts.nameChars, tickerNameDefaultChars, tickerNameMinChars, tickerNameMaxChars)
  var upper = opts.upper !== false
  var deltas = opts.deltas || {}
  var list = Array.isArray(rowList) ? rowList : []
  var columns = ["name"].concat(fields)
  var widths = {}
  var raw = []
  var i, j, key

  for (j = 0; j < columns.length; j++) widths[columns[j]] = 1

  for (i = 0; i < list.length; i++) {
    var texts = { name: tickerLabel(list[i], nameChars, upper) }
    for (j = 0; j < fields.length; j++) texts[fields[j]] = tickerValueText(list[i], fields[j])
    for (j = 0; j < columns.length; j++) {
      key = columns[j]
      if (texts[key].length > widths[key]) widths[key] = texts[key].length
    }
    raw.push({ id: String(list[i] && list[i].id !== undefined ? list[i].id : ""), texts: texts })
  }

  var frames = []
  for (i = 0; i < raw.length; i++) {
    var padded = {}
    var changed = {}
    var delta = hasOwn(deltas, raw[i].id) ? deltas[raw[i].id] : null
    for (j = 0; j < columns.length; j++) {
      key = columns[j]
      // Numbers right-align so their digits stack down the frames; the name
      // pads on the right so it stays against the left edge of the board.
      padded[key] = padTo(raw[i].texts[key], widths[key], key !== "name")
      changed[key] = !!(delta && delta[key] > 0)
    }
    frames.push({ id: raw[i].id, texts: padded, changed: changed })
  }

  return { columns: columns, widths: widths, frames: frames }
}

// What moved between two fetches, for the watched ids only.
//
// Only a plugin both responses knew about can have moved: an id the marketplace
// has just started reporting has no earlier number to have grown from, and
// counting its whole total as a jump would light the board up over nothing.
function statsDelta(previous, next, ids) {
  var out = {}
  var list = normalizeWatchlist(ids)
  for (var i = 0; i < list.length; i++) {
    var id = list[i]
    var before = statsFor(previous, id)
    var after = statsFor(next, id)
    if (!before.known || !after.known) continue
    var delta = {
      views: after.views - before.views,
      copies: after.copies - before.copies,
      hearts: after.hearts - before.hearts
    }
    if (delta.views > 0 || delta.copies > 0 || delta.hearts > 0) out[id] = delta
  }
  return out
}

// Wrapping step through the frames, for the cycle timer and for the scroll
// wheel. Anything that is not a usable index lands on the first frame rather
// than propagating a NaN into a Repeater.
function stepIndex(index, count, delta) {
  var total = Math.trunc(Number(count))
  if (!Number.isFinite(total) || total <= 0) return 0
  var at = Math.trunc(Number(index))
  var by = Math.trunc(Number(delta))
  if (!Number.isFinite(at)) at = 0
  if (!Number.isFinite(by)) by = 0
  var next = (at + by) % total
  return next < 0 ? next + total : next
}

// The bar tooltip, and the ticker's answer to "what am I looking at". The board
// shows one plugin at a time with no header, so the position has to be said
// somewhere.
function tickerTooltip(rowList, index) {
  var list = Array.isArray(rowList) ? rowList : []
  if (list.length === 0) return "No plugins watched yet"
  var at = stepIndex(index, list.length, 0)
  var row = list[at]
  var parts = [String(row.name || row.id)]
  if (row.subtitle) parts.push(String(row.subtitle))
  parts.push((at + 1) + " of " + list.length)
  return parts.join("\n")
}
