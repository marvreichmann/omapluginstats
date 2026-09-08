import QtQuick
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Bar entry. Two faces, and which one is up is the user's choice:
//
//   Resting, it is an icon that toggles the stats panel and nothing else. A
//   count that only moves a few times a day earns no permanent space on a bar,
//   and putting one up would mean polling the marketplace all session for a
//   figure nobody is looking at.
//
//   Ticker mode turns that argument around: a board that is already on screen
//   when a number moves is the one place the number moving is worth watching,
//   and it is switched on deliberately from the panel. It cycles the watchlist
//   as a split-flap display — see Ticker.qml — and it is the reason the service
//   grows a poll. The poll only runs while the board is on.
//
// The panel lives in Panel.qml and is loaded once per bar surface so its scroll
// position survives between opens. The watchlist it shows, the numbers, the
// board's current frame and whether the board is on at all live in the service,
// which is a single instance for the whole shell — so two monitors show the
// same plugin at the same moment rather than two boards racing each other.
BarWidget {
  id: root
  moduleName: "com.github.marvreichmann.omapluginstats"

  readonly property string pluginId: "com.github.marvreichmann.omapluginstats"
  readonly property var service: bar && bar.shell ? bar.shell.serviceFor(pluginId) : null

  // ------------------------------------------------------------- settings
  //
  // Presentation only, out of this widget's shell.json layout entry. The three
  // things a user actually reaches for — whether the board is on, whether it
  // flips, and how long a plugin stays up — are not here: those are switches in
  // the panel, kept in the plugin's own state file, so they cannot disagree
  // with themselves and so touching one never rewrites the user's shell.json.
  readonly property var tickerFields: Model.tickerFieldKeys(setting("tickerFields", undefined))
  readonly property int tickerNameChars: Number(setting("tickerNameChars", 14))
  readonly property bool tickerUpper: setting("tickerUppercase", true) !== false
  readonly property bool tickerCards: setting("tickerCards", true) !== false
  readonly property int tickerFlapMs: Model.tickerFlapMs(setting("tickerFlapMs", undefined))
  readonly property string tickerQuiet: Model.tickerQuietMotion(setting("tickerQuietMotion", undefined))

  // Resolved by the service, which is the only place that holds both halves.
  readonly property string tickerMotion: service ? service.tickerMotion : "flap"

  readonly property var rows: service ? service.rows : []
  readonly property var board: Model.tickerModel(rows, {
    fields: tickerFields,
    nameChars: tickerNameChars,
    upper: tickerUpper,
    deltas: service ? service.deltas : ({})
  })

  // A vertical bar is one icon wide by definition, and a board turned on its
  // side is neither readable nor a board. The panel is the whole feature there.
  readonly property bool showBoard: service !== null && service.ticker === true
    && !root.vertical && board.frames.length > 0

  // The cycle and the poll are the service's to run — one of each for every
  // monitor — but half of what decides them is in this widget's layout entry.
  // Every instance carries the same entry, so they all push the same values and
  // it does not matter which one gets there last.
  function applyTickerSettings() {
    if (!service) return
    service.tickerFlapMs = root.tickerFlapMs
    service.tickerUpper = root.tickerUpper
    service.tickerQuiet = root.tickerQuiet
    service.tickerPollMs = Model.tickerPollMs(setting("refreshMinutes", undefined))
  }

  onServiceChanged: root.applyTickerSettings()
  onSettingsChanged: {
    root.injectPanel()
    root.applyTickerSettings()
  }
  Component.onCompleted: root.applyTickerSettings()

  // ------------------------------------------------------- cycle hold

  // The board stops while the cursor is on it, because a display that changes
  // as you lean in to read it is a display you cannot read. The hold is taken
  // and released in pairs — the service counts them, so a second monitor being
  // hovered does not release the first one's hold.
  property bool holding: false

  function setHold(on) {
    var next = on === true
    if (next === holding) return
    holding = next
    if (service) service.holdTicker(next)
  }

  onShowBoardChanged: if (!showBoard) root.setHold(false)
  Component.onDestruction: root.setHold(false)

  // --------------------------------------------------------------- panel

  // The bar injects `bar`, `moduleName` and `settings` — nothing else. A nested
  // panel gets none of them unless we hand them over, and `anchorItem` is what
  // positions the popup against this button.
  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  function togglePanel() {
    if (panelLoader.item && panelLoader.item.toggle) panelLoader.item.toggle()
  }

  // Shape contract for the bar's summon/hide/toggle routing: the bar tracks the
  // widget mounted in its slot, not the nested panel.
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() { if (panelLoader.item && panelLoader.item.openFromHotkey) panelLoader.item.openFromHotkey() }
  function close() { if (panelLoader.item && panelLoader.item.close) panelLoader.item.close() }
  function toggle() { root.togglePanel() }

  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false
  function closeForPopoutSwitch() {
    if (panelLoader.item && panelLoader.item.closeForPopoutSwitch) panelLoader.item.closeForPopoutSwitch()
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: root.injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: ""
    labelVisible: false
    hasVisualContent: true
    // WidgetButton sizes itself from its label, and this one has none. With the
    // board up the slot has to be as wide as the board plus its icon; without
    // it, WidgetButton's own icon-sized default is right.
    fixedWidth: root.showBoard ? Math.ceil(content.implicitWidth) + Style.spacing.rowPaddingX : -1
    tooltipText: root.showBoard ? Model.tickerTooltip(root.rows, root.service ? root.service.tickerIndex : 0)
                                : "Plugin stats"

    onTooltipHoveredChanged: root.setHold(button.tooltipHovered)

    Row {
      id: content
      anchors.centerIn: parent
      spacing: Style.spacing.md

      OpticalGlyph {
        anchors.verticalCenter: parent.verticalCenter
        width: Style.bar.iconCanvas
        height: Style.bar.iconCanvas
        // U+F0128 nf-md-chart_bar, written as a surrogate pair so the source
        // stays readable in editors without the Nerd Font installed.
        text: "\udb80\udd28"
        fontFamily: button.fontFamily
        fontSize: Style.bar.iconFont
        color: button.foreground
        // Dimmed while the last fetch is failing, which on a board that nobody
        // clicks is the only place the failure can be said at all.
        opacity: root.service && root.service.lastError !== "" ? 0.45 : 1.0

        Behavior on opacity {
          NumberAnimation { duration: 200 }
        }
      }

      Loader {
        id: boardLoader
        anchors.verticalCenter: parent.verticalCenter
        // Absent, not merely hidden: an inactive Loader is no cells, no
        // animations and no timers, which is what "optional mode" has to mean
        // for anything living on a bar.
        active: root.showBoard
        visible: root.showBoard

        sourceComponent: Ticker {
          columns: root.board.columns
          widths: root.board.widths
          frames: root.board.frames
          index: root.service ? root.service.tickerIndex : 0
          motion: root.tickerMotion
          flapMs: root.tickerFlapMs
          upper: root.tickerUpper
          cards: root.tickerCards
          fontFamily: button.fontFamily
          fontSize: Style.font.bodySmall
          foreground: button.foreground
          accent: root.bar && root.bar.urgent !== undefined ? root.bar.urgent : Color.accent
          shade: root.bar ? root.bar.background : Color.background
        }
      }
    }

    onPressed: function(b) {
      if (!root.bar) return
      root.togglePanel()
    }

    // The wheel walks the board by hand. Up goes back, which is the direction
    // the cards came from.
    onWheelMoved: function(delta) {
      if (!root.showBoard || !root.service) return
      root.service.stepTicker(delta > 0 ? -1 : 1)
    }
  }
}
