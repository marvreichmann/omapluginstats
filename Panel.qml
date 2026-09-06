import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Stats popup: one row per watched plugin, three numbers each. All state lives
// in the service — this file renders it, adds and removes ids, and asks for a
// refresh, so the bar surfaces on a multi-monitor setup stay in agreement.
Panel {
  id: root
  moduleName: "com.github.marvreichmann.omapluginstats"
  ipcTarget: "com.github.marvreichmann.omapluginstats"

  property var anchorItem: null

  // The bar tracks the widget mounted in its slot — BarWidget.qml — not this
  // nested panel, so popup coordination has to be keyed on the host.
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  // The shell injects `service` only into panels loaded from the manifest's
  // `panel` entry point. This one is nested inside the bar widget instead, so
  // it reaches the singleton the way any bar-hosted component has to: through
  // the bar's shell reference.
  readonly property var service: bar && bar.shell ? bar.shell.serviceFor("com.github.marvreichmann.omapluginstats") : null

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar && bar.urgent !== undefined ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property var rows: service ? service.rows : []

  // Ticks while the panel is open so the hero's "updated 3 min ago" ages in
  // place rather than freezing at whatever it said when the popup appeared.
  property double now: Date.now()

  // Whether the add field is showing. It stays out of the way until asked for:
  // a watchlist is built once and then read for months.
  property bool adding: false

  // The card's inner padding, and therefore the amount the hero, the messages
  // and the footer are inset by so that their contents share the rows' left
  // edge. The cards themselves span the full content column, putting their
  // border on the same line as the footer buttons.
  readonly property int rowInset: Style.spacing.rowPaddingX

  // The leading icon column for the hero. OpticalGlyph is an Item with no
  // implicit size that centres its text on itself, so a glyph given no width is
  // a zero-wide box with half the mark hanging off its left edge — every glyph
  // in this file is sized explicitly.
  readonly property int iconColumn: Style.space(24)

  // Digit cell of the bar font, which is monospaced. The three number columns
  // are sized from it, so they line up down the panel and take exactly the
  // width the largest number in them needs.
  TextMetrics {
    id: digit
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
    text: "0"
  }

  readonly property int glyphWidth: Style.space(16)
  readonly property int statGap: Style.spacing.controlGap
  function columnWidth(key) {
    return glyphWidth + Style.spacing.sm + Math.ceil(digit.advanceWidth * Model.maxChars(rows, key))
  }

  readonly property string heroMeta: {
    if (!service) return "Service unavailable"
    if (service.loading) return "Fetching…"
    if (service.lastError !== "") return service.lastError
    if (rows.length === 0) return "No plugins watched yet"
    return Model.pluralize(rows.length, "plugin") + " · " + Model.relativeAge(now, service.fetchedAt)
  }

  function openFromHotkey() { root.controller.show() }

  function addFromField() {
    if (!service) return
    var value = addField.text.replace(/^\s+|\s+$/g, "")
    if (value === "") { root.adding = false; return }
    if (!service.add(value)) {
      // Either the id is malformed or it is already on the list. Both are
      // answered by leaving the text where it is: nothing was lost, and the
      // field still holds what the user typed for them to fix.
      addField.selectAll()
      return
    }
    addField.text = ""
    root.adding = false
  }

  onOpenedChanged: {
    if (!opened) {
      adding = false
      addField.text = ""
      return
    }
    now = Date.now()
    // Cheap when the numbers are fresh — the service refuses anything under
    // five minutes old — and the only thing that ever triggers a fetch besides
    // the Refresh button.
    if (service) service.refreshIfStale()
  }

  Timer {
    running: root.opened
    interval: 30000
    repeat: true
    onTriggered: root.now = Date.now()
  }

  // One number and its mark. Fixed width per column so the three columns line
  // up across rows; the number is right-aligned inside it for the same reason.
  component StatCell: Item {
    id: cell
    property string glyph: ""
    // Already rendered by Model.rows, because the column widths are counted off
    // these same strings.
    property string display: ""
    property bool known: true
    property string tooltip: ""
    property color tint: root.dim

    implicitHeight: Math.max(cellGlyph.implicitHeight, cellText.implicitHeight)

    OpticalGlyph {
      id: cellGlyph
      anchors.left: parent.left
      anchors.verticalCenter: parent.verticalCenter
      width: root.glyphWidth
      height: Style.font.icon
      text: cell.glyph
      fontSize: Style.font.caption
      fontFamily: root.fontFamily
      color: cell.tint
      opacity: 0.8
    }

    Text {
      id: cellText
      anchors.left: cellGlyph.right
      anchors.leftMargin: Style.spacing.sm
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      text: cell.display
      color: cell.known ? root.foreground : root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      horizontalAlignment: Text.AlignRight
      textFormat: Text.PlainText
    }

    PanelToolTip {
      visible: cellHover.hovered && cell.tooltip !== ""
      text: cell.tooltip
      fontFamily: root.fontFamily
    }

    HoverHandler { id: cellHover }
  }

  // KeyboardPanel, not PopupCard. PopupCard is an xdg-popup, which only ever
  // receives keys once a click or hover has routed focus through its parent
  // surface. KeyboardPanel is the layer-shell equivalent with the same API plus
  // a keyboard-focus prime, and `focusTarget` hands active focus to the key
  // catcher once the surface has mapped.
  KeyboardPanel {
    id: card
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    padding: Style.space(16)
    contentWidth: card.fittedContentWidth(Style.space(510))
    contentHeight: card.fittedContentHeight(content.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // While the add field is open it must receive the keystrokes itself,
      // including the Escape that dismisses it.
      blocked: root.adding
      onCloseRequested: root.close()
    }

    Column {
      id: content
      width: parent.width
      spacing: Style.spacing.xxl

      // ------------------------------------------------------------- hero

      PanelHero {
        x: root.rowInset
        width: parent.width - root.rowInset
        title: "Plugin Stats"
        meta: root.heroMeta
        foreground: root.foreground
        fontFamily: root.fontFamily
        iconOpacity: (root.service && root.service.lastError === "") ? 1.0 : 0.5

        iconComponent: Component {
          OpticalGlyph {
            // U+F0128 nf-md-chart_bar, the same mark as the bar widget.
            text: "\udb80\udd28"
            width: root.iconColumn
            height: root.iconColumn
            fontSize: Style.font.display
            color: root.foreground
          }
        }
      }

      PanelSeparator { foreground: root.foreground }

      // ---------------------------------------------------------- messages

      Text {
        x: root.rowInset
        width: parent.width - root.rowInset
        visible: !root.service
        text: "Enable the omapluginstats service by adding the widget to your bar in shell.json."
        color: root.urgent
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        wrapMode: Text.WordWrap
        textFormat: Text.PlainText
      }

      Text {
        x: root.rowInset
        width: parent.width - root.rowInset
        visible: root.service ? root.rows.length === 0 : false
        text: "Nothing watched yet. Add a plugin id — the one in its manifest, "
          + "shown on its marketplace listing — and its views, copies and hearts appear here."
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        wrapMode: Text.WordWrap
        textFormat: Text.PlainText
      }

      // -------------------------------------------------------------- rows

      Column {
        width: parent.width
        spacing: Style.spacing.sm

        Repeater {
          model: root.rows

          delegate: BorderSurface {
            id: rowCard
            required property var modelData

            readonly property bool hot: hover.hovered

            width: parent.width
            implicitHeight: rowColumn.implicitHeight + contentTopInset + contentBottomInset
            height: implicitHeight
            radius: Style.cornerRadius
            topPadding: Style.spacing.rowPaddingX
            bottomPadding: Style.spacing.rowPaddingX
            // Measured off the live border rather than fixed, so the contents
            // do not shift sideways when the border changes on hover.
            leftPadding: Math.max(0, root.rowInset - borderLeft)
            rightPadding: Math.max(0, root.rowInset - borderRight)
            color: hot ? Style.hoverFillFor(root.foreground, Color.accent)
                       : Style.normalFillFor(root.foreground, Color.accent)
            borderSpec: Border.controlSpec(hot ? "hover-cursor" : "normal", root.foreground, Color.accent)

            Behavior on color {
              ColorAnimation { duration: 120; easing.type: Easing.OutCubic }
            }

            HoverHandler { id: hover }

            Item {
              id: rowColumn
              anchors.top: parent.top
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.topMargin: rowCard.contentTopInset
              anchors.leftMargin: rowCard.contentLeftInset
              anchors.rightMargin: rowCard.contentRightInset
              implicitHeight: Math.max(labels.implicitHeight, stats.implicitHeight, removeButton.implicitHeight)

              Column {
                id: labels
                anchors.left: parent.left
                anchors.right: stats.left
                anchors.rightMargin: Style.spacing.controlGap
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.spacing.xxs

                Text {
                  width: parent.width
                  text: rowCard.modelData.name
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  elide: Text.ElideRight
                  textFormat: Text.PlainText
                }

                // The id, but only when it is not already the line above — an
                // uninstalled plugin has nothing to show but its id.
                Text {
                  width: parent.width
                  visible: rowCard.modelData.subtitle !== "" || !rowCard.modelData.known
                  text: rowCard.modelData.known ? rowCard.modelData.subtitle
                                                : (rowCard.modelData.subtitle !== ""
                                                   ? rowCard.modelData.subtitle + " · not on the marketplace"
                                                   : "Not on the marketplace")
                  color: rowCard.modelData.known ? root.dim : root.urgent
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                  textFormat: Text.PlainText
                }
              }

              Row {
                id: stats
                anchors.right: removeButton.left
                anchors.rightMargin: Style.spacing.sm
                anchors.verticalCenter: parent.verticalCenter
                spacing: root.statGap

                StatCell {
                  width: root.columnWidth("viewsText")
                  // U+F0208 nf-md-eye
                  glyph: "\udb80\ude08"
                  display: rowCard.modelData.viewsText
                  known: rowCard.modelData.known
                  tooltip: "Listing views"
                }

                StatCell {
                  width: root.columnWidth("rateText")
                  // U+F04C5 nf-md-speedometer
                  glyph: "\udb81\udcc5"
                  display: rowCard.modelData.rateText
                  known: rowCard.modelData.rated
                  tooltip: rowCard.modelData.rated
                    ? "Views per day since listing — " + Model.formatCount(rowCard.modelData.views)
                      + " over " + Model.pluralize(rowCard.modelData.days, "day")
                    : (rowCard.modelData.known
                       ? "No listing date — first-party plugins are not listed"
                       : "Views per day since listing")
                }

                StatCell {
                  width: root.columnWidth("copiesText")
                  // U+F018F nf-md-content_copy
                  glyph: "\udb80\udd8f"
                  display: rowCard.modelData.copiesText
                  known: rowCard.modelData.known
                  tooltip: "Install command copied"
                }

                StatCell {
                  width: root.columnWidth("heartsText")
                  // U+F02D1 nf-md-heart
                  glyph: "\udb80\uded1"
                  display: rowCard.modelData.heartsText
                  known: rowCard.modelData.known
                  tooltip: "Hearts"
                  tint: rowCard.modelData.hearts > 0 ? Color.accent : root.dim
                }
              }

              // Present but recessive until the row is under the cursor, so the
              // resting panel stays quiet without hiding the control from
              // anyone looking for it.
              PanelActionButton {
                id: removeButton
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                opacity: rowCard.hot ? 1.0 : 0.0
                // U+F09E7 nf-md-trash_can_outline
                iconText: "\udb82\udde7"
                tooltipText: "Stop watching this plugin"
                foreground: root.foreground
                fontFamily: root.fontFamily
                fontSize: Style.font.bodySmall
                onClicked: if (root.service) root.service.remove(rowCard.modelData.id)

                Behavior on opacity {
                  NumberAnimation { duration: 120; easing.type: Easing.OutCubic }
                }
              }
            }
          }
        }
      }

      // --------------------------------------------------------- add a row

      Item {
        width: parent.width
        visible: root.adding
        implicitHeight: addRow.implicitHeight

        Row {
          id: addRow
          width: parent.width
          spacing: Style.spacing.controlGap

          TextField {
            id: addField
            width: parent.width - addButton.width - parent.spacing
            foreground: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            placeholderText: "Plugin id, e.g. com.github.you.yourplugin"
            onAccepted: root.addFromField()
            Keys.onEscapePressed: function(event) {
              root.adding = false
              addField.text = ""
              event.accepted = true
            }
          }

          Button {
            id: addButton
            text: "Add"
            bordered: true
            foreground: root.foreground
            fontFamily: root.fontFamily
            fontSize: Style.font.bodySmall
            onClicked: root.addFromField()
          }
        }
      }

      // ------------------------------------------------------------ footer

      Item {
        width: parent.width
        implicitHeight: footerRow.implicitHeight

        Row {
          id: footerRow
          anchors.right: parent.right
          spacing: Style.spacing.sm

          Button {
            text: "Watch a plugin"
            bordered: true
            visible: !root.adding
            foreground: root.foreground
            fontFamily: root.fontFamily
            fontSize: Style.font.bodySmall
            // Button sizes itself to its tallest content, and the icon defaults
            // to Style.font.icon — larger than the label. Left alone, the two
            // buttons carrying a mark come out taller than Close.
            iconSize: Style.font.bodySmall
            // U+F0415 nf-md-plus
            iconText: "\udb81\udc15"
            tooltipText: "Add a plugin id to the watchlist"
            enabled: root.service !== null
            opacity: enabled ? 1.0 : 0.4
            onClicked: {
              root.adding = true
              addField.forceActiveFocus()
            }
          }

          Button {
            text: "Refresh"
            bordered: true
            foreground: root.foreground
            fontFamily: root.fontFamily
            fontSize: Style.font.bodySmall
            iconSize: Style.font.bodySmall
            // U+F0450 nf-md-refresh
            iconText: "\udb81\udc50"
            iconSpinning: root.service ? root.service.loading : false
            tooltipText: "Fetch the current numbers"
            // Item.enabled blocks the button's input but paints nothing
            // differently, so the dimming has to be explicit.
            enabled: root.service ? !root.service.loading : false
            opacity: enabled ? 1.0 : 0.4
            onClicked: if (root.service) root.service.refresh()
          }

          Button {
            text: "Close"
            bordered: true
            foreground: root.foreground
            fontFamily: root.fontFamily
            fontSize: Style.font.bodySmall
            onClicked: root.close()
          }
        }
      }
    }
  }
}
