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

  // When `stats` was last replaced by a successful fetch, as epoch ms. Survives
  // restarts: the panel says how old its numbers are, and numbers cached from
  // last night are still better than an empty panel while curl runs.
  property double fetchedAt: 0

  property string lastError: ""
  readonly property bool loading: statsProc.running

  // Opening the panel refreshes, but only if the numbers have had time to
  // change. Engagement counts move over hours; re-fetching 160 KB every time a
  // popup opens would be rude to a marketplace that serves this for free.
  readonly property int staleAfterMs: 5 * 60 * 1000

  readonly property var rows: Model.rows(watchlist, stats, names)

  function add(id) {
    var next = Model.addToWatchlist(watchlist, id)
    if (next.length === watchlist.length) return false
    watchlist = next
    flushState()
    // A newly added id is usually already in the response we are holding, in
    // which case its row is populated before the user's finger leaves the key.
    if (!Model.statsFor(stats, id).known) refresh()
    return true
  }

  function remove(id) {
    var next = Model.removeFromWatchlist(watchlist, id)
    if (next.length === watchlist.length) return
    watchlist = next
    // The name map is keyed by id and only ever read through the watchlist, so
    // a stale entry is harmless — but it would otherwise be written to the
    // state file forever.
    var trimmed = ({})
    for (var i = 0; i < next.length; i++) if (names[next[i]] !== undefined) trimmed[next[i]] = names[next[i]]
    names = trimmed
    flushState()
  }

  function setName(id, name) {
    var value = String(name || "")
    if (String(names[id] || "") === value) return
    var next = ({})
    for (var k in names) next[k] = names[k]
    if (value === "") delete next[id]
    else next[id] = value
    names = next
  }

  // ------------------------------------------------------------------ fetch

  function refresh() {
    if (statsProc.running) return
    statsProc.running = true
  }

  function refreshIfStale() {
    if (Date.now() - fetchedAt >= staleAfterMs) refresh()
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

  function loadState(text) {
    try {
      var parsed = JSON.parse(text)
      if (parsed) {
        // The watchlist is the user's own data and the file is where it lives,
        // so whatever the file says wins — including when another instance of
        // this service wrote it a moment ago.
        if (Array.isArray(parsed.watchlist)) root.watchlist = Model.normalizeWatchlist(parsed.watchlist)
        // The counts are only a cache, and ours is the better one: a fetch of
        // our own holds every listing, while the file holds just the watched
        // ones. Take the file's copy only when it is the newer of the two.
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

  function flushState() {
    if (!stateLoaded) return
    stateFile.setText(JSON.stringify({
      version: 1,
      watchlist: root.watchlist,
      // Only the watched plugins. The rest of the response is 160 KB of other
      // people's listings and would be stale by the next fetch anyway.
      stats: Model.pickStats(root.stats, root.watchlist),
      fetchedAt: root.fetchedAt
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
