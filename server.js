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
    const token = process.env.SLACK_USER_TOKEN;
    if (!token) return res.json({ error: 'No Slack token configured' });

    // Get unread count from conversations
    const resp = await fetch('https://slack.com/api/users.counts?include_threads=true', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await resp.json();
    let unreadChannels = 0;
    let unreadDMs = 0;
    if (data.channels) {
      unreadChannels = data.channels.filter(c => c.has_unreads).length;
    }
    if (data.ims) {
      unreadDMs = data.ims.filter(c => c.has_unreads).length;
    }
    res.json({ unreadChannels, unreadDMs, total: unreadChannels + unreadDMs });
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

    const events = (eventsResp.data.items || []).map(e => {
      const otherAttendees = (e.attendees || []).filter(a => !a.self);
      const attendeeCounts = otherAttendees.length > 0 ? {
        total: otherAttendees.length,
        accepted: otherAttendees.filter(a => a.responseStatus === 'accepted').length,
        declined: otherAttendees.filter(a => a.responseStatus === 'declined').length,
        needsAction: otherAttendees.filter(a => a.responseStatus === 'needsAction').length,
        tentative: otherAttendees.filter(a => a.responseStatus === 'tentative').length,
      } : null;
      // Determine event tag from eventType, organizer domain
      let tag = null;
      const eventType = e.eventType || 'default';
      if (eventType === 'outOfOffice') {
        tag = 'OOO';
      } else if (eventType === 'focusTime') {
        tag = 'Focus';
      } else if (eventType === 'workingLocation') {
        tag = 'Location';
      } else {
        // Check if external (organizer from different domain than user)
        const orgEmail = e.organizer?.email || '';
        const userDomain = 'flat2vr.com';
        if (orgEmail && !orgEmail.includes('@calendar.google.com') && !orgEmail.endsWith('@' + userDomain)) {
          tag = 'External';
        }
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

// --- Upcoming Releases (Flat2VR Internal Calendar) ---
app.get('/api/releases', async (req, res) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.FLAT2VR_CALENDAR_ID) {
      return res.json({ error: 'No Google credentials or calendar ID configured' });
    }
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: 'v3', auth });
    const now = new Date();

    const end30d = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const resp = await calendar.events.list({
      calendarId: process.env.FLAT2VR_CALENDAR_ID,
      timeMin: now.toISOString(),
      timeMax: end30d.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    });

    const releases = (resp.data.items || []).map(e => {
      const isAllDay = !e.start?.dateTime;
      // Clean up summary (remove synced prefixes like "🔄 ... :: ...")
      let name = e.summary || 'Untitled';
      if (name.includes(' :: ')) {
        name = name.split(' :: ')[0].replace(/^🔄\s*/, '');
      }
      return {
        name,
        date: e.start?.dateTime || e.start?.date,
        endDate: e.end?.dateTime || e.end?.date,
        isAllDay,
        htmlLink: e.htmlLink,
      };
    });

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
      `https://api.clickup.com/api/v2/list/${listId}/task?include_closed=false&subtasks=true&order_by=due_date`,
      { headers: { Authorization: token } }
    );
    const data = await resp.json();
    const tasks = (data.tasks || []).map(t => ({
      id: t.id,
      name: t.name,
      status: t.status?.status,
      statusColor: t.status?.color,
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
