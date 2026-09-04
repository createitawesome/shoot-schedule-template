---
name: shoot-schedule-template
description: Use when the user wants to build a shoot calendar for sports teams they photograph — add a team, refresh an existing team's schedule, or regenerate the calendar. Triggers on "set up my shoot calendar", "add a team to my shoot schedule", "update [team] schedule", "regenerate my shoot calendar". Runs an onboarding flow that asks which teams to track, finds each team's schedule source via web search, confirms it with a test pull before committing, and produces a calendar importable into iCloud Calendar or deployable via Vercel.
---

# Shoot Schedule (template)

Builds a subscription-style calendar of games for the sports teams a
photographer shoots, from scratch, for any team/league — nothing about a
specific league or team is hardcoded in this skill. Two files drive
everything:

- `preferences.json` (repo root) — the user's config: which teams, home-only
  vs. home+away, whether to include a pre-game arrival reminder event, event
  timing, and the confirmed schedule source per team.
- `teams/{slug}.json` — fetched schedule data per team (venue + games). Pure
  data, refreshed by re-running the fetch; never hand-edited preferences.

`scripts/generate-ics.mjs` reads both and writes `public/shoots.ics`.

## Step 1: Check existing state

Look for `preferences.json` in the repo root.

- **Missing** → first run. Go to Step 2, then Step 3 for the first team.
- **Exists** → `AskUserQuestion`: "Add a new team" or "Refresh/add new games
  to an existing team". For refresh, let them pick which team from
  `preferences.json.teams[].team`, skip to Step 4 using that team's existing
  `slug` and stored config (only re-ask what's changing, if anything).

## Step 2: First-run only — delivery method

`AskUserQuestion`: how should the finished calendar reach them?

- **Import into iCloud Calendar** — generates `shoots.ics` locally and opens
  it with Calendar.app; the user picks (or creates) an iCloud calendar to
  import into. No hosting, no account needed beyond iCloud. macOS-only.
- **Deploy via Vercel** — generates `shoots.ics` and deploys it with the
  Vercel CLI, producing a subscribe URL any calendar app can poll. Works
  cross-platform but requires a Vercel account (`vercel login` if not
  already authenticated).

Store the choice as `deliveryMethod` (`"icloud-import"` or `"vercel"`) at the
top level of `preferences.json`.

## Step 3: Add a team — gather preferences

`AskUserQuestion` (or sequential prompts) for a new team:

1. **Team name** (e.g. "Vancouver Canadians") and **league** (e.g. "MiLB").
   If ambiguous (multiple teams with that name), ask which one — city,
   division, whatever disambiguates.
2. **Home games only, or home + away?** Away games matter if the user
   travels to shoot some road games; default suggestion is home-only but
   don't assume — ask.
3. **Include a pre-game arrival reminder event?** (yes/no) — a second
   calendar event before each game reminding them to arrive early.
4. If yes to arrival events, **how many minutes before the game** (default
   suggestion: 60).
5. **Game duration** in minutes, for the event's end time (reasonable
   per-sport defaults: hockey/basketball ~150, baseball ~180, soccer ~120,
   football ~210, volleyball ~120 — suggest one based on the league, let the
   user override).

Derive a `slug` (lowercase, hyphenated, e.g. `vancouver-canadians`). The
event title itself doesn't need a per-team tag from the user — the
generator automatically prefixes every event with `[{league}]` (from the
`league` you captured in Step 3.1), so leagues are already distinguishable
in a merged calendar without asking for one.

## Step 4: Resolve the schedule source

Check `preferences.json` for this team's `slug` with a `source.url` already
set (only relevant on a refresh run, or if a prior attempt succeeded).

- **Cached source exists** → try fetching from it first. If it works, skip
  straight to the test pull (Step 5). If it fails (404, unexpected shape,
  empty), fall through to a fresh search below and note the old source
  failed.
- **No cached source** → `WebSearch` for the team's official schedule —
  e.g. `"{team name} {league} schedule {season} API"` or
  `"{team name} schedule"`. Do **not** rely on any built-in list of known
  APIs per league — search fresh every time; leagues change platforms,
  and hardcoding invites staleness. If the official site doesn't expose an
  API, fall back to scraping the schedule page (use the `firecrawl` skill if
  available, or `WebFetch`).
- If nothing usable turns up, ask the user directly for the schedule URL.

## Step 5: Test pull — confirm before committing

Fetch a **small sample** (3-5 games) from the resolved source. Show the user
date, opponent, and venue for each, plainly:

```
Found via [source]. Sample:
1. 2026-05-27 — Eugene Emeralds vs Vancouver Canadians (Nat Bailey Stadium)
2. 2026-05-28 — Eugene Emeralds vs Vancouver Canadians (Nat Bailey Stadium)
3. 2026-05-29 — Eugene Emeralds vs Vancouver Canadians (Nat Bailey Stadium)

Does this look right?
```

`AskUserQuestion`: yes / no.

- **No** → ask what's wrong (wrong team matched? wrong venue? garbled
  dates?). Try another source (back to Step 4) or ask the user for a direct
  URL. Do not write anything until confirmed.
- **Yes** → proceed to Step 6.

## Step 6: Full fetch and write

Fetch the complete schedule from the confirmed source. Filter to home games
only (venue matches `homeVenue.name`) unless the user chose home+away in
Step 3, in which case keep everything and tag each game's venue explicitly
(so away games carry their own venue, not the team's home venue).

Write `teams/{slug}.json`:

```json
{
  "team": "Vancouver Canadians",
  "slug": "vancouver-canadians",
  "league": "MiLB",
  "timezone": "America/Vancouver",
  "homeVenue": {
    "name": "Nat Bailey Stadium",
    "address": "4601 Ontario St, Vancouver, BC V5V 3H4, Canada",
    "lat": 49.2413,
    "lon": -123.1071
  },
  "games": [
    { "date": "2026-05-27T19:05:00-07:00", "opponent": "Eugene Emeralds", "notes": "" }
  ]
}
```

- `date` — ISO 8601 with timezone offset. Get the timezone right for the
  source (don't assume the user's local zone matches the source's raw
  times — check).
- `venue` (optional, per-game) — only needed for away games under a
  home+away setup; omit for home games (they inherit `homeVenue`).
  Look up venue lat/lon once per unique venue (needed for the tap-to-Maps
  location chip in iPhone Calendar — without it the chip may not be
  tappable).
- `notes` — **actively check** the source for theme nights, promos,
  retirement/bobblehead nights, jersey reveals, etc. on each game, not just
  ones that happen to stand out — many schedule sources mark these with an
  icon, badge, or separate column that's easy to skip if you're only
  reading date/opponent columns. Short phrase, e.g. `"Theme night: Fan
  Appreciation"`. Leave empty/omit only when the source genuinely has
  nothing for that game. This flows straight into the event description as
  a `Notes:` line — it's the main way theme-night info reaches the user's
  calendar, so don't skip checking for it.
- **Playoffs**: if the source has them, add `gameType: "playoff"` and an
  optional `playoff` object: `{ "round": "...", "gameNumber": 1,
  "gamesInSeries": 7, "ifNecessary": false, "seriesContext": "Best-of-7" }`.
  All sub-fields optional. `opponent: "TBD"` is allowed for unset playoff
  matchups. `round` (e.g. `"NWL Championship Series"`, `"Round 1"`,
  `"WHL Final"`) also becomes the event title's playoff tag — see below.

Update `preferences.json` — add or update this team's entry (from Step 3)
plus:

```json
"source": { "url": "<resolved source url>", "confirmedAt": "<ISO timestamp now>" }
```

**Colon safety**: strip or replace `:` in any user-facing title/event text
you generate (e.g. a special-event name) with ` -` — some calendar/file
tooling mishandles literal colons in filenames or fields derived from these
strings.

**Event title format** (handled automatically by `generate-ics.mjs`, nothing
to write yourself here): `[{league}] {opponent} vs {team}` for a regular
game, `[{league}] [{playoff round, or "Playoff" if unset}] {opponent} vs
{team}` for a playoff game — e.g. `[MiLB] [NWL Championship Series] Eugene
Emeralds vs Vancouver Canadians`.

## Step 7: Regenerate the calendar

```bash
node scripts/generate-ics.mjs
```

Report a summary: team(s) touched, game count, date range, any playoff
games included. Show it before delivering — this is the point to catch
anything that looks wrong.

## Step 8: Deliver

Per `preferences.json.deliveryMethod`:

- **`icloud-import`**:
  ```bash
  open public/shoots.ics
  ```
  Tell the user Calendar.app will prompt for a target calendar — they should
  pick (or create once) an **iCloud** calendar, not "On My Mac", so it syncs
  across devices. On future refresh runs, remind them to pick the *same*
  calendar again so events update in place (stable UIDs) rather than
  duplicating.
- **`vercel`**:
  ```bash
  vercel --prod
  ```
  Run from the repo root. If not logged in, prompt the user to run
  `vercel login` first. Report back the deployment URL — the subscribe link
  is `<deployment-url>/shoots.ics` (confirm `vercel.json` routes it there;
  see below).

## Files in this skill

- `SKILL.md` — these instructions.
- `README.md` — human-facing quick start.
- `setup.sh` — links this skill into `~/.claude/skills/`.
- `scripts/generate-ics.mjs` — reads `teams/*.json` + `preferences.json`,
  writes `public/shoots.ics`. Don't hand-edit the output; regenerate.
- `teams/` — starts empty; populated by this skill.
- `package.json` — exposes `npm run generate` as a shortcut for the script
  above.

## Things to avoid

- **Don't write `teams/{slug}.json` before the test-pull is confirmed.**
- **Don't hardcode a league's data source in this skill file.** Search
  fresh each time a team is first added; only reuse a source once it's been
  confirmed for *this user's* team via `preferences.json`.
- **Don't change the UID format** (`{slug}-{date}-{game|pregame}[-playoff][-N]@shoot-schedule`)
  — calendar apps rely on stable UIDs to update events in place instead of
  duplicating them.
- **Don't add `GEO`/`X-APPLE-STRUCTURED-LOCATION` without real coordinates**
  — fake lat/lon breaks the tap-to-Maps behavior.
