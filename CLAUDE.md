# Work Dashboard

A personal work dashboard that aggregates data from ClickUp, Slack, Gmail, Google Calendar, Google Drive (Gemini meeting notes), and Fireflies into a single-page web app.

## Architecture

- **Backend**: Node.js + Express (`server.js`) — serves API endpoints that proxy to external services
- **Frontend**: Single-page HTML/CSS/JS (`public/index.html`) — fetches from the backend APIs and renders dashboard cards
- **Config**: All credentials and user-specific IDs live in `.env` (gitignored)

## Setup for a New User

### 1. Install dependencies

```bash
npm install
```

### 2. Create your `.env` file

```bash
cp .env.example .env
```

Then fill in every value in `.env`. See the sections below for how to get each credential.

### 3. Configure the startup script

Edit `start-dashboard.sh` and update the paths to match your system:
- Update the `fnm` path to your own (or replace with your node version manager)
- Update the fallback node path to your node installation
- Update the `cd` path to wherever you cloned this repo

### 4. Set up launchd (macOS auto-start)

Create `~/Library/LaunchAgents/com.yourname.work-dashboard.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.yourname.work-dashboard</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/path/to/your/clone/start-dashboard.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/path/to/your/clone/dashboard.log</string>
    <key>StandardErrorPath</key>
    <string>/path/to/your/clone/dashboard-error.log</string>
</dict>
</plist>
```

Then load it:

```bash
launchctl load ~/Library/LaunchAgents/com.yourname.work-dashboard.plist
```

Or just run manually with `npm start` and visit `http://localhost:3000`.

### 5. Restart after config changes

```bash
launchctl kickstart -k gui/$(id -u)/com.yourname.work-dashboard
```

Or kill the node process and run `npm start` again.

---

## Credential Setup Guide

### ClickUp

1. Go to https://app.clickup.com/settings/apps and generate a personal API token
2. Set `CLICKUP_API_TOKEN` to that token (starts with `pk_`)
3. Set `CLICKUP_TEAM_ID` — find this in any ClickUp URL: `app.clickup.com/{team_id}/...`
4. Set `CLICKUP_USER_ID` — your numeric user ID (visible in the API token page URL or via the ClickUp API)
5. Set `CLICKUP_HIGHLEVEL_LIST_ID` — the list ID for your "big picture" / high-level items list. Find it by opening the list in ClickUp and grabbing the ID from the URL
6. Set `CLICKUP_RELEASES_LIST_ID` — the list ID for your releases/launches list

### Slack

The dashboard uses Slack's internal APIs (not the official Bot/App API) to read saved items and unread counts. You need session tokens from your browser:

1. Open Slack in your browser and sign in
2. Open browser DevTools → Application → Cookies
3. `SLACK_XOXC_TOKEN` — find the `token` value in a network request (starts with `xoxc-`)
4. `SLACK_D_COOKIE` — find the `d` cookie value (starts with `xoxd-`)
5. `SLACK_USER_TOKEN` — a user token with `reminders:read` scope. Create at https://api.slack.com/apps (starts with `xoxp-`)

> **Note**: The `xoxc` token and `d` cookie expire when you sign out of Slack in the browser. You'll need to refresh these periodically.

### Google (Gmail + Calendar + Drive)

1. Go to https://console.cloud.google.com/apis/credentials
2. Create an OAuth 2.0 Client ID (type: Web application)
3. Add `http://localhost:3000/auth/google/callback` as an authorized redirect URI
4. Enable these APIs in your Google Cloud project:
   - Gmail API
   - Google Calendar API
   - Google Drive API
   - Google Docs API
5. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from your OAuth client
6. Start the server (`npm start`), then visit `http://localhost:3000/auth/google` in your browser
7. Complete the OAuth flow — the server will print your refresh token to the console
8. Set `GOOGLE_REFRESH_TOKEN` to that value
9. `FLAT2VR_CALENDAR_ID` — (optional) a secondary Google Calendar ID to show events from. Find it in Google Calendar → Settings → calendar → "Integrate calendar" → Calendar ID
10. `MILESTONES_CALENDAR_ID` — (optional) another secondary calendar ID for milestones

### Fireflies

1. Go to https://app.fireflies.ai/integrations/custom/fireflies
2. Generate an API key
3. Set `FIREFLIES_API_KEY` to that key

### User Identity

- `MY_EMAIL` — your email address, used to filter Fireflies transcripts to meetings you attended
- `MY_NAME` — your first name (lowercase), used as a fallback to match you in Fireflies participant lists

---

## User-Specific Customizations

Beyond `.env`, there are a few things in the code that a new user may want to customize:

### Dashboard Title (`public/index.html`)

Line 6 and line ~797 contain the title "Tom's Work Dashboard". Change to your own name.

### Calendar Color Tags (`server.js`)

The `colorTagMap` object (around line 214) maps Google Calendar color IDs to category labels like "Executive", "Development", "Marketing", etc. These are specific to how the original user color-codes their calendar events. Update or remove these to match your own color-coding scheme, or delete the map entirely if you don't use calendar colors.

```js
const colorTagMap = {
  '5': 'Executive',
  '6': 'Development',
  '2': 'Team/HR',
  '8': 'Focus',
  '4': 'External',
  '3': 'Marketing',
  '10': 'Director',
};
```

### ClickUp Task Filters (`server.js`)

The `/api/releases` endpoint filters out tasks with status `launched` or `archive`. The `/api/clickup/tasks` endpoint filters to statuses `open`, `in progress`, and `to do`. Adjust these if your ClickUp workspace uses different status names.

---

## Running

```bash
npm start
```

The dashboard runs at `http://localhost:3000` by default (configurable via `PORT` env var).

## API Endpoints

| Endpoint | Source | Description |
|---|---|---|
| `GET /api/clickup/tasks` | ClickUp | Tasks assigned to you |
| `GET /api/clickup/notifications` | ClickUp | Unread notification count |
| `GET /api/clickup/highlevel` | ClickUp | High-level / big picture tasks |
| `GET /api/releases` | ClickUp | Upcoming releases list |
| `GET /api/slack/todos` | Slack | Saved items / to-dos |
| `GET /api/slack/unread` | Slack | Unread channel/DM counts |
| `GET /api/gmail/unread` | Gmail | Unread inbox thread count |
| `GET /api/calendar/today` | Google Calendar | Today's events, pending invites, meeting stats |
| `GET /api/weekly-summary` | Fireflies + Google Drive | This week's meeting summaries |
| `GET /api/health` | — | Which services are configured |
| `GET /auth/google` | — | Start Google OAuth flow (for getting refresh token) |
