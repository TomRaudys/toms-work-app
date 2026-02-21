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
    const token = process.env.SLACK_USER_TOKEN;
    if (!token) return res.json({ error: 'No Slack token configured' });

    // Get "Saved for Later" items (starred items)
    let allItems = [];
    let cursor = '';
    let totalCount = 0;

    // Paginate to get accurate total count
    do {
      const url = `https://slack.com/api/stars.list?limit=100${cursor ? '&cursor=' + cursor : ''}`;
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await resp.json();
      if (!data.ok) {
        return res.json({ error: data.error || 'Slack API error' });
      }
      const items = data.items || [];
      allItems = allItems.concat(items);
      totalCount = data.paging?.total || allItems.length;
      cursor = data.response_metadata?.next_cursor || '';
    } while (cursor && allItems.length < 20);

    res.json({
      count: totalCount,
      items: allItems.slice(0, 10).map(item => ({
        type: item.type,
        text: item.message?.text?.substring(0, 120) || item.file?.name || item.channel || 'Saved item',
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

    // Try CATEGORY_PRIMARY first (matches what user sees in Primary tab)
    // Fall back to INBOX if categories aren't enabled
    const [inboxLabel, starredLabel] = await Promise.all([
      gmail.users.labels.get({ userId: 'me', id: 'INBOX' }),
      gmail.users.labels.get({ userId: 'me', id: 'STARRED' }),
    ]);

    let primaryUnread;
    try {
      const primaryLabel = await gmail.users.labels.get({ userId: 'me', id: 'CATEGORY_PRIMARY' });
      primaryUnread = primaryLabel.data.messagesUnread || 0;
    } catch {
      // Categories not enabled - use INBOX count directly
      primaryUnread = null;
    }

    const inboxUnread = inboxLabel.data.messagesUnread || 0;
    const followUpCount = starredLabel.data.messagesTotal || 0;

    res.json({
      unread: primaryUnread !== null ? primaryUnread : inboxUnread,
      totalUnread: inboxUnread,
      followUps: followUpCount,
      hasCategoryTabs: primaryUnread !== null,
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
    const endOf24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    // Today's events
    const eventsResp = await calendar.events.list({
      calendarId: 'primary',
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = (eventsResp.data.items || []).map(e => ({
      summary: e.summary,
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      status: e.status,
      responseStatus: e.attendees?.find(a => a.self)?.responseStatus,
      htmlLink: e.htmlLink,
      isAllDay: !e.start?.dateTime,
    }));

    // Pending invites in next 24 hours
    const upcomingResp = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: endOf24h.toISOString(),
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

    res.json({ events, pendingInvites });
  } catch (err) {
    console.error('Calendar error:', err.message);
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
