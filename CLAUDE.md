# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Omarchy shell plugin (QML / Quickshell) that shows the marketplace's own
engagement counts — views, copies, hearts — for a watchlist of plugin ids, in a
panel and optionally as a split-flap ticker on the bar itself. There is no build
step: the plugin is the five source files at the repository root plus
`manifest.json`. `README.md` documents the user-facing behaviour and
`CHANGELOG.md` the release history. `tests/` holds unit tests for `Model.js` and
is not installed (the install copies named files).

Develop in this repository, never in the installed copy.

For any question about the rules an Omarchy plugin has to follow — manifest
schema, entry points and kinds, what the shell loads and when, the plugin APIs —
consult <https://plugins.omarchy.org/develop.html> rather than guessing. The
notes below record what this plugin actually depends on; that page is the
authority.

## The marketplace API

Everything this plugin displays comes from one request:

```sh
curl -fsS https://api.omarchyplugins.com/v1/stats
```

Verified against the live endpoint rather than documentation, because there is
none:

- It answers `{ "schemaVersion": 1, "plugins": { "<id>": { "views", "copies",
  "hearts" } } }` for **every** listing at once — around 2500 of them, 160 KB,
  in roughly 0.3 s. There is no per-plugin query and no way to ask for a subset,
  so a refresh is always the whole document and the watchlist is applied here.
- A plugin with no engagement at all is simply absent from `plugins`, which is
  why `Model.statsFor` reports `known: false` rather than three zeros — a typo'd
  id would otherwise read as a real listing nobody has opened.
- The base URL is the one the website itself uses, from
  `https://plugins.omarchy.org/assets/js/engagement.js`. The same file defines
  the id pattern `Model.validPluginId` copies.

**Never post to `/v1/events`.** That is the endpoint the website calls to
*record* a view, a copy or a heart. A stats reader that writes to it would
inflate the numbers it exists to report — including other people's. This plugin
issues exactly one HTTP request, and it is a GET.

There is **no history of any kind**, which was checked rather than assumed
before anyone asks for a trend line: ten other paths (`/v1/stats/<id>`,
`/v1/history`, `/v1/plugins/<id>/history`, `/v1/trends`, …) all 404, and
`?days=7`, `?since=`, `?period=7d` return the identical payload. The only time
series the site publishes is `explorer-data.json`'s `growth`, and that is the
size of the catalog per day, not per-plugin engagement. A real "views this week"
therefore means sampling the totals ourselves daily for a week first — see the
views-per-day note below for what is possible without that.

## The catalog

`catalog.json` is the source of two things this plugin cannot get from the API,
and it is 6.3 MB of pretty-printed JSON — far too much to hand to the QML engine
for a few dozen bytes:

- **Names** are not taken from it at all. They come from installed manifests
  (`Service.qml`'s `nameReaders`); anything not installed is shown by id.
- **Listing dates** are, because there is nowhere else. `listingsProc` pipes the
  download through `grep` so only the `"id"` and `"listedAt"` lines arrive —
  about 215 KB of text, and `--compressed` keeps the transfer near 830 KB.
  `Model.parseListingDates` pairs each date with the id above it.

That pairing is sound because of how the file is shaped, and this was verified
against a full parse rather than eyeballed: exactly one `"id"` line per plugin
(2538 of them), all at the same nesting depth, 2502 `"listedAt"` lines, zero
mismatches. The 36 plugins without a date are the first-party `omarchy.*` ones,
which are not community listings — they show a dash for the rate, and
`listingsCheckedAt` stops the panel re-downloading the catalog every open
looking for a date they will never have.

`explorer-data.json` also carries `listedAt` and is a third of the size, but it
covers only the 2502 listed plugins and would need a second source for the rest,
so the catalog is the one to use.

## Tests

`Model.js` is covered by unit tests, run with Node's built-in runner — no
dependencies, nothing to install:

```sh
node --test tests/
```

`tests/model.js` evaluates `Model.js` (minus its `.pragma library` line) in the
host realm and returns its top-level declarations, so a new pure function is
testable without an export list — and without the cross-realm prototypes that
make every `deepEqual` fail while printing two identical-looking values.

This is why `Model.js` exists: response parsing, watchlist edits and row
assembly become checkable in milliseconds instead of by restarting the shell.
Prefer extracting to it over testing through QML.

## Test loop

Testing the QML requires copying everything to the installed location, whose
folder name must match `manifest.json`'s `id`:

```sh
cp -a manifest.json *.qml *.js README.md LICENSE preview.png \
  ~/.config/omarchy/plugins/com.github.marvreichmann.omapluginstats/
```

The shell watches local plugins and reloads on change, but a failed load is not
retried until a full rescan, so after fixing a QML syntax error restart outright:

```sh
omarchy-restart-shell
journalctl --user --since -20s | grep omapluginstats
omarchy-shell com.github.marvreichmann.omapluginstats open   # also: close, toggle
```

`Service.qml` imports only `QtQuick`, `Quickshell` and `Quickshell.Io` — no
`qs.Ui` — so it runs standalone under a plain Quickshell instance. That is how
`add()`, `remove()` and the fetch get exercised, since nothing here can
synthesize a mouse click:

```sh
mkdir -p /tmp/qstest/omapluginstats-test && cd /tmp/qstest
cp "$OLDPWD"/{Service.qml,Model.js} omapluginstats-test/   # from the repo root
# write a harness shell.qml that instantiates Service and calls its functions
XDG_STATE_HOME=$PWD/state qs -p omapluginstats-test/shell.qml
```

Point `XDG_STATE_HOME` at a scratch directory or the harness overwrites the real
watchlist. Give the harness's container `Item` an `id` and call its functions
through it: a function declared on a non-root object is not in scope for a
`Timer` inside it, and the failure is a bare `ReferenceError` at run time.

Two things about driving the panel from outside:

- **Position the cursor before opening the panel, not after.** A warp onto an
  already-open popup raises no hover at all — the row stays cold and the bin
  icon never appears — and warping can dismiss the popup outright. Warp twice a
  few hundred ms apart to generate real motion.
- On this Hyprland the cursor dispatcher is Lua:
  `hyprctl dispatch 'hl.dsp.cursor.move({x = 3320, y = 160})'`. The old
  `hyprctl dispatch movecursor 3320 160` form is a syntax error.

The add field is the one path with no automated coverage: revealing it needs a
real click on **Watch a plugin**. Check it by hand after touching `Panel.qml`.

`Ticker.qml` can be driven on its own, which is the fastest way to look at a
change to the board without waiting on a shell restart. It imports `qs.Commons`,
so the harness directory needs that module reachable under the name the import
uses:

```sh
mkdir -p /tmp/qstest/board && cd /tmp/qstest
cp "$OLDPWD"/{Ticker.qml,Model.js} board/
ln -sfn /usr/share/omarchy/shell/Commons board/Commons
# shell.qml: a FloatingWindow with one Ticker per motion, fed by
# Model.tickerModel(Model.rows(...)), and a Timer stepping `index`.
qs -p board/shell.qml
```

Then capture it with `grim -g` in a loop, reading the window rectangle out of
`hyprctl clients -j` (class `org.quickshell`). A burst of shots a few tens of
milliseconds apart is the only way to see a mid-flip cell: a settled board looks
exactly like static text, so a single screenshot proves nothing about the
animation.

To exercise the ticker under the real shell without clicking the panel toggle,
write `"ticker": true` into the state file — the service watches it and adopts
it on change, which is the same path a second instance would take. Back the file
up first; it is the user's watchlist.

Two things that will waste your time otherwise:

- `pkill -f board/shell.qml` kills the shell running it, because that string is
  in its own command line too. `pkill -x qs`.
- The idle lock will come up in the middle of a long capture loop and every
  frame after it is a screenshot of the lock screen.

## Architecture

Five files, one direction of data flow:

- **`Service.qml`** — the singleton (manifest kind `service`, one per shell
  session) that owns *all* state: the watchlist, the last fetched counts, the
  names read out of installed manifests, and the fetch timestamp. Bar widgets
  are instantiated per monitor, so a two-monitor desk would otherwise keep two
  watchlists and fetch twice.
- **`Model.js`** — a `.pragma library` of pure functions: response parsing, id
  validation, watchlist edits, row assembly and ranking, and the formatting the
  panel reads. Anything testable in isolation belongs here.
- **`BarWidget.qml`** — the bar entry point. `injectPanel()` hands the nested
  panel what it needs, and the widget re-exports `opened`/`open`/`close`/
  `toggle` because the bar routes popup coordination through the widget in its
  slot, not the panel.
- **`Panel.qml`** — rendering and input only; every edit is forwarded to the
  service.
- **`Ticker.qml`** — the optional bar board: drawing and timing, nothing else.
  What it says, how wide each column is, which cards a cell turns through and
  how long the board takes to settle all come from `Model.js`, which is what
  makes an animation this fiddly checkable without a running shell.

### Invariants that break things when violated

- `Model.parseStats` returns **null** for an unreadable response and a map for a
  readable one. The two must stay distinguishable: on null the service keeps the
  numbers it already had, and a captive portal or a 500 would otherwise blank
  every row to zero and persist that.
- The fetch is not cheap for the marketplace — 160 KB of everyone's listings —
  so it happens on the Refresh button and on opening a panel whose numbers are
  over `staleAfterMs` old. Nothing polls.
- Only the watched ids are persisted (`Model.pickStats`). Writing the whole
  response would put 160 KB of unrelated plugins in the state file on every
  fetch.
- **Two of these services can be alive at once** — a shell restart overlaps the
  outgoing shell, and editing an installed file rebuilds the plugin under a
  running one. The state file is therefore watched (`watchChanges: true` +
  `onFileChanged: reload()`), not read once. Without that, an instance that
  loaded before the file existed keeps an empty watchlist and destroys the real
  one on its next flush — and every successful fetch is a flush, so it happens
  without the user touching anything. `tests/` cannot see this; the repro is a
  second Quickshell instance writing the file underneath a running one.
- `loadState` adopts the file's watchlist unconditionally (it is the user's
  data, and the file is where it lives) but takes its cached counts only when
  `fetchedAt` is newer than ours — a fetch of our own holds every listing, the
  file only the watched ones.
- `add()` and `remove()` flush immediately rather than through `saveTimer`. A
  discrete user action must not sit in a debounce window where an external
  reload can swallow it; the timer is there for the fetch.
- **A write can only add ids.** `Model.watchlistToWrite` merges what this
  instance holds into what the file holds, and a removal takes away exactly the
  one id the user removed — never "store my view of the list". Two services can
  be alive at once (above), and watching the file keeps their copies in step;
  this is what makes a write harmless in the moment they are not. Removing
  several rows in a row still works, because each removal names its own id and
  merges the rest.
- **The ticker is the only thing that polls, and only while it is on.** The
  original argument against numbers on the bar was that a count moving a few
  times a day earns no permanent space there, and that putting one up would mean
  polling all session for a figure nobody is looking at. Ticker mode inverts the
  second half — a board already on screen is where a number moving is worth
  watching — so the poll exists, gated on `Service.ticker`, and
  `Model.tickerPollMs` floors it at fifteen minutes. That floor is the
  marketplace's, not the user's: one request is 160 KB of every listing. A
  setting can make it politer and not ruder.
- **A ticker column's cell count is fixed across every frame.**
  `Model.tickerModel` measures each column over the whole watchlist, not per
  frame. A column that resized as the board cycled would drag every column right
  of it sideways on each flip, and a bar widget that reflows itself every four
  seconds moves every other widget with it.
- **The QML binds through the ticker model to scalars, never to its objects.** A
  fetch rebuilds `Model.tickerModel`'s return value wholesale. A `Repeater` bound
  to the fresh array rebuilds its delegates, so every cell would reset to blank
  and re-flap the identical text on every refresh, forever. The cell repeater is
  bound to `widths[key]` as an int and each cell to `texts[key].charAt(i)` as a
  string, both of which compare equal and change nothing.
- **A cell decides its own path.** It is told where to be and asks
  `Model.flapPath` for the cards between here and there. Nothing staggers the
  columns deliberately — the uneven settle is the distance each cell has to
  travel, which is what a real board does and why it looks like one.
- **The ticker's switches live in the state file; its appearance lives in
  `shell.json`.** Three things are switches — on/off, flip the cards, time
  between plugins — and all three are in the panel and persisted beside the
  watchlist. The state file is ours to write and a panel control is a user
  action; `shell.json` is the user's, and a control that rewrote it would
  reformat their file to persist a click. Nothing is settable from both places:
  `tickerQuietMotion` chooses *which quiet motion* the flip switch falls back
  to, never whether it flips.
- **The service resolves the ticker's configuration, not the widget.** Half of
  it arrives from the state file and half from `shell.json` via
  `BarWidget.applyTickerSettings()`, and only the owner of both can put them
  together once for every monitor — so `tickerMotion`, `tickerCycleMs` and
  `tickerDwellFloorMs` are read-only bindings on the service and the widget
  reads them back.
- **The dwell slider starts at `Model.tickerDwellFloorMs`, not at the clamp.**
  With the cards flipping, `tickerCycleMs` raises any dwell below the settle
  time, so a slider spanning the full clamp would have a dead left third. The
  floor moves when the flipping is switched off, and the panel prints the
  effective cycle rather than the requested one.
- Views per day is a **lifetime average**, and the panel must not imply
  otherwise. It is the only rate the marketplace's data supports (see above);
  `rated` is false — a dash, not a zero — when there is no listing date, because
  no rate and a rate of nothing are different facts.

## Shell APIs this plugin relies on

Worth knowing, because guessing at them is how the first version broke:

- The **shell registers plugin bar widgets itself**, from `manifest.json`, under
  the plugin id. A plugin must not call `barWidgetRegistry.register`.
- **`manifest.barWidget.schema` is what a settings UI renders**, alongside
  `defaults`; `shell.qml` passes both through to `barWidgetRegistry` without
  validating either, and `Bar.qml` never applies `defaults` — a widget reads its
  settings through `setting(name, fallback)` and owns its own fallbacks.

  Nothing in `omacom/omarchy` *consumes* a schema: the renderer lives outside
  that repo, and `settingsForm: "spacerSettings"` names a form that does not
  exist there either. So the field vocabulary can only be read off the
  first-party manifests that declare one, which is where these came from:

  | Type | Extra keys | Declared by |
  |---|---|---|
  | `integer` | `min`, `max`, `step` | agents, dropbox, tailscale |
  | `enum` | `options` (plain strings) | agents |
  | `path` | — | agents |
  | `string` | — | agents |
  | `boolean` | — | indicators |
  | `multiselect` | `options` (`{value,label,description}`), `noSelectionText`, `placeholderText`, `emptyText` | indicators |

  `number` is **not** in that vocabulary — an earlier version of this manifest
  guessed it. Every field also carries `defaultValue`, and `barWidget.defaults`
  mirrors those, which is what dropbox and agents do.

  A range declared here is a promise a settings UI will keep and `Model.js` will
  not: the UI offers `min`..`max`, and the clamp that actually runs is
  `Model.clampInt`. Nothing reconciles them at run time, so
  `tests/model.test.js` asserts the manifest's ranges against the Model
  constants. Change one and the test names the other.

  Note also that `barWidget.category` is the *widget picker's* category and has
  nothing to do with the marketplace submission category — dropbox uses "Files",
  which is not one of the categories the issue form offers.
- The bar injects only `bar`, `moduleName` and `settings` into a widget. There is
  no `shell` and no `service`. A nested panel gets nothing at all unless the
  widget hands it over (see `BarWidget.injectPanel`).
- The service singleton is reachable from a bar-hosted component as
  `bar.shell.serviceFor(pluginId)`.
- A plugin is *enabled* — and therefore its `service` entry point loaded — by
  appearing in the bar layout in `shell.json`.
- Base components come from `qs.Ui` (`BarWidget`, `KeyboardPanel`, `PanelHero`,
  `PanelActionButton`, `BorderSurface`, `TextField`, `Button`, …) and tokens
  from `qs.Commons` (`Style`, `Color`, `Border`). Read
  `/usr/share/omarchy/shell/Ui/` before inventing a control.
- **A panel that wants keys must be a `KeyboardPanel`, not a `PopupCard`.**
  PopupCard is an xdg-popup, which only receives keys once a click or hover has
  routed focus through its parent surface. Set `focusTarget` to the
  `PanelKeyCatcher`, and `blocked` while a text field owns the keyboard.
- `FileView` is not an `Item`, so the per-plugin manifest readers live in
  `Item` delegates inside a `Repeater`. `Repeater` delegates support
  `required property`; that is how each reader learns which id it is for.
- `OpticalGlyph` is an Item with **no implicit size** that centres its text on
  itself, so a glyph given no width is a zero-wide box with half the mark
  hanging off its left. Every glyph in this repository is sized explicitly.
- Nerd Font marks are written as surrogate pairs (`"\udb80\udd28"`) with the
  codepoint and name in a comment, so the source stays readable without the font
  installed. Verify a codepoint before using it by rendering it — `magick -font
  /usr/share/fonts/TTF/JetBrainsMonoNerdFont-Regular.ttf` — rather than trusting
  a remembered name.

## Before publishing

References: <https://plugins.omarchy.org/publish.html> for the rules, and
`.github/ISSUE_TEMPLATE/submit-plugin.yml` in
<https://github.com/omacom/omarchy-plugin-marketplace> for what the submission
actually asks — that form is the real specification, and it asks for more than
the publish page does.

`omarchy plugin validate <folder>` mirrors the checks the shell itself enforces
— schemaVersion, required fields, safe relative entry points that exist, an
entry point for every declared kind, no symlinks, no reserved id. It exits 0
silently on success. It does **not** check what the marketplace listing needs,
so verify those by hand:

- `author`, `description` and `license` present in `manifest.json`, and the
  `license` value matching what `LICENSE` actually says.
- `README.md`, `LICENSE` and `preview.png` at the repository root.
- `homepage` pointing at the public repository.
- No `omarchy.clonedFrom` key: it is a development-only field the publish page
  says to strip.

The submission is a GitHub issue on the marketplace repository, and its
checklist contains four claims that have to be true of the repository before it
can honestly be ticked:

- **Installation *and removal* instructions.** README has both; the removal
  section names the one state file this plugin leaves behind.
- **License and external dependencies documented.** `curl`, `grep` and a POSIX
  `sh` — the pipeline in `listingsProc` is the only reason the last two are
  there, so if that ever becomes a QML-side parse, the README changes with it.
- **You own the preview assets.** `preview.png` is the ticker board above the
  panel, both cropped to their own pixels and composited onto a flat backdrop.
  Do not ship a desktop screenshot: the earliest ones had a browser behind the
  panel, which is both somebody else's content and a look at the author's
  screen. Nothing but this plugin's own two surfaces goes in — in particular,
  crop the board to the widget alone rather than taking a slice of the bar,
  which would carry the neighbouring widgets with it.

  Rebuilding it, in order:

  1. Stage a watchlist worth looking at. The five in the current image are
     `io.github.mtolhuys.theme-manager`, `io.github.woogy7.vitals`,
     `3lymn.plugin-drawer`, `alvarosaavedra.market-stats` and
     `com.github.marvreichmann.omavibrance` — keep them for continuity. Write
     them into the state file with `ticker: true`, `stats: {}` and
     `fetchedAt: 0`, restart the shell, then open the panel once: the empty
     stats and zero timestamp are what make it fetch real numbers and listing
     dates for ids that were never added through `add()`.
  2. Capture the board with the panel **closed** — an open panel puts the bar's
     active-widget underline through the strip. Find the widget's rectangle by
     looking for the cards: they are a faint wash of the foreground over the bar
     background, so a column inside one is measurably lighter than the bar. The
     icon starts `Style.bar.iconCanvas + Style.spacing.md` left of the first
     card, and `WidgetButton` pads `Style.spacing.rowPaddingX / 2` beyond that.
  3. **Use a settled frame.** A mid-flip board photographs beautifully, but the
     cells caught turning show values that are not the plugin's counts, and a
     marketplace listing image is read as a statement of fact. The cards and
     their seams already say "split-flap" at rest. To find one, burst-capture
     and diff consecutive frames: a run of zero-difference frames is a settled
     board.
  4. Crop the panel out of a `grim` capture by its accent border — scan for rows
     and columns holding a long run of accent-coloured pixels, and take the
     outermost. The bar widget's underline is a shorter run and has to be
     rejected on length.
  5. Composite both on the backdrop, board above panel, which is where they are
     on screen:
     `magick -size 1200x988 xc:'#0b0b0b' board.png -geometry +391+60 -composite panel.png -geometry +302+135 -composite preview.png`

  Restore the state file afterwards, and reset the ticker keys rather than
  leaving the staged ones behind — the watchlist is the user's, and so is
  whether their bar has a board on it.
- **Does not overwrite user configuration without consent.** It writes one file,
  `$XDG_STATE_HOME/omarchy/omapluginstats.json`, and nothing else. Keep it that
  way; `shell.json` in particular is the user's, not ours.

The form also wants a category and up to three tags from fixed lists. For this
plugin: category **Developer Tools**; tags **Bar** and **Quickshell**.

## Releasing

Each version is a GitHub release, and its notes are the matching `CHANGELOG.md`
section — the file is the source, the release is a copy of it. To cut one:

1. Add the changes under `## [Unreleased]` in `CHANGELOG.md` as you go, in
   Keep a Changelog form (`### Added` / `### Changed` / `### Fixed`), written
   for someone using the plugin rather than reading the diff.
2. Rename that heading to `## [x.y.z] - YYYY-MM-DD`, add a fresh empty
   `## [Unreleased]`, and update the link definitions at the bottom.
3. Bump `version` in `manifest.json` to the same `x.y.z`. The workflow refuses
   the tag if the two disagree.
4. Commit, then `git tag vx.y.z && git push origin main --follow-tags`.

`.github/workflows/release.yml` does the rest on the tag: runs the unit tests,
checks the tag against the manifest, extracts the section for that version, and
fails rather than publishing an empty release if there is no section. Do not
write release notes in the GitHub UI — the next tag would contradict them.
