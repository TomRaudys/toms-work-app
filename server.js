const express = require('express');
const fetch = require('node-fetch');
const { google } = require('googleapis');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Load env vars
require('dotenv').config();

app.use(express.static(path.join(__dirname, 'public')));
// --- ClickUp ---
app.get('/api/clickup/tasks', async (req, res) => {
  try {
    const token = process.env.CLICKUP_API_TOKEN;
    if (!token) return res.json({ error: 'No ClickUp token configured' });

    // Get tasks assigned to me across all spaces
    const teamId = process.env.CLICKUP_TEAM_ID;
    const resp = await fetch(
      `https://api.clickup.com/api/v2/team/${teamId}/task?assignees[]=${process.env.CLICKUP_USER_ID}&statuses[]=open&statuses[]=in%20progress&statuses[]=to%20do&order_by=due_date&subtasks=true&include_closed=false&page=0`,
      { headers: { Authorization: token } }
    );
    const data = await resp.json();
    const tasks = (data.tasks || []).slice(0, 10).map(t => ({
      id: t.id,
      name: t.name,
      status: t.status?.status,
      statusColor: t.status?.color,
      priority: t.priority?.priority,
      priorityColor: t.priority?.color,
      dueDate: t.due_date,
      url: t.url,
      list: t.list?.name,
      folder: t.folder?.name,
    }));
    res.json({ tasks });
  } catch (err) {
    console.error('ClickUp error:', err.message);
    res.json({ error: err.message });
  }
});

app.get('/api/clickup/notifications', async (req, res) => {
  try {
    const token = process.env.CLICKUP_API_TOKEN;
    if (!token) return res.json({ error: 'No ClickUp token configured' });

    const resp = await fetch(
      'https://api.clickup.com/api/v2/notification?page=0',
      { headers: { Authorization: token } }
    );
    const data = await resp.json();
    const unread = (data.notifications || []).filter(n => !n.seen).length;
    res.json({ unread, total: (data.notifications || []).length });
  } catch (err) {
    console.error('ClickUp notifications error:', err.message);
    res.json({ error: err.message });
  }
});

// --- Slack ---
app.get('/api/slack/todos', async (req, res) => {
  try {
    const xoxcToken = process.env.SLACK_XOXC_TOKEN;
    const dCookie = process.env.SLACK_D_COOKIE;
    if (!xoxcToken || !dCookie) return res.json({ error: 'No Slack xoxc token or d cookie configured' });

    const resp = await fetch('https://app.slack.com/api/saved.list', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': `d=${dCookie}`,
      },
      body: `token=${encodeURIComponent(xoxcToken)}`,
    });
    const data = await resp.json();
    if (!data.ok) {
      return res.json({ error: data.error || 'Slack saved.list API error' });
    }

    const counts = data.counts || {};
    res.json({
      count: counts.uncompleted_count || 0,
      uncompleted: counts.uncompleted_count || 0,
      completed: counts.completed_count || 0,
      total: counts.total_count || 0,
      items: (data.saved_items || []).slice(0, 10).map(item => ({
        type: item.type,
        text: item.message?.text?.substring(0, 120) || item.title || 'Saved item',
        date: item.date_create,
      }))
    });
  } catch (err) {
    console.error('Slack error:', err.message);
    res.json({ error: err.message });
  }
});

app.get('/api/slack/unread', async (req, res) => {
  try {
    const xoxcToken = process.env.SLACK_XOXC_TOKEN;
    const dCookie = process.env.SLACK_D_COOKIE;
    if (!xoxcToken || !dCookie) return res.json({ error: 'No Slack xoxc token or d cookie configured' });

    // Use client.counts to get unread counts (works with xoxc tokens)
    const resp = await fetch('https://app.slack.com/api/client.counts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': `d=${dCookie}`,
      },
      body: `token=${encodeURIComponent(xoxcToken)}&thread_count_by_channel=true`,
    });
    const data = await resp.json();

    if (!data.ok) {
      return res.json({ error: data.error || 'Slack client.counts API error' });
    }

    // Count channels/groups/DMs with unreads
    let unreadChannels = 0;
    let unreadDMs = 0;
    let unreadMentions = 0;

    for (const ch of (data.channels || [])) {
      if (ch.has_unreads) unreadChannels++;
      unreadMentions += (ch.mention_count || 0);
    }
    for (const mp of (data.mpims || [])) {
      if (mp.has_unreads) unreadDMs++;
      unreadMentions += (mp.mention_count || 0);
    }
    for (const im of (data.ims || [])) {
      if (im.has_unreads) unreadDMs++;
      unreadMentions += (im.mention_count || 0);
    }

    res.json({ unreadChannels, unreadDMs, unreadMentions, total: unreadChannels + unreadDMs });
  } catch (err) {
    console.error('Slack unread error:', err.message);
    res.json({ error: err.message });
  }
});

// --- Gmail ---
function getGoogleAuth() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'http://localhost:3000/auth/google/callback'
  );
  auth.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });
  return auth;
}

app.get('/api/gmail/unread', async (req, res) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID) return res.json({ error: 'No Google credentials configured' });
    const auth = getGoogleAuth();
    const gmail = google.gmail({ version: 'v1', auth });

    // Use label stats for exact unread count (matches Gmail UI sidebar)
    const inboxLabel = await gmail.users.labels.get({ userId: 'me', id: 'INBOX' });
    const unreadThreads = inboxLabel.data.threadsUnread || 0;

    res.json({
      unread: unreadThreads,
    });
  } catch (err) {
    console.error('Gmail error:', err.message);
    res.json({ error: err.message });
  }
});

// --- Google Calendar ---
app.get('/api/calendar/today', async (req, res) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID) return res.json({ error: 'No Google credentials configured' });
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: 'v3', auth });

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const endOf30d = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    // Today's events
    const eventsResp = await calendar.events.list({
      calendarId: 'primary',
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = (eventsResp.data.items || []).filter(e => {
      // Hide working location events (e.g. "Home")
      if ((e.eventType || 'default') === 'workingLocation') return false;
      return true;
    }).map(e => {
      const otherAttendees = (e.attendees || []).filter(a => !a.self);
      const attendeeCounts = otherAttendees.length > 0 ? {
        total: otherAttendees.length,
        accepted: otherAttendees.filter(a => a.responseStatus === 'accepted').length,
        declined: otherAttendees.filter(a => a.responseStatus === 'declined').length,
        needsAction: otherAttendees.filter(a => a.responseStatus === 'needsAction').length,
        tentative: otherAttendees.filter(a => a.responseStatus === 'tentative').length,
      } : null;
      // Determine event tag from colorId (matches Google Calendar tags)
      const colorTagMap = {
        '5': 'Executive',
        '6': 'Development',
        '2': 'Team/HR',
        '8': 'Focus',
        '4': 'External',
        '3': 'Marketing',
        '10': 'Director',
      };
      let tag = null;
      const eventType = e.eventType || 'default';
      if (eventType === 'outOfOffice') {
        tag = 'OOO';
      } else if (eventType === 'focusTime') {
        tag = 'Focus';
      } else if (eventType === 'workingLocation') {
        tag = 'Location';
      } else if (e.colorId && colorTagMap[e.colorId]) {
        tag = colorTagMap[e.colorId];
      }

      // Meeting link: prefer hangoutLink, then conferenceData video entry
      let meetingLink = e.hangoutLink || null;
      if (!meetingLink && e.conferenceData?.entryPoints) {
        const video = e.conferenceData.entryPoints.find(ep => ep.entryPointType === 'video');
        if (video) meetingLink = video.uri;
      }

      return {
        summary: e.summary,
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
        status: e.status,
        responseStatus: e.attendees?.find(a => a.self)?.responseStatus,
        htmlLink: e.htmlLink,
        meetingLink,
        isAllDay: !e.start?.dateTime,
        attendeeCounts,
        tag,
        eventType,
      };
    });

    // Pending invites in next 7 days
    const upcomingResp = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: endOf30d.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const pendingInvites = (upcomingResp.data.items || []).filter(e => {
      const myResponse = e.attendees?.find(a => a.self);
      return myResponse && myResponse.responseStatus === 'needsAction';
    }).map(e => ({
      summary: e.summary,
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      organizer: e.organizer?.displayName || e.organizer?.email,
      htmlLink: e.htmlLink,
    }));

    // Meeting stats: count and total time for accepted non-special events
    let meetingCount = 0;
    let meetingMinutes = 0;
    for (const raw of (eventsResp.data.items || [])) {
      const et = raw.eventType || 'default';
      // Skip OOO, focus time, working location, all-day events
      if (et === 'outOfOffice' || et === 'focusTime' || et === 'workingLocation') continue;
      if (!raw.start?.dateTime) continue; // skip all-day
      // Only count if user accepted (or is organizer with no attendees = self-event)
      const myResponse = raw.attendees?.find(a => a.self);
      const status = myResponse ? myResponse.responseStatus : 'accepted'; // no attendees = own event
      if (status !== 'accepted') continue;
      meetingCount++;
      const start = new Date(raw.start.dateTime);
      const end = new Date(raw.end.dateTime);
      meetingMinutes += (end - start) / 60000;
    }

    // Weekly meeting stats: Monday to Sunday of current week
    const day = now.getDay(); // 0=Sun, 1=Mon ...
    const diffToMon = day === 0 ? -6 : 1 - day;
    const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMon);
    const endOfWeek = new Date(startOfWeek.getTime() + 7 * 24 * 60 * 60 * 1000);

    const weekResp = await calendar.events.list({
      calendarId: 'primary',
      timeMin: startOfWeek.toISOString(),
      timeMax: endOfWeek.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    });

    let weeklyMeetingMinutes = 0;
    for (const raw of (weekResp.data.items || [])) {
      const et = raw.eventType || 'default';
      if (et === 'outOfOffice' || et === 'focusTime' || et === 'workingLocation') continue;
      if (!raw.start?.dateTime) continue;
      const myResponse = raw.attendees?.find(a => a.self);
      const status = myResponse ? myResponse.responseStatus : 'accepted';
      if (status !== 'accepted') continue;
      const start = new Date(raw.start.dateTime);
      const end = new Date(raw.end.dateTime);
      weeklyMeetingMinutes += (end - start) / 60000;
    }

    res.json({ events, pendingInvites, meetingCount, meetingMinutes, weeklyMeetingMinutes });
  } catch (err) {
    console.error('Calendar error:', err.message);
    res.json({ error: err.message });
  }
});

// --- Upcoming Releases & Milestones ---
app.get('/api/releases', async (req, res) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.json({ error: 'No Google credentials configured' });
    }
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: 'v3', auth });
    const now = new Date();
    const end90d = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    const end24mo = new Date(now.getFullYear() + 2, now.getMonth(), now.getDate());

    // Fetch from both calendars in parallel (milestones look 24 months ahead)
    const calendarIds = [
      { id: process.env.FLAT2VR_CALENDAR_ID, source: 'release', endDate: end90d },
      { id: process.env.MILESTONES_CALENDAR_ID, source: 'milestone', endDate: end24mo },
    ].filter(c => c.id);

    const results = await Promise.all(calendarIds.map(async ({ id, source, endDate: calEnd }) => {
      try {
        const resp = await calendar.events.list({
          calendarId: id,
          timeMin: now.toISOString(),
          timeMax: calEnd.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 50,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        return (resp.data.items || []).map(e => {
          const isAllDay = !e.start?.dateTime;
          let name = e.summary || 'Untitled';
          if (name.includes(' :: ')) {
            name = name.split(' :: ')[0].replace(/^🔄\s*/, '');
          }
          // For all-day events, normalise the bare date to a full ISO timestamp
          // so the frontend always gets a consistent format
          let date = e.start?.dateTime || e.start?.date;
          let endDate = e.end?.dateTime || e.end?.date;
          if (isAllDay && date && date.length === 10) {
            date = date + 'T00:00:00';
          }
          if (isAllDay && endDate && endDate.length === 10) {
            endDate = endDate + 'T00:00:00';
          }
          return {
            name,
            date,
            endDate,
            isAllDay,
            htmlLink: e.htmlLink,
            source,
          };
        });
      } catch (err) {
        console.error(`Calendar ${source} error:`, err.message);
        return [];
      }
    }));

    // Merge and sort by date
    const releases = results.flat().sort((a, b) => new Date(a.date) - new Date(b.date));

    res.json({ releases });
  } catch (err) {
    console.error('Releases error:', err.message);
    res.json({ error: err.message });
  }
});

// --- ClickUp High Level (Big things list) ---
app.get('/api/clickup/highlevel', async (req, res) => {
  try {
    const token = process.env.CLICKUP_API_TOKEN;
    const listId = process.env.CLICKUP_HIGHLEVEL_LIST_ID;
    if (!token || !listId) return res.json({ error: 'No ClickUp token or list ID configured' });

    const resp = await fetch(
      `https://api.clickup.com/api/v2/list/${listId}/task?include_closed=false&subtasks=false&order_by=due_date`,
      { headers: { Authorization: token } }
    );
    const data = await resp.json();
    const tasks = (data.tasks || []).map(t => ({
      id: t.id,
      name: t.name,
      status: t.status?.status,
      statusColor: t.status?.color,
      priority: t.priority?.priority,
      priorityColor: t.priority?.color,
      url: t.url,
      dueDate: t.due_date,
      startDate: t.start_date,
    }));
    res.json({ tasks });
  } catch (err) {
    console.error('ClickUp high level error:', err.message);
    res.json({ error: err.message });
  }
});

// --- Weekly Summary (Fireflies + Google Drive "Notes by Gemini") ---
// Cache to avoid re-fetching on every request
let weeklySummaryCache = { data: null, sourceHash: null, lastFetch: 0 };

function getWeekBounds() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 5);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { start, end };
}

async function fetchFirefliesMeetings(weekStart, weekEnd) {
  const apiKey = process.env.FIREFLIES_API_KEY;
  if (!apiKey) return [];

  try {
    const resp = await fetch('https://api.fireflies.ai/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: `query {
          transcripts(limit: 20) {
            id
            title
            date
            duration
            organizer_email
            summary {
              shorthand_bullet
              action_items
              overview
              short_summary
            }
            participants
          }
        }`
      }),
    });
    const json = await resp.json();
    if (json.errors) {
      console.error('Fireflies GraphQL errors:', json.errors);
      return [];
    }
    const transcripts = json.data?.transcripts || [];
    const myEmail = 'tom@flat2vr.com';
    // Filter to this week + only meetings I attended/was invited to
    return transcripts.filter(t => {
      const d = new Date(parseInt(t.date));
      if (d < weekStart || d >= weekEnd) return false;
      // Check if I'm organizer or participant
      const isOrganizer = t.organizer_email === myEmail;
      const isParticipant = (t.participants || []).some(p =>
        p === myEmail || (typeof p === 'string' && p.toLowerCase().includes('tom'))
      );
      return isOrganizer || isParticipant;
    });
  } catch (err) {
    console.error('Fireflies fetch error:', err.message);
    return [];
  }
}

async function fetchGeminiNotes(weekStart) {
  if (!process.env.GOOGLE_CLIENT_ID) return [];

  try {
    const auth = getGoogleAuth();
    const drive = google.drive({ version: 'v3', auth });
    const docs = google.docs({ version: 'v1', auth });

    // Search for "Notes by Gemini" docs modified this week
    const driveResp = await drive.files.list({
      q: `name contains 'Notes by Gemini' and mimeType='application/vnd.google-apps.document' and modifiedTime > '${weekStart.toISOString()}'`,
      fields: 'files(id, name, createdTime, modifiedTime, webViewLink)',
      orderBy: 'createdTime desc',
      pageSize: 20,
    });

    const files = driveResp.data.files || [];
    const results = [];

    for (const file of files) {
      try {
        const docResp = await docs.documents.get({ documentId: file.id });
        // Extract plain text from doc body
        let text = '';
        const body = docResp.data.body;
        if (body?.content) {
          for (const el of body.content) {
            if (el.paragraph?.elements) {
              for (const pe of el.paragraph.elements) {
                if (pe.textRun?.content) {
                  text += pe.textRun.content;
                }
              }
            }
          }
        }
        results.push({
          id: file.id,
          name: file.name,
          createdTime: file.createdTime,
          link: file.webViewLink,
          content: text.trim(),
        });
      } catch (docErr) {
        console.error(`Error reading doc ${file.name}:`, docErr.message);
        results.push({
          id: file.id,
          name: file.name,
          createdTime: file.createdTime,
          link: file.webViewLink,
          content: '(Could not read document content)',
        });
      }
    }
    return results;
  } catch (err) {
    console.error('Google Drive/Docs error:', err.message);
    return [];
  }
}

function buildWeeklySummary(firefliesMeetings, geminiNotes) {
  const meetings = [];

  // Build a set of Fireflies meeting title keywords for dedup matching
  const firefliesTitles = new Set();

  // Process Fireflies meetings first (they take priority)
  for (const m of firefliesMeetings) {
    const date = new Date(parseInt(m.date));
    const dateStr = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const durationMins = Math.round(m.duration || 0);
    const durationStr = durationMins >= 60
      ? `${Math.floor(durationMins / 60)}h ${durationMins % 60}m`
      : `${durationMins}m`;

    // Store normalised title keywords for dedup matching against Gemini
    firefliesTitles.add(m.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());

    meetings.push({
      source: 'fireflies',
      title: m.title,
      date: dateStr,
      dateRaw: date.toISOString(),
      duration: durationStr,
      summary: m.summary?.short_summary || '',
      overview: m.summary?.overview || '',
    });
  }

  // Process Gemini notes — skip if Fireflies already has a transcript for the same meeting
  for (const note of geminiNotes) {
    const date = new Date(note.createdTime);
    const dateStr = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

    // Extract meeting title from doc name (format: "⚙ Name - date - Notes by Gemini")
    let title = note.name;
    const geminiIdx = title.indexOf(' - Notes by Gemini');
    if (geminiIdx > 0) title = title.substring(0, geminiIdx);
    // Remove emoji prefix and date suffix
    title = title.replace(/^[^\w]*/, '').trim();
    // Try to remove date portion (e.g. "2026/02/20 17:56 CET")
    title = title.replace(/\s*-?\s*\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}\s+\w+\s*$/, '').trim();

    const finalTitle = title || note.name;

    // Check if Fireflies already covers this meeting (fuzzy title match)
    const gnNorm = finalTitle.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const gnWords = gnNorm.split(' ').filter(w => w.length > 2);
    const hasDuplicate = [...firefliesTitles].some(ft => {
      const matchCount = gnWords.filter(w => ft.includes(w)).length;
      return matchCount >= Math.min(2, gnWords.length);
    });
    if (hasDuplicate) continue;

    meetings.push({
      source: 'gemini',
      title: finalTitle,
      date: dateStr,
      dateRaw: date.toISOString(),
      link: note.link,
      summary: '',
      content: note.content,
    });
  }

  // Sort meetings newest first
  meetings.sort((a, b) => new Date(b.dateRaw) - new Date(a.dateRaw));

  return {
    meetings,
    meetingCount: meetings.length,
    sourceCount: { fireflies: firefliesMeetings.length, gemini: geminiNotes.length },
  };
}

app.get('/api/weekly-summary', async (req, res) => {
  try {
    const { start, end } = getWeekBounds();

    // Quick source count check for caching
    const [fireflies, gemini] = await Promise.all([
      fetchFirefliesMeetings(start, end),
      fetchGeminiNotes(start),
    ]);

    const sourceHash = `ff:${fireflies.length}-gn:${gemini.length}`;
    const now = Date.now();
    const cacheAge = now - weeklySummaryCache.lastFetch;

    // Use cache if source counts match and cache is less than 10 minutes old
    if (weeklySummaryCache.data && weeklySummaryCache.sourceHash === sourceHash && cacheAge < 600000) {
      return res.json(weeklySummaryCache.data);
    }

    const summary = buildWeeklySummary(fireflies, gemini);
    weeklySummaryCache = { data: summary, sourceHash, lastFetch: now };
    res.json(summary);
  } catch (err) {
    console.error('Weekly summary error:', err.message);
    res.json({ error: err.message });
  }
});

// --- Google OAuth re-auth (for adding new scopes) ---
app.get('/auth/google', (req, res) => {
  const auth = getGoogleAuth();
  const url = auth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/documents.readonly',
    ],
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const auth = getGoogleAuth();
    const { tokens } = await auth.getToken(req.query.code);
    console.log('\n=== NEW REFRESH TOKEN ===');
    console.log(tokens.refresh_token);
    console.log('=========================\n');
    res.send('<h2>Auth successful!</h2><p>New refresh token has been printed to the server console. Update your .env file with it.</p><p>You can close this tab.</p>');
  } catch (err) {
    console.error('Auth error:', err.message);
    res.status(500).send('Auth error: ' + err.message);
  }
});

// --- Health check ---
app.get('/api/health', (req, res) => {
  res.json({
    clickup: !!process.env.CLICKUP_API_TOKEN,
    slack: !!process.env.SLACK_USER_TOKEN,
    google: !!process.env.GOOGLE_CLIENT_ID,
  });
});

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
