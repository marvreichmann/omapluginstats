import QtQuick
import qs.Commons
import qs.Ui

// Bar entry: an icon that toggles the stats panel, and nothing else. The
// numbers deliberately do not appear on the bar — a count that only moves a few
// times a day earns no permanent space there, and putting one up would mean
// polling the marketplace all session for a figure nobody is looking at.
//
// The panel lives in Panel.qml and is loaded once per bar surface so its scroll
// position survives between opens; the watchlist it shows lives in the service,
// which is a single instance for the whole shell.
BarWidget {
  id: root
  moduleName: "com.github.marvreichmann.omapluginstats"

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
  onSettingsChanged: root.injectPanel()

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
    tooltipText: "Plugin stats"

    OpticalGlyph {
      anchors.centerIn: parent
      width: Style.bar.iconCanvas
      height: Style.bar.iconCanvas
      // U+F0128 nf-md-chart_bar, written as a surrogate pair so the source stays
      // readable in editors without the Nerd Font installed.
      text: "\udb80\udd28"
      fontFamily: button.fontFamily
      fontSize: Style.bar.iconFont
      color: button.foreground
    }

    onPressed: function(b) {
      if (!root.bar) return
      root.togglePanel()
    }
  }
}
