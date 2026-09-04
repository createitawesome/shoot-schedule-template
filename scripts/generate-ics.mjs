#!/usr/bin/env node
// Generate shoots.ics from teams/*.json + preferences.json
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const TEAMS_DIR = join(REPO_ROOT, "teams");
const PUBLIC_DIR = join(REPO_ROOT, "public");
const OUT_FILE = join(PUBLIC_DIR, "shoots.ics");
const PREFS_FILE = join(REPO_ROOT, "preferences.json");

// RFC 5545 text escaping: backslash, semicolon, comma, newline.
function escapeText(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// Fold a single property line to <=75 octets, with continuation lines
// beginning with a single space. Iterates by code point so multi-byte
// UTF-8 characters never get split mid-byte.
function foldLine(line) {
  if (Buffer.byteLength(line, "utf8") <= 75) return line;
  const out = [];
  let buf = "";
  for (const ch of line) {
    const next = buf + ch;
    if (Buffer.byteLength(next, "utf8") > 75) {
      out.push(buf);
      buf = " " + ch;
    } else {
      buf = next;
    }
  }
  if (buf) out.push(buf);
  return out.join("\r\n");
}

function toIcsDateUtc(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${iso}`);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

function addMinutes(iso, minutes) {
  const d = new Date(iso);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString();
}

function nowStamp() {
  return toIcsDateUtc(new Date().toISOString());
}

function formatLocalTime(iso, tz) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: tz,
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

// YYYY-MM-DD in the team's local timezone. Used for UID stability so a game
// stored as UTC still hashes to the same calendar date the user sees.
function formatLocalDate(iso, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function appleStructuredLocation(venue) {
  const { name, address, lat, lon } = venue;
  const xAddress = address
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\\n");
  return `X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-ADDRESS=${xAddress};X-APPLE-RADIUS=72;X-TITLE=${escapeText(name)}:geo:${lat},${lon}`;
}

function buildVevent({ uid, startIso, endIso, summary, description, venue }) {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${nowStamp()}`,
    `DTSTART:${toIcsDateUtc(startIso)}`,
    `DTEND:${toIcsDateUtc(endIso)}`,
    `SUMMARY:${escapeText(summary)}`,
    `LOCATION:${escapeText(`${venue.name}, ${venue.address}`)}`,
    `GEO:${venue.lat};${venue.lon}`,
    appleStructuredLocation(venue),
    `DESCRIPTION:${escapeText(description)}`,
    "END:VEVENT",
  ];
  return lines;
}

function buildPlayoffPreamble(playoff) {
  if (!playoff) return "";
  const lines = [];
  let header;
  if (playoff.round && playoff.gameNumber && playoff.gamesInSeries) {
    header = `Playoff: ${playoff.round}, Game ${playoff.gameNumber} of ${playoff.gamesInSeries}`;
  } else if (playoff.round && playoff.gameNumber) {
    header = `Playoff: ${playoff.round}, Game ${playoff.gameNumber}`;
  } else if (playoff.round) {
    header = `Playoff: ${playoff.round}`;
  } else if (playoff.gameNumber) {
    header = `Playoff: Game ${playoff.gameNumber}`;
  } else {
    header = "Playoff game";
  }
  if (playoff.seriesContext) header += ` (${playoff.seriesContext})`;
  lines.push(header);
  if (playoff.ifNecessary) {
    lines.push("If necessary — may not be played if series ends earlier.");
  }
  return lines.join("\n") + "\n\n";
}

// team    = parsed teams/{slug}.json (venue + games[] — fetched schedule data only)
// prefs   = this team's entry from preferences.json (titlePrefix,
//           arrivalLeadMinutes, gameDurationMinutes, includeArrivalEvent,
//           source.url)
function buildEventsForTeam(team, prefs) {
  const events = [];
  const tz = team.timezone || "America/Vancouver";
  const defaultVenue = team.homeVenue;

  // Sort by chronological order, then group by local date so doubleheaders
  // get deterministic UID suffixes (-2, -3...) on top of the stable date.
  const sorted = [...(team.games || [])].sort(
    (a, b) => new Date(a.date) - new Date(b.date),
  );
  const byLocalDate = new Map();
  for (const g of sorted) {
    const d = formatLocalDate(g.date, tz);
    if (!byLocalDate.has(d)) byLocalDate.set(d, []);
    byLocalDate.get(d).push(g);
  }

  for (const [localDate, gamesOnDate] of byLocalDate) {
    gamesOnDate.forEach((game, idx) => {
      const suffix = idx === 0 ? "" : `-${idx + 1}`;
      const venue = game.venue || defaultVenue;
      const gameStart = game.date;
      const gameEnd = addMinutes(gameStart, prefs.gameDurationMinutes);
      const pregameStart = addMinutes(gameStart, -prefs.arrivalLeadMinutes);
      const opponent = game.opponent;
      const notes = game.notes ? `\nNotes: ${game.notes}` : "";
      const sourceUrl = prefs.source && prefs.source.url;
      const sourceLine = sourceUrl ? `\nSource: ${sourceUrl}` : "";
      const localStart = formatLocalTime(gameStart, tz);

      const isPlayoff = game.gameType === "playoff";
      const playoffInfix = isPlayoff ? "-playoff" : "";
      const titlePrefix = isPlayoff ? "[PLAYOFFS] " : "";
      const playoffPreamble = isPlayoff ? buildPlayoffPreamble(game.playoff) : "";
      const matchup = game.title
        ? `${titlePrefix}${game.title}`
        : `${titlePrefix}${opponent} vs ${team.team}`;

      if (prefs.includeArrivalEvent) {
        events.push(
          ...buildVevent({
            uid: `${team.slug}-${localDate}${playoffInfix}-pregame${suffix}@shoot-schedule`,
            startIso: pregameStart,
            endIso: gameStart,
            summary: `Arrive for Pre-Game: ${matchup}`,
            description: `${playoffPreamble}Pre-game arrival window. Game starts ${localStart}.\nOpponent: ${opponent}${notes}${sourceLine}`,
            venue,
          }),
        );
      }
      events.push(
        ...buildVevent({
          uid: `${team.slug}-${localDate}${playoffInfix}-game${suffix}@shoot-schedule`,
          startIso: gameStart,
          endIso: gameEnd,
          summary: matchup,
          description: `${playoffPreamble}Opponent: ${opponent}${notes}${sourceLine}`,
          venue,
        }),
      );
    });
  }
  return events;
}

function buildCalendar(allEvents) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//shoot-schedule-template//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Shoot Schedule",
    "X-WR-CALDESC:Shoot calendar generated by shoot-schedule-template",
    ...allEvents,
    "END:VCALENDAR",
  ];
}

function loadPreferences() {
  if (!existsSync(PREFS_FILE)) {
    throw new Error(
      `preferences.json not found at ${PREFS_FILE}. Run the onboarding skill first.`,
    );
  }
  return JSON.parse(readFileSync(PREFS_FILE, "utf8"));
}

function main() {
  const prefsDoc = loadPreferences();
  const prefsBySlug = new Map((prefsDoc.teams || []).map((t) => [t.slug, t]));

  const teamFiles = existsSync(TEAMS_DIR)
    ? readdirSync(TEAMS_DIR).filter((f) => f.endsWith(".json")).sort()
    : [];

  const allEvents = [];
  let totalGames = 0;
  for (const file of teamFiles) {
    const team = JSON.parse(readFileSync(join(TEAMS_DIR, file), "utf8"));
    const prefs = prefsBySlug.get(team.slug);
    if (!prefs) {
      console.warn(
        `  ⚠ ${team.team || file}: no preferences.json entry for slug "${team.slug}" — skipping`,
      );
      continue;
    }
    const events = buildEventsForTeam(team, prefs);
    allEvents.push(...events);
    const count = (team.games || []).length;
    totalGames += count;
    console.log(`  ${team.team}: ${count} game(s)`);
  }

  const folded = buildCalendar(allEvents).map(foldLine).join("\r\n") + "\r\n";
  mkdirSync(PUBLIC_DIR, { recursive: true });
  writeFileSync(OUT_FILE, folded, "utf8");
  console.log(
    `\n✓ ${totalGames} game(s) across ${teamFiles.length} team(s) → public/shoots.ics`,
  );
}

main();
