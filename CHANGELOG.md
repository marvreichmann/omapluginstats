# Changelog

All notable changes to this project are documented here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) form. This project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.2] - 2026-09-10

### Security

- The state file and the watched plugins' manifests are read only if they are
  regular files you own, not symlinks or hard links, and within a size limit
  (96 KB and 64 KB). Anything else is refused before it reaches the shell.
- The state file is written by renaming a fresh file into place. A symlink
  planted at its path is replaced instead of being followed, which previously
  would have overwritten the file it pointed at.
- A state file that fails those checks is left untouched, and the panel says
  that changes are not being saved until it is fixed.

## [1.1.1] - 2026-09-10

### Security

- Both downloads now have a hard size limit: 1 MB for the stats, 16 MB for the
  catalog after decompression, and 1 MB for the lines kept from it. A response
  that runs past its limit is discarded whole, before any of it reaches the
  Omarchy shell, and the panel says so instead of showing part of it. Previously only
  the time a fetch could take was limited, not how much it could send.

## [1.1.0] - 2026-09-08

### Added

- **Bar ticker**, off by default and switched on from the panel: the watchlist
  cycles across the bar itself as a split-flap departure board, one plugin at a
  time, with its name and numbers flipping into place a card at a time.
- Hovering the ticker holds the current plugin still so it can be read;
  scrolling it steps through the watchlist by hand. Clicking still opens the
  panel.
- Numbers that have gone up since the last fetch are tinted for a minute, so a
  change catches the eye instead of having to be spotted.
- **Flip the cards** and **Time between plugins** in the panel, under the
  ticker switch: whether each character turns over card by card, and how long a
  plugin stays up before the next one. With the cards flipping, the slider will
  not go below the time the board needs to settle, because a shorter setting
  would change nothing.
- With the flipping switched off the board still cycles — the line slides up
  and the next one rises in behind it. `tickerQuietMotion` in `shell.json`
  chooses `none` instead for a board that simply changes. The columns, name
  width, capitals, cards and flap speed are configurable there too.
- While the ticker is on — and only then — the counts are refreshed on a timer.
  Fifteen minutes is both the default and the shortest allowed: one request
  returns every listing on the marketplace.
- A plugin shown by id rather than by name now has a long id shortened from the
  left, so `com.github.you.yourplugin` reads as `YOURPLUGIN`.

### Changed

- Whether the ticker is on is kept in the plugin's own state file alongside the
  watchlist, and adopted by every bar surface at once, so two monitors show the
  same plugin at the same moment rather than two boards racing each other.

## [1.0.0] - 2026-09-06

### Added

- A bar panel showing views, copies and hearts for a watchlist of marketplace
  plugins, ranked by views.
- Average views per day since listing, alongside the totals. Listing dates come
  from the public catalog and are fetched only for watched plugins that have no
  date yet.
- Add a plugin by id and remove it from its row; the watchlist is kept in
  `$XDG_STATE_HOME/omarchy/omapluginstats.json`, along with the last numbers
  fetched so the panel opens with something to show.
- Watched plugins that are installed locally are labelled with their name from
  their own manifest, with the id underneath.
- Ids the marketplace does not list are shown as such, rather than as a plugin
  with no views.
- Refresh on demand, and automatically when the panel is opened on numbers more
  than five minutes old.

[Unreleased]: https://github.com/marvreichmann/omapluginstats/compare/v1.1.2...HEAD
[1.1.2]: https://github.com/marvreichmann/omapluginstats/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/marvreichmann/omapluginstats/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/marvreichmann/omapluginstats/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/marvreichmann/omapluginstats/releases/tag/v1.0.0
