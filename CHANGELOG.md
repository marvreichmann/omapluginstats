# Changelog

All notable changes to this project are documented here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) form. This project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/marvreichmann/omapluginstats/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/marvreichmann/omapluginstats/releases/tag/v1.0.0
