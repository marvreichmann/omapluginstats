import QtQuick
import qs.Commons
import "Model.js" as Model

// The bar ticker: one watched plugin at a time, cycling, drawn as a split-flap
// board — the airport kind, where every character sits on a drum of cards and
// reaches the one it wants by stepping forward through the ring.
//
// This file is drawing and timing only. What the board says, how wide each
// column is, which cards a cell turns through and how long the whole thing
// takes to settle are all decided by Model.tickerModel, Model.flapPath and
// Model.tickerCycleMs, which is what makes an animation this fiddly checkable
// without a running shell.
//
// Three motions, because a board that flaps is wonderful on a desk and awful in
// a meeting:
//
//   flap  the split-flap board, per character (the default)
//   roll  the whole line slides up and the next one rises behind it
//   none  the line simply changes
//
// The cell count is fixed by the widest value across every frame, so the widget
// keeps its width as it cycles. A column that resized per frame would drag
// every column right of it sideways on each flip, and a bar that reflows itself
// every four seconds is not a bar.
Item {
  id: root

  // Straight out of Model.tickerModel. `columns` and `widths` decide the
  // structure, `frames` the content.
  //
  // These are read through to scalars everywhere below — `widths[key]` as an
  // int, `texts[key]` as a string — deliberately. A fetch rebuilds the whole
  // model object, and a Repeater bound to a fresh array rebuilds its delegates:
  // every cell would reset to blank and the board would re-flap the same text
  // it was already showing, every fifteen minutes, forever.
  property var columns: []
  property var widths: ({})
  property var frames: []

  property int index: 0
  property string motion: "flap"
  property int flapMs: Model.tickerFlapMs(undefined)
  property bool upper: true

  property string fontFamily: Style.font.family
  property real fontSize: Style.font.bodySmall

  property color foreground: Color.foreground
  property color dim: Qt.darker(foreground, 1.5)
  property color accent: Color.accent
  // The bar's own background, which is what the seam between the two halves of
  // a card and the shading on a moving flap tint towards. Deriving those from
  // black would put an invisible seam on a light theme.
  property color shade: Color.background
  // Cards can be turned off for a flatter board that is only text and motion.
  property bool cards: true

  readonly property string drum: Model.flapDrum(upper)
  readonly property var frame: (index >= 0 && index < frames.length) ? frames[index] : null

  // The number and letter cells are the same width because the bar font is
  // monospaced, which is also what lets the columns stack down the frames.
  TextMetrics {
    id: digit
    font.family: root.fontFamily
    font.pixelSize: root.fontSize
    text: "0"
  }

  readonly property int cellWidth: Math.max(4, Math.ceil(digit.advanceWidth) + 2)
  readonly property int cellHeight: Math.max(11, Math.round(fontSize * 1.6))
  // Real boards have a visible gap between cards. One pixel is enough to read
  // as one at this size, and two is a picket fence.
  readonly property int cellGap: 1
  readonly property int segmentGap: Style.spacing.md
  readonly property int glyphGap: Style.spacing.xs
  readonly property int glyphSlot: Math.ceil(fontSize * 1.1)

  readonly property color cardColor: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.075)
  readonly property color seamColor: Qt.rgba(shade.r, shade.g, shade.b, 0.55)

  implicitWidth: board.implicitWidth
  implicitHeight: cellHeight

  function cellsFor(key) {
    var n = widths ? widths[key] : 0
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 1
  }

  // The padded string for one column of the frame on screen. A board with
  // nothing to say still has its cells, so an absent frame is blanks rather
  // than an empty string — otherwise every cell would flap to nothing and the
  // widget would look broken instead of empty.
  function textFor(key) {
    var text = frame && frame.texts ? String(frame.texts[key] || "") : ""
    return Model.padTo(text, cellsFor(key), key !== "name")
  }

  function changedFor(key) {
    return !!(frame && frame.changed && frame.changed[key])
  }

  // The panel's marks, so the two faces of this plugin label a number the same
  // way. Written as surrogate pairs with the codepoint in the comment so the
  // source stays readable without the Nerd Font installed.
  function glyphFor(key) {
    switch (key) {
    case "views": return "\udb80\ude08"   // U+F0208 nf-md-eye
    case "rate": return "\udb81\udcc5"    // U+F04C5 nf-md-speedometer
    case "copies": return "\udb80\udd8f"  // U+F018F nf-md-content_copy
    case "hearts": return "\udb80\uded1"  // U+F02D1 nf-md-heart
    }
    return ""
  }

  // ------------------------------------------------------------------ cards

  // Half a card: the top or the bottom of one character, clipped out of a face
  // drawn at full cell height so the two halves are two halves of the same
  // glyph rather than two glyphs that happen to line up.
  component CardHalf: Item {
    id: half

    property string glyph: " "
    property bool lower: false
    property real faceHeight: height * 2
    property color ink: root.foreground
    // Depth: a flap tips away from the light as it turns. Tinted towards the
    // bar's background rather than towards black, so the cue survives a light
    // theme.
    property real shading: 0
    // The static halves are on screen at rest, where crispness is what matters;
    // the moving ones are transformed, and native hinting under a transform
    // shimmers. Two renderers rather than one compromise.
    property bool moving: false

    clip: true

    Text {
      width: half.width
      height: half.faceHeight
      y: half.lower ? -half.height : 0
      text: half.glyph
      color: half.ink
      font.family: root.fontFamily
      font.pixelSize: root.fontSize
      horizontalAlignment: Text.AlignHCenter
      verticalAlignment: Text.AlignVCenter
      renderType: half.moving ? Text.QtRendering : Text.NativeRendering
      textFormat: Text.PlainText
    }

    Rectangle {
      anchors.fill: parent
      color: root.shade
      opacity: half.shading
      visible: half.shading > 0
    }
  }

  // One character position on the board.
  //
  // The cell owns where it is on the drum, and the only thing it is ever told
  // is where it should be. Given a new target it asks Model.flapPath for the
  // cards between here and there and turns them one at a time — which is why
  // the board settles unevenly without anything staggering it deliberately: a
  // cell one card away is done in a frame, a cell that has to go all the way
  // round takes the full turn.
  component Card: Item {
    id: cell

    property string target: " "
    property color ink: root.foreground

    // Where the cell actually is, and the card it is turning to right now.
    property string current: " "
    property string incoming: " "
    property bool flapping: false
    // 0 to 1 across one card: the upper flap falls through the first half, the
    // lower one rises through the second.
    property real phase: 0

    property var path: []
    property int step: 0

    width: root.cellWidth
    height: root.cellHeight

    function normalized(value) {
      var text = String(value === undefined || value === null ? "" : value)
      return text.length > 0 ? text.charAt(0) : " "
    }

    function begin() {
      var next = normalized(cell.target)
      if (root.motion !== "flap") {
        // The other motions move the whole line; a cell in them is a fixed
        // label. Nothing to turn.
        flapAnim.stop()
        cell.flapping = false
        cell.phase = 0
        cell.current = next
        return
      }
      if (next === cell.current && !cell.flapping) return
      cell.path = Model.flapPath(cell.current, next, root.drum)
      cell.step = 0
      cell.advance()
    }

    function advance() {
      if (cell.step >= cell.path.length) {
        cell.flapping = false
        cell.phase = 0
        return
      }
      cell.incoming = cell.path[cell.step]
      cell.flapping = true
      flapAnim.restart()
    }

    onTargetChanged: cell.begin()
    // The board comes up blank and flaps to its first frame, which is both what
    // one of these does when you switch it on and a free answer to "is this
    // thing live".
    Component.onCompleted: cell.begin()

    NumberAnimation {
      id: flapAnim
      target: cell
      property: "phase"
      from: 0
      to: 1
      duration: root.flapMs
      onFinished: {
        cell.current = cell.incoming
        cell.step += 1
        cell.advance()
      }
    }

    Rectangle {
      anchors.fill: parent
      visible: root.cards
      color: root.cardColor
      radius: 1
    }

    // Bottom half at rest and while the upper flap falls over it: still the old
    // character, because the card that will replace it has not landed yet.
    CardHalf {
      x: 0
      y: cell.height / 2
      width: cell.width
      height: cell.height / 2
      lower: true
      glyph: cell.current
      ink: cell.ink
    }

    // Top half: the new character, revealed as the old one falls off it.
    CardHalf {
      x: 0
      y: 0
      width: cell.width
      height: cell.height / 2
      glyph: cell.flapping ? cell.incoming : cell.current
      ink: cell.ink
    }

    // The old card's top, hinged on the seam, falling forward.
    CardHalf {
      x: 0
      y: 0
      width: cell.width
      height: cell.height / 2
      visible: cell.flapping && cell.phase < 0.5
      moving: true
      glyph: cell.current
      ink: cell.ink
      shading: cell.phase * 1.1
      transform: Rotation {
        origin.x: cell.width / 2
        origin.y: cell.height / 2
        axis { x: 1; y: 0; z: 0 }
        angle: -180 * cell.phase
      }
    }

    // The new card's bottom, hinged on the seam, swinging up into place.
    CardHalf {
      x: 0
      y: cell.height / 2
      width: cell.width
      height: cell.height / 2
      visible: cell.flapping && cell.phase >= 0.5
      lower: true
      moving: true
      glyph: cell.incoming
      ink: cell.ink
      shading: (1 - cell.phase) * 1.1
      transform: Rotation {
        origin.x: cell.width / 2
        origin.y: 0
        axis { x: 1; y: 0; z: 0 }
        angle: 180 * (1 - cell.phase)
      }
    }

    // The seam. Drawn last so it survives whatever is rotating over it, which
    // is the line that makes the whole thing read as two halves of a card
    // rather than as a character being squashed.
    Rectangle {
      x: 0
      y: Math.round(cell.height / 2)
      width: cell.width
      height: 1
      color: root.seamColor
    }
  }

  // ------------------------------------------------------------- flap board

  Row {
    id: board
    anchors.verticalCenter: parent.verticalCenter
    spacing: root.segmentGap

    Repeater {
      model: root.columns

      delegate: Item {
        id: segment
        required property string modelData

        readonly property string columnKey: modelData
        readonly property int cellCount: root.cellsFor(columnKey)
        readonly property string content: root.textFor(columnKey)
        // A value that grew at the last fetch. The board's whole advantage over
        // the panel is that it is already on screen when the number moves, so
        // it may as well say which one did.
        readonly property bool lit: root.changedFor(columnKey)
        readonly property color ink: lit ? root.accent : root.foreground

        readonly property bool hasGlyph: root.glyphFor(columnKey) !== ""
        readonly property int cellsWidth: cellCount * root.cellWidth + Math.max(0, cellCount - 1) * root.cellGap

        implicitWidth: (hasGlyph ? root.glyphSlot + root.glyphGap : 0) + cellsWidth
        implicitHeight: root.cellHeight

        Text {
          id: mark
          visible: segment.hasGlyph
          width: root.glyphSlot
          height: root.cellHeight
          text: root.glyphFor(segment.columnKey)
          color: segment.lit ? root.accent : root.dim
          opacity: segment.lit ? 1.0 : 0.75
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          horizontalAlignment: Text.AlignHCenter
          verticalAlignment: Text.AlignVCenter
          textFormat: Text.PlainText

          Behavior on color {
            ColorAnimation { duration: 240 }
          }
        }

        Row {
          x: segment.hasGlyph ? root.glyphSlot + root.glyphGap : 0
          anchors.verticalCenter: parent.verticalCenter
          spacing: root.cellGap
          visible: root.motion === "flap"

          Repeater {
            // An int, not the frame: this is the structure, and it changes only
            // when a number gains a digit, when the watchlist does, or when the
            // motion changes — the other two motions move the whole line, and
            // build no cells at all rather than hiding a board's worth of them.
            model: root.motion === "flap" ? segment.cellCount : 0

            delegate: Card {
              required property int index
              target: segment.content.charAt(index)
              ink: segment.ink

              Behavior on ink {
                ColorAnimation { duration: 240 }
              }
            }
          }
        }

        // ------------------------------------------------ roll and none
        //
        // The same columns without the cards: the line as plain text, in a
        // clipping window, with the outgoing frame sliding up out of it and the
        // incoming one rising into its place. `none` is the same thing with the
        // slide taken out — a board for people who want the numbers and not the
        // theatre.
        Item {
          x: segment.hasGlyph ? root.glyphSlot + root.glyphGap : 0
          width: segment.cellsWidth
          height: root.cellHeight
          anchors.verticalCenter: parent.verticalCenter
          visible: root.motion !== "flap"
          clip: true

          Text {
            width: parent.width
            height: parent.height
            y: -parent.height * roller.progress
            text: roller.shown >= 0 ? root.textAt(roller.shown, segment.columnKey) : ""
            color: segment.ink
            font.family: root.fontFamily
            font.pixelSize: root.fontSize
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
            renderType: Text.NativeRendering
            textFormat: Text.PlainText
          }

          Text {
            width: parent.width
            height: parent.height
            y: parent.height * (1 - roller.progress)
            visible: roller.progress > 0
            text: root.textAt(roller.target, segment.columnKey)
            color: segment.ink
            font.family: root.fontFamily
            font.pixelSize: root.fontSize
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
            renderType: Text.NativeRendering
            textFormat: Text.PlainText
          }
        }
      }
    }
  }

  // The padded string for one column of any frame, which the rolling board
  // needs for two frames at once.
  function textAt(at, key) {
    var f = (at >= 0 && at < frames.length) ? frames[at] : null
    var text = f && f.texts ? String(f.texts[key] || "") : ""
    return Model.padTo(text, cellsFor(key), key !== "name")
  }

  // Drives both non-flap motions: `progress` walks the outgoing frame up and out
  // of the window while the incoming one rises into it, and the two then swap
  // identities. At a duration of zero this is simply the swap, which is what
  // `none` is.
  //
  // `shown` and `target` are both kept because a roll can be interrupted: the
  // scroll wheel steps the board faster than 260 ms, and a roll that took its
  // outgoing frame from `index` would find `index` had already moved on and
  // slide away from a frame it had never shown.
  QtObject {
    id: roller
    property int shown: 0
    property int target: 0
    property real progress: 0
  }

  NumberAnimation {
    id: rollAnim
    target: roller
    property: "progress"
    from: 0
    to: 1
    duration: root.motion === "none" ? 0 : 260
    easing.type: Easing.OutCubic
    onFinished: {
      roller.shown = roller.target
      roller.progress = 0
    }
  }

  function startRoll() {
    // An interrupted roll lands first. Its incoming frame becomes the outgoing
    // one, so the next roll starts from what the eye last saw rather than from
    // the frame before it.
    if (rollAnim.running) {
      rollAnim.stop()
      roller.shown = roller.target
      roller.progress = 0
    }
    roller.target = root.index
    if (roller.target === roller.shown) return
    rollAnim.restart()
  }

  onIndexChanged: {
    if (root.motion === "flap") return
    root.startRoll()
  }

  onMotionChanged: {
    rollAnim.stop()
    roller.progress = 0
    roller.shown = root.index
    roller.target = root.index
  }

  onFramesChanged: {
    if (roller.shown >= frames.length) roller.shown = 0
    if (roller.target >= frames.length) roller.target = 0
  }
}
