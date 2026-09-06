# Omapluginstats

Views, copies and hearts for a watchlist of plugins on the
[Omarchy plugin marketplace](https://plugins.omarchy.org), in a bar panel.

![The panel, listing five watched plugins with their views, views per day, copies and hearts](preview.png)

Add the plugin ids you care about — yours, or anyone's — and the panel shows
what the marketplace has recorded for each: how many people opened the listing,
how many views a day that averages since it was listed, how many copied its
install command, and how many hearted it. Rows are ranked by views, most-read
first.

## Install

```sh
omarchy plugin add https://github.com/marvreichmann/omapluginstats.git --enable
```

Then add `com.github.marvreichmann.omapluginstats` to your bar in
`~/.config/omarchy/shell.json`, or pick "Omapluginstats" from the bar widget
picker. The icon opens the panel; there is no counter on the bar itself.

## Using it

- **Watch a plugin** takes a plugin id — the `id` from its `manifest.json`,
  which is also what its marketplace listing shows and what
  `omarchy plugin add` installs it under. Enter adds it.
- Hover a row and use the bin icon to stop watching it.
- **Refresh** fetches the current numbers. Opening the panel does the same if
  the ones on screen are more than five minutes old.
- The speedometer column is **average views per day since listing** — total
  views divided by the days the listing has been up, counted inclusively. It is
  a lifetime average, not a recent trend: the marketplace publishes running
  totals and no history, so "views this week" is not something anyone can
  compute from it without recording the totals daily first.
- First-party `omarchy.*` plugins show a dash there. They ship with the shell
  rather than being listed, so there is no listing date to average over.
- An id the marketplace does not know shows dashes and *Not on the
  marketplace* — usually a typo, or a listing that has been retired.
- A watched plugin that is also installed is shown by name, with its id
  underneath. Everything else is shown by id, because names live in manifests
  and the stats API only knows ids.

## What it talks to

One endpoint for the counts, read-only:
`GET https://api.omarchyplugins.com/v1/stats`, which returns them for every
listing on the marketplace in a single response. The watchlist is applied on
this machine, so the marketplace is never told which plugins you are interested
in.

Listing dates come from the public catalog at
`https://plugins.omarchy.org/catalog.json`, and only when a watched plugin has
no date yet — a listing date never changes, so it is cached for good. Most
sessions never fetch it at all.

This plugin never posts to `/v1/events` — the endpoint the website uses to
*record* a view, a copy or a heart. Reading your numbers here does not change
them, for your plugins or anyone else's.

Nothing else leaves the machine. The watchlist and the last numbers fetched are
kept in `$XDG_STATE_HOME/omarchy/omapluginstats.json` so the panel opens with
something to show before the next fetch returns.

## Removing it

```sh
omarchy plugin remove com.github.marvreichmann.omapluginstats
```

Then take the widget out of your bar in `~/.config/omarchy/shell.json` if it is
still listed there. The plugin writes exactly one file of its own, which is left
behind and can go too:

```sh
rm ~/.local/state/omarchy/omapluginstats.json
```

Nothing else on the system is touched — no other configuration is written, no
services are installed, and nothing is left running.

## Requirements

- Omarchy 4.x with the Quickshell bar
- `curl`, `grep` and a POSIX `sh` on `PATH` — all part of a base Arch install.
  `curl` fetches the two documents above; `grep` narrows the catalog before it
  is parsed, and `sh` is used only to connect those two with a pipe.

No other external dependencies, and no accounts, keys or tokens: both sources
are public and read anonymously.

## License

MIT — see [LICENSE](LICENSE).
