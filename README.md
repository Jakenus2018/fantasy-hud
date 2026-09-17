# Gridiron HUD

A single-file fantasy football HUD: build any number of teams, watch their PPR points update live from real NFL box scores, and keep a stream playing in the broadcast panel while you do.

Everything lives in `index.html` — no build step, no dependencies, no API key.

## Run it

Open `index.html` in a browser, or host the folder on any static host (GitHub Pages, Netlify, S3). The live feed needs to run outside sandboxed viewers that block outbound requests.

## What it does

- **Teams** — tabs across the top; each team has its own roster, name and scoring rules. Totals on every tab update live.
- **Live scoring** — polls Sleeper's public API every 20 s while games are in progress and diffs each player's stat line. Every point change animates the row (touchdowns get the stamp and spark burst); the wire ticker carries TDs and field goals league-wide plus stat deltas for your players.
- **Search** — type-ahead over every rostered NFL player (name, team code, nickname or position) showing team, opponent, kickoff time or live clock, projection, and injury status.
- **Scoring** — full PPR by default; every rule is editable per team, with Full / Half / Standard presets. Projections are recomputed under your rules.
- **Broadcast panel** — paste a YouTube, Twitch, Kick or Vimeo link; the out-of-town slate underneath shows every game's score, clock and possession.
- **Simulation** — a built-in play-by-play engine used as a fallback (or on demand from App settings) when nothing is on.

## Data

Sleeper, key-less and CORS-open:

| Endpoint | Purpose |
|---|---|
| `/v1/state/nfl` | current season and week |
| `/scores/nfl/{type}/{season}/{week}` | kickoff times, quarter and clock, scores, possession |
| `/projections/nfl/{season}/{week}` | player index and projections |
| `/stats/nfl/{season}/{week}` | live box scores (polled) |

Teams, rosters and rules persist in the browser's `localStorage`.
