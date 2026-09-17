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

Teams, rosters and rules persist in the browser's `localStorage`, and — once accounts are enabled — in the signed-in user's cloud record.

## Accounts (optional, ~5 minutes)

Sign-in and cross-device sync use [Firebase](https://console.firebase.google.com) (free Spark plan; no server to run). Until it's configured the page runs local-only and hides the account button.

1. **Create a project** at console.firebase.google.com (Google Analytics can be off).
2. **Add a Web app** (Project settings → Your apps → `</>`), and copy the `firebaseConfig` values into `FIREBASE_CONFIG` at the top of the script in `index.html`. Only `apiKey`, `authDomain`, `projectId` and `appId` are needed. These are public identifiers, not secrets — access is controlled by the rules below.
3. **Authentication → Sign-in method**: enable **Google** and/or **Email/Password**.
4. **Authentication → Settings → Authorized domains**: add the domain the page is served from (for GitHub Pages, `<user>.github.io`). `localhost` is already there.
5. **Firestore Database → Create database** (production mode, any region), then **Rules** → paste and publish:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{uid} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }
     }
   }
   ```

Each user can read and write only their own `users/{uid}` document, which holds their teams for both data sources plus a small name cache for rostered players.

**How sync behaves**

- Every change (new team, rename, roster edit, scoring tweak) saves locally at once and to the cloud a moment later; the dot on the account button shows saving / saved / error.
- Signing in on a device with local teams: the cloud copy is loaded, and any local teams the cloud doesn't have are added to it (nothing is thrown away). If the cloud is empty, the local teams are uploaded.
- Edits made on another device appear live.
- Signing out leaves a copy of the teams on the device.
