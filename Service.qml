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
    stats = parsed
    fetchedAt = Date.now()
    lastError = ""
    saveTimer.restart()
  }

  Process {
    id: statsProc
    // -f so an HTTP error is an exit code rather than an error page parsed as
    // statistics; -sS keeps the progress meter out of stdout while leaving real
    // failures on stderr.
    command: ["curl", "-fsS", "--max-time", "10", "-H", "Accept: application/json", root.statsUrl]

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
    // This is the one command here that goes through a shell, because it is a
    // pipeline. The string is a constant — no watched id, and nothing else the
    // user can type, is interpolated into it.
    command: ["sh", "-c",
      "curl -fsS --compressed --max-time 20 " + root.catalogUrl
        + " | grep -E '^[[:space:]]*\"(id|listedAt)\": '"]

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.consumeListings(text)
    }
  }

  // ------------------------------------------------------------------ names

  // One reader per watched plugin. A FileView is not an Item, so it needs an
  // Item delegate to live in; the container is invisible and has no size, and
  // an id that is not installed simply fails to load and keeps its id as its
  // label.
  Item {
    id: nameReaders
    visible: false

    Repeater {
      model: root.watchlist

      delegate: Item {
        id: reader
        required property string modelData

        FileView {
          path: root.pluginsDir + "/" + reader.modelData + "/manifest.json"
          watchChanges: false
          printErrors: false
          onLoaded: root.setName(reader.modelData, Model.manifestName(text()))
          onLoadFailed: root.setName(reader.modelData, "")
        }
      }
    }
  }

  // ------------------------------------------------------------ persistence

  property bool stateLoaded: false

  // The watchlist as the file last said it was. Writes are merged against this
  // so that nothing but a removal can shorten what is stored.
  property var diskWatchlist: []

  function loadState(text) {
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
    stateFile.setText(JSON.stringify({
      version: 1,
      watchlist: stored,
      // Only the watched plugins. The rest of the response is 160 KB of other
      // people's listings and would be stale by the next fetch anyway.
      stats: Model.pickMap(root.stats, stored),
      fetchedAt: root.fetchedAt,
      listings: root.listings,
      listingsCheckedAt: root.listingsCheckedAt
    }, null, 2) + "\n")
  }

  // Watched, not read once. Two of these services can be alive at the same
  // moment — a shell restart overlaps the outgoing one, and a plugin reload
  // rebuilds the service under a running shell — and without this the instance
  // that started first keeps an empty watchlist and destroys the real one with
  // its next flush. Adopting the file instead makes the last writer win.
  FileView {
    id: stateFile
    path: root.statePath
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onLoaded: root.loadState(text())
    // The text carried by the change signal is the stale one, so both paths go
    // through reload() → onLoaded to parse what is actually on disk now.
    onFileChanged: reload()
    // First run: the file does not exist yet. Without this branch `stateLoaded`
    // never flips and nothing is ever written.
    onLoadFailed: root.loadState("")
  }

  Timer {
    id: saveTimer
    interval: 400
    repeat: false
    onTriggered: root.flushState()
  }
}
