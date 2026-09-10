import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// Singleton state owner for the plugin (manifest kind "service"): the
// watchlist, the last numbers fetched for it, and the names read out of any
// installed manifests. Bar widgets are instantiated once per monitor, so a
// two-monitor desk would otherwise keep two watchlists and fetch twice.
//
// The marketplace has one read endpoint, /v1/stats, and it answers with every
// listing at once — around 160 KB for some 2500 plugins. There is no per-plugin
// query and no way to ask for a subset, so a "refresh" is always that one
// request, and the watchlist is applied to the result here rather than by the
// server.
//
// Nothing in this plugin ever posts to /v1/events. That endpoint is what the
// website calls when someone opens a listing, copies its install command or
// hearts it — writing to it from a stats reader would mean the act of watching
// a number changed it.
Item {
  id: root

  // Injected by the shell when the service is constructed.
  property var shell: null
  property var manifest: null
  property string omarchyPath: ""

  readonly property string pluginId: "com.github.marvreichmann.omapluginstats"
  readonly property string statsUrl: "https://api.omarchyplugins.com/v1/stats"
  readonly property string catalogUrl: "https://plugins.omarchy.org/catalog.json"
  readonly property string pluginsDir: (Quickshell.env("XDG_CONFIG_HOME") || Quickshell.env("HOME") + "/.config") + "/omarchy/plugins"
  readonly property string stateDir: (Quickshell.env("XDG_STATE_HOME") || Quickshell.env("HOME") + "/.local/state") + "/omarchy"
  readonly property string statePath: stateDir + "/omapluginstats.json"

  // ------------------------------------------------------------------ state

  // Plugin ids the user has chosen to watch, in the order they added them.
  property var watchlist: []

  // Last known counts, keyed by plugin id — narrowed to the watchlist before it
  // is persisted, but holding the whole response in memory between a fetch and
  // the next watchlist edit so adding an id fills its row immediately.
  property var stats: ({})

  // Plugin id to display name, for the watched plugins that are installed
  // locally. Absent ids are shown as ids.
  property var names: ({})

  // Plugin id to the date its listing went up, which is the denominator of the
  // views-per-day figure. A listing date never changes, so this is cached for
  // good rather than refetched — the catalog is only consulted when a watched
  // plugin has no date yet.
  property var listings: ({})

  // When the catalog was last consulted. Some ids will never get a date — the
  // first-party omarchy.* plugins have none, and a typo has no listing at all —
  // so without this the panel would re-download the catalog on every open.
  property double listingsCheckedAt: 0
  readonly property int listingsRetryMs: 24 * 60 * 60 * 1000

  // When `stats` was last replaced by a successful fetch, as epoch ms. Survives
  // restarts: the panel says how old its numbers are, and numbers cached from
  // last night are still better than an empty panel while curl runs.
  property double fetchedAt: 0

  property string lastError: ""
  readonly property bool loading: statsProc.running
  readonly property bool listingsLoading: listingsProc.running

  // -------------------------------------------------------------- ticker
  //
  // The optional bar display. It lives here rather than in the widget for the
  // same reason the watchlist does: bar widgets are instantiated per monitor,
  // and a board that cycled on its own timer per screen would show a different
  // plugin on each of them.

  // Whether the bar shows the board at all. Persisted — it is a choice the user
  // made, not a session's worth of state — and adopted from the file on change
  // like everything else here, so turning it on from one panel turns it on
  // everywhere.
  property bool ticker: false

  // Which frame is up, and how many widgets are asking the cycle to hold still
  // (a hovered board stops so it can be read). A count rather than a flag: two
  // monitors can be hovered one after the other, and the second must not
  // release the hold the first is still holding.
  property int tickerIndex: 0
  property int tickerHolds: 0

  // Whether the cards flip, and how long one plugin stays up. Both are
  // persisted beside the watchlist, because both are switches the user reaches
  // for in the panel rather than settings they configure once in a file — and
  // because a board that flipped on one monitor and slid on the other would be
  // two boards.
  property bool tickerFlip: true
  property int tickerDwell: Model.tickerDwellMs(undefined)

  // Set by the bar widget out of its shell.json entry — every instance carries
  // the same layout entry, so they all write the same values, already clamped
  // by Model before they arrive.
  property int tickerFlapMs: Model.tickerFlapMs(undefined)
  property bool tickerUpper: true
  property string tickerQuiet: Model.tickerQuietMotion(undefined)
  property int tickerPollMs: Model.tickerPollMs(undefined)

  // The resolved configuration, derived here rather than in the widget: the two
  // halves of it arrive from different places — the switch from the state file,
  // the physics from shell.json — and only the owner of both can put them
  // together once for every monitor.
  readonly property string tickerMotion: Model.tickerMotionFor(tickerFlip, tickerQuiet)
  readonly property int tickerDwellFloorMs: Model.tickerDwellFloorMs(tickerFlapMs, tickerMotion, tickerUpper)
  readonly property int tickerCycleMs: Model.tickerCycleMs(tickerDwell, tickerFlapMs, tickerMotion, tickerUpper)

  // What grew at the last fetch, so the board can point at the number that
  // moved. Session-only and deliberately short-lived: this is "something just
  // happened", not a statistic, and persisting it would mean a highlight
  // surviving a reboot to describe a change from last week.
  property var deltas: ({})
  readonly property int deltaHoldMs: 90 * 1000

  // The fetch this session's deltas are measured from. Zero until this instance
  // has fetched once itself: the numbers loaded from the state file are a cache
  // of unknown age, and diffing against them would light the whole board up on
  // the first refresh after a restart.
  property double sessionFetchedAt: 0

  function setTicker(on) {
    var next = on === true
    if (next === ticker) return
    ticker = next
    flushState()
    if (next) refreshIfStale()
  }

  function setTickerFlip(on) {
    var next = on === true
    if (next === tickerFlip) return
    tickerFlip = next
    flushState()
  }

  // A drag, not a click: the value moves continuously and only the release is
  // the decision. setTickerDwell is the live board following the knob and
  // writes nothing; commitTickerDwell is the user letting go.
  function setTickerDwell(ms) {
    tickerDwell = Model.tickerDwellMs(ms)
  }

  function commitTickerDwell(ms) {
    setTickerDwell(ms)
    flushState()
  }

  // Held by any widget with the cursor on it. Balanced calls: the widget
  // releases exactly what it took.
  function holdTicker(on) {
    tickerHolds = Math.max(0, tickerHolds + (on ? 1 : -1))
  }

  function stepTicker(delta) {
    tickerIndex = Model.stepIndex(tickerIndex, rows.length, delta)
    // A deliberate step gets the full dwell from here, rather than however much
    // was left of the frame it interrupted.
    if (cycleTimer.running) cycleTimer.restart()
  }

  // Opening the panel refreshes, but only if the numbers have had time to
  // change. Engagement counts move over hours; re-fetching 160 KB every time a
  // popup opens would be rude to a marketplace that serves this for free.
  readonly property int staleAfterMs: 5 * 60 * 1000

  // Date.now() is read when the binding evaluates and never re-read on its own,
  // which is what we want: a rate averaged over days does not visibly move
  // within a session, and a ticking clock here would rebuild every row for it.
  readonly property var rows: Model.rows(watchlist, stats, names, listings, Date.now())

  function add(id) {
    var next = Model.addToWatchlist(watchlist, id)
    if (next.length === watchlist.length) return false
    watchlist = next
    flushState()
    // A newly added id is usually already in the response we are holding, in
    // which case its row is populated before the user's finger leaves the key.
    if (!Model.statsFor(stats, id).known) refresh()
    ensureListings()
    return true
  }

  function remove(id) {
    var next = Model.removeFromWatchlist(watchlist, id)
    if (next.length === watchlist.length) return
    watchlist = next
    // The name and date maps are keyed by id and only ever read through the
    // watchlist, so a stale entry is invisible — but it would otherwise sit in
    // the state file forever.
    names = Model.pickMap(names, next)
    listings = Model.pickMap(listings, next)
    flushState(String(id))
  }

  function setName(id, name) {
    var value = String(name || "")
    if (String(names[id] || "") === value) return
    names = Model.withEntry(names, id, value)
  }

  // ------------------------------------------------------------------ fetch

  function refresh() {
    if (statsProc.running) return
    statsProc.running = true
  }

  function refreshIfStale() {
    if (Date.now() - fetchedAt >= staleAfterMs) refresh()
    ensureListings()
  }

  function consume(text) {
    var parsed = Model.parseStats(text)
    if (!parsed) {
      // Exit code 0 with a body we cannot read means the endpoint answered with
      // something other than the stats document — a captive portal, say. The
      // numbers already on screen are still the last true ones.
      lastError = "The marketplace API returned something unreadable"
      return
    }
    // Against the numbers this instance last fetched, never against the ones it
    // loaded from disk — see sessionFetchedAt.
    if (sessionFetchedAt > 0) {
      var moved = Model.statsDelta(stats, parsed, watchlist)
      if (!Model.isEmptyMap(moved)) {
        deltas = moved
        deltaTimer.restart()
      }
    }
    stats = parsed
    fetchedAt = Date.now()
    sessionFetchedAt = fetchedAt
    // A good fetch clears a fetch error, not a refused state file: while that
    // stands nothing is being saved, and the user needs to keep seeing it.
    lastError = stateError
    saveTimer.restart()
  }

  Process {
    id: statsProc
    // Through Model.fetchScript, which caps the response at statsMaxBytes and
    // hands over nothing at all if it runs past that. -f so an HTTP error is an
    // exit code rather than an error page parsed as statistics; -sS keeps the
    // progress meter out of stdout while leaving real failures on stderr.
    command: ["sh", "-c", Model.fetchScript, "sh",
      String(Model.statsMaxBytes), String(Model.statsMaxBytes), "",
      "-fsS", "--max-time", "10", "-H", "Accept: application/json", root.statsUrl]

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.consume(text)
    }

    onExited: function(exitCode) {
      // Success is handled by the collector above: this branch exists so a
      // failed fetch says why instead of leaving the panel looking merely idle.
      if (exitCode !== 0) root.lastError = Model.fetchError(exitCode)
    }
  }

  // --------------------------------------------------------- listing dates

  function ensureListings() {
    if (listingsProc.running) return
    if (!Model.shouldFetchListings(watchlist, listings, listingsCheckedAt, Date.now(), listingsRetryMs)) return
    listingsProc.running = true
  }

  function consumeListings(text) {
    var dates = Model.parseListingDates(text)
    // An empty result means the pipeline produced nothing readable rather than
    // "these plugins have no dates", so it must not count as an answer — the
    // retry window would otherwise lock the panel out for a day over a blip.
    if (Model.isEmptyMap(dates)) return

    // Only the watched ids: the catalog has a date for 2500 plugins and this
    // map is written to the state file.
    var found = Model.pickMap(dates, watchlist)
    listings = Model.mergeMaps(listings, found)
    listingsCheckedAt = Date.now()
    if (!Model.isEmptyMap(found)) flushState()
  }

  Process {
    id: listingsProc
    // The catalog is 6.3 MB of pretty-printed JSON and all we want from it is a
    // date per plugin, so grep does the narrowing before any of it reaches the
    // QML engine: ~215 KB of "id"/"listedAt" lines instead. --compressed keeps
    // the transfer around 830 KB.
    //
    // Model.fetchScript caps the unpacked download at catalogMaxBytes before
    // grep sees it, and grep's output at listingLinesMaxBytes; past either, it
    // hands over nothing, which consumeListings treats as no answer. The script
    // is a constant — the URL, the pattern and the limits are positional
    // arguments, and no watched id or anything else the user can type is among
    // them.
    command: ["sh", "-c", Model.fetchScript, "sh",
      String(Model.catalogMaxBytes), String(Model.listingLinesMaxBytes),
      "^[[:space:]]*\"(id|listedAt)\": ",
      "-fsS", "--compressed", "--max-time", "20", root.catalogUrl]

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.consumeListings(text)
    }
  }

  // ------------------------------------------------------------------ names

  // One checked read per watched plugin, through Model.readScript. A manifest
  // sits in a directory another plugin can write to, so it is never opened by
  // FileView, which would follow a symlink and load a file of any size. A
  // Process is not an Item, so each lives in an Item delegate; the container is
  // invisible and has no size. An id that is not installed — or whose manifest
  // is refused — keeps its id as its label. `timeout` is only a backstop: the
  // script refuses anything that could block before it opens it.
  Item {
    id: nameReaders
    visible: false

    Repeater {
      model: root.watchlist

      delegate: Item {
        id: reader
        required property string modelData

        Process {
          running: true
          command: ["timeout", "5", "sh", "-c", Model.readScript, "sh",
            String(Model.manifestMaxBytes), root.pluginsDir + "/" + reader.modelData + "/manifest.json"]

          stdout: StdioCollector {
            waitForEnd: true
            onStreamFinished: {
              var result = Model.readResult(text, Model.manifestMaxBytes)
              root.setName(reader.modelData, result.status === "ok" ? Model.manifestName(result.body) : "")
            }
          }
        }
      }
    }
  }

  // ------------------------------------------------------------ persistence

  // The state file lives in a directory other plugins can write to, so it is
  // read and written only through Model.readScript and Model.writeScript —
  // never by FileView, which follows a symlink both ways and reads a file of
  // any size. False until a read has come back "ok" or "absent", and false
  // again the moment one comes back refused: a file we will not read is a file
  // we must not overwrite either.
  property bool stateLoaded: false
  property string stateError: ""

  function applyStateRead(text) {
    var result = Model.readResult(text, Model.stateMaxBytes)
    var error = Model.stateReadError(result.status)
    if (error) {
      stateLoaded = false
      if (lastError === "" || lastError === stateError) lastError = error
      stateError = error
      return
    }
    if (stateError) {
      if (lastError === stateError) lastError = ""
      // The watcher may be following whatever a refused symlink pointed at
      // (see stateRetryTimer); point it at the file now at the path.
      stateWatcher.watchChanges = false
      stateWatcher.watchChanges = true
    }
    stateError = ""
    // Absent is a first run: an empty watchlist is the right starting point,
    // and the first write creates the file.
    loadState(result.status === "ok" ? result.body : "")
  }

  // Requests coalesce: a change that lands while a read is running is picked
  // up by one more read after it, however many changes there were.
  property bool stateReadWanted: false

  function readState() {
    stateReadWanted = true
    startStateRead()
  }

  function startStateRead() {
    if (stateReader.running || !stateReadWanted) return
    stateReadWanted = false
    stateReader.running = true
  }

  // Likewise for writes, except that only the newest text is worth writing.
  property string pendingWrite: ""

  function writeState(text) {
    pendingWrite = text
    startStateWrite()
  }

  function startStateWrite() {
    if (stateWriter.running || pendingWrite === "") return
    stateWriter.command = ["sh", "-c", Model.writeScript, "sh",
      String(Model.stateMaxBytes), root.statePath, pendingWrite]
    pendingWrite = ""
    stateWriter.running = true
  }

  // The watchlist as the file last said it was. Writes are merged against this
  // so that nothing but a removal can shorten what is stored.
  property var diskWatchlist: []

  function loadState(text) {
    // Bounded by readScript and readResult already; checked again so this
    // parser is never handed more than the ceiling, whatever calls it.
    if (String(text).length > Model.stateMaxBytes) return
    try {
      var parsed = JSON.parse(text)
      if (parsed) {
        // The watchlist is the user's own data and the file is where it lives,
        // so whatever the file says wins — including when another instance of
        // this service wrote it a moment ago.
        if (Array.isArray(parsed.watchlist)) {
          root.watchlist = Model.normalizeWatchlist(parsed.watchlist)
          root.diskWatchlist = root.watchlist
        }
        // The counts are only a cache, and ours is the better one: a fetch of
        // our own holds every listing, while the file holds just the watched
        // ones. Take the file's copy only when it is the newer of the two.
        var dates = parsed.listings
        if (dates && typeof dates === "object" && !Array.isArray(dates)) {
          var loaded = ({})
          for (var id in dates) if (Model.validPluginId(id) && typeof dates[id] === "string") loaded[id] = dates[id]
          root.listings = loaded
        }
        // The user's choice, like the watchlist: whatever the file says wins,
        // so switching the board on in one shell switches it on in the other.
        if (typeof parsed.ticker === "boolean") root.ticker = parsed.ticker
        if (typeof parsed.tickerFlip === "boolean") root.tickerFlip = parsed.tickerFlip
        var dwell = Number(parsed.tickerDwell)
        if (Number.isFinite(dwell) && dwell > 0) root.tickerDwell = Model.tickerDwellMs(dwell)
        var checked = Number(parsed.listingsCheckedAt)
        if (Number.isFinite(checked) && checked > 0) root.listingsCheckedAt = checked
        var at = Number(parsed.fetchedAt)
        if (Number.isFinite(at) && at > root.fetchedAt) {
          var cached = Model.normalizeStats(parsed.stats)
          if (cached) root.stats = cached
          root.fetchedAt = at
        }
      }
    } catch (e) {
      // No file, or a corrupt one: an empty watchlist is the correct starting
      // point either way, and the panel says how to fill it.
    }
    root.stateLoaded = true
  }

  // `removedId`, when given, is the single id this write is meant to take away.
  // Only remove() passes one.
  function flushState(removedId) {
    if (!stateLoaded) return
    var stored = Model.watchlistToWrite(root.watchlist, root.diskWatchlist, removedId)
    root.diskWatchlist = stored
    writeState(JSON.stringify({
      version: 1,
      watchlist: stored,
      // Only the watched plugins. The rest of the response is 160 KB of other
      // people's listings and would be stale by the next fetch anyway.
      stats: Model.pickMap(root.stats, stored),
      fetchedAt: root.fetchedAt,
      ticker: root.ticker,
      tickerFlip: root.tickerFlip,
      tickerDwell: root.tickerDwell,
      listings: root.listings,
      listingsCheckedAt: root.listingsCheckedAt
    }, null, 2) + "\n")
  }

  // Watched, not read once. Two of these services can be alive at the same
  // moment — a shell restart overlaps the outgoing one, and a plugin reload
  // rebuilds the service under a running shell — and without this the instance
  // that started first keeps an empty watchlist and destroys the real one with
  // its next flush. Adopting the file instead makes the last writer win.
  //
  // This FileView only watches. With preload off and every read and write
  // blocked it never opens the file — checked, not assumed: its access time
  // stays put and an unreadable file draws no read attempt — while its change
  // signal still fires for both an in-place write and a rename over the path.
  // Never call text() on it: that is a read, and it bypasses every check.
  FileView {
    id: stateWatcher
    path: root.statePath
    preload: false
    blockAllReads: true
    blockWrites: true
    watchChanges: true
    printErrors: false
    onFileChanged: root.readState()
  }

  Process {
    id: stateReader
    // `timeout` is only a backstop: readScript refuses anything that could
    // block before it opens it.
    command: ["timeout", "5", "sh", "-c", Model.readScript, "sh",
      String(Model.stateMaxBytes), root.statePath]

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyStateRead(text)
    }

    onExited: Qt.callLater(root.startStateRead)
  }

  Process {
    id: stateWriter

    onExited: function(exitCode) {
      if (exitCode !== 0) root.lastError = "Could not save the state file"
      Qt.callLater(root.startStateWrite)
    }
  }

  // A refused file can be a symlink, and the watcher follows links: it is then
  // watching whatever the link points at, and replacing the link raises no
  // change at all. So while a refusal stands, look again every few seconds —
  // a local check and nothing more; no network — and once the path holds a
  // file we accept, applyStateRead re-arms the watcher on it.
  Timer {
    id: stateRetryTimer
    interval: 5000
    repeat: true
    running: root.stateError !== ""
    onTriggered: root.readState()
  }

  Component.onCompleted: readState()

  Timer {
    id: saveTimer
    interval: 400
    repeat: false
    onTriggered: root.flushState()
  }

  // --------------------------------------------------------------- ticker

  // The one thing in this plugin that polls, and only while the board is on.
  // A panel is asked for; a board is already on screen, and a board showing
  // last night's numbers is worse than no board. Model.tickerPollMs floors this
  // at fifteen minutes: the response is 160 KB of every listing on the
  // marketplace, engagement counts move over hours, and the setting behind it
  // can make this politer but not ruder.
  Timer {
    id: pollTimer
    running: root.ticker && root.stateLoaded && root.watchlist.length > 0
    interval: root.tickerPollMs
    repeat: true
    onTriggered: root.refresh()
  }

  // Nothing to cycle through with one plugin watched, and nothing to cycle at
  // all while a cursor is resting on the board.
  Timer {
    id: cycleTimer
    running: root.ticker && root.tickerHolds === 0 && root.rows.length > 1
    interval: root.tickerCycleMs
    repeat: true
    onTriggered: root.tickerIndex = Model.stepIndex(root.tickerIndex, root.rows.length, 1)
  }

  Timer {
    id: deltaTimer
    interval: root.deltaHoldMs
    repeat: false
    onTriggered: root.deltas = ({})
  }

  // Removing a plugin shortens the board under whatever frame was up.
  onRowsChanged: {
    if (tickerIndex >= rows.length) tickerIndex = Model.stepIndex(tickerIndex, rows.length, 0)
  }
}
