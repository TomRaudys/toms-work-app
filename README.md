# Work Dashboard

A single-page personal work dashboard that pulls everything you need to start the day into one screen — ClickUp tasks, calendar, pending invites, priority emails, Slack saved items, meeting notes, team OOO, upcoming releases, world clocks, and a ClickUp daily brief.

Built with a Node/Express backend that proxies the various service APIs and a dependency-free HTML/CSS/JS frontend. Styled to match the Claude / Claude Code aesthetic (warm cream, terracotta accents, Inter).

## Features

The dashboard is a fixed three-column grid of cards. Each card with multiple views uses pill sub-tabs (which collapse to dropdowns on mobile).

| Card | Tabs | What it shows |
|---|---|---|
| **Events** | Events · Priority Emails · Invites · Meeting Notes | Today's calendar with a live "now" line, attendee responses, and color-coded category tags. Priority emails (Gmail follow-ups). Pending invites — recurring series collapse to one row with **Yes all / No all**. Meeting notes from Fireflies + Gemini. |
| **Summary** | — | Meeting count and total meeting time, plus an 8-week sparkline of weekly meeting load with week-over-week trend. |
| **World Clocks** | — | Six time zones with day/night indicator and a work-hours band. DST-aware (IANA zones). |
| **Work** | Daily Summary · ClickUp Tasks · Slack Saved | Daily brief pulled from a ClickUp doc, auto-switched to today's page by date. ClickUp tasks across My Work, sorted by due date, with a count badge. Slack saved items with infinite scroll. |
| **Releases** | Releases · All Events · Team OOO | Upcoming releases with countdowns. Full event calendar. Team out-of-office timeline. |

Auto-refreshes every 60 seconds. Fully responsive — cards stack and tabs become dropdowns under 768px.

## Quick start

```bash
npm install
cp .env.example .env   # then fill in credentials — see below
npm start              # http://localhost:3000
```

The server reads its `.env` from the project directory regardless of the working directory it's launched from, so it runs cleanly under launchd/cron.

## Configuration

All credentials and user-specific IDs live in `.env` (gitignored). Full step-by-step instructions for obtaining every token are in **[CLAUDE.md](CLAUDE.md)**.

| Variable | Service | Purpose |
|---|---|---|
| `CLICKUP_API_TOKEN` | ClickUp | Personal API token (`pk_...`) |
| `CLICKUP_TEAM_ID` | ClickUp | Workspace/team ID |
| `CLICKUP_USER_ID` | ClickUp | Your numeric user ID |
| `CLICKUP_HIGHLEVEL_LIST_ID` | ClickUp | "Big picture" list ID |
| `CLICKUP_RELEASES_LIST_ID` | ClickUp | Releases list ID |
| `CLICKUP_CALENDAR_FOLDER_ID` | ClickUp | Release-calendar folder ID |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google | OAuth client credentials |
| `GOOGLE_REFRESH_TOKEN` | Google | Obtained via `/auth/google` flow |
| `GOOGLE_CALENDAR_ID` | Google | Primary calendar ID |
| `OOO_CALENDAR_ID` | Google | Team out-of-office calendar ID |
| `SLACK_XOXC_TOKEN` / `SLACK_D_COOKIE` | Slack | Browser session token + cookie |
| `SLACK_USER_TOKEN` | Slack | User token with `reminders:read` |
| `FIREFLIES_API_KEY` | Fireflies | Meeting transcripts |
| `NEWS_RSS_URL` | — | RSS feed for the news widget |
| `MY_EMAIL` / `MY_NAME` | — | Identity, used to match you in meeting participants |
| `PORT` | — | Server port (default `3000`) |

> Slack `xoxc`/`d` tokens expire on browser sign-out and need periodic refresh.

## Architecture

- **`server.js`** — Express server. Each `/api/*` route proxies one external service and normalizes the response for the frontend. OAuth refresh tokens are exchanged on each request; nothing is persisted server-side.
- **`public/index.html`** — the entire frontend: layout, styles, and all rendering JS in one file. No build step, no framework.
- **`.env`** — all secrets and IDs.

### Key API endpoints

| Endpoint | Source | Description |
|---|---|---|
| `GET /api/clickup/tasks` | ClickUp | Tasks assigned to you across My Work |
| `GET /api/clickup/daily-summary` | ClickUp | Today's daily-brief doc page (matched by date) |
| `GET /api/clickup/highlevel` | ClickUp | High-level / big-picture tasks |
| `GET /api/releases` | ClickUp | Upcoming releases |
| `GET /api/calendar/today` | Google Calendar | Today's events, pending invites, meeting stats |
| `POST /api/calendar/respond` | Google Calendar | Accept/tentative/decline an invite (or full series) |
| `GET /api/calendar/team-ooo` | Google Calendar | Team out-of-office |
| `GET /api/gmail/unread` | Gmail | Unread thread count |
| `GET /api/gmail/followups` | Gmail | Priority / follow-up emails |
| `GET /api/slack/todos` | Slack | Saved items (paginated) |
| `GET /api/slack/unread` | Slack | Unread channel/DM counts |
| `GET /api/weekly-summary` | Fireflies + Drive | This week's meeting summaries |
| `GET /api/news` | RSS | Latest news items |
| `GET /api/health` | — | Which services are configured |
| `GET /auth/google` | — | Start Google OAuth (prints refresh token) |

## Running as a background service (macOS)

Run it under launchd so it starts at login and restarts if it dies. A working `LaunchAgent` plist:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.yourname.work-dashboard</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/node</string>
        <string>/path/to/clone/server.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>~/Library/Logs/work-dashboard/out.log</string>
    <key>StandardErrorPath</key>
    <string>~/Library/Logs/work-dashboard/err.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.yourname.work-dashboard.plist
launchctl kickstart -k gui/$(id -u)/com.yourname.work-dashboard   # restart after changes
```

Notes for a reliable service:
- Use an **absolute** path to `node` and to `server.js` — launchd has a minimal `PATH`.
- Do **not** point `WorkingDirectory` or the log files inside `~/Documents`, `~/Desktop`, or `~/Downloads` — macOS TCC can block launchd from those folders and the spawn fails with `EX_CONFIG (78)` before the app even runs. Keep logs in `~/Library/Logs/`.

## Tech stack

Node.js · Express · googleapis · node-fetch · dotenv. Frontend is vanilla HTML/CSS/JS — no build, no dependencies.
