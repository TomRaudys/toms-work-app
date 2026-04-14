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

    const slackPost = (endpoint, body) => fetch(`https://app.slack.com/api/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': `d=${dCookie}` },
      body: `token=${encodeURIComponent(xoxcToken)}&${body}`,
    }).then(r => r.json());

    // Get workspace domain for deep links (cached after first call)
    if (!global._slackDomain) {
      try {
        const authData = await slackPost('auth.test', '');
        if (authData.ok && authData.url) {
          global._slackDomain = authData.url.replace(/\/$/, '');
        }
      } catch {}
    }

    const cursor = req.query.cursor || '';
    const limit = parseInt(req.query.limit) || 20;
    const data = await slackPost('saved.list', `limit=${limit}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
    if (!data.ok) {
      return res.json({ error: data.error || 'Slack saved.list API error' });
    }

    const savedItems = data.saved_items || [];
    const nextCursor = data.response_metadata?.next_cursor || '';

    // Cache for user names and channel names to avoid duplicate lookups
    const userCache = {};
    const chanCache = {};

    async function resolveUser(userId) {
      if (!userId) return '';
      if (userCache[userId]) return userCache[userId];
      try {
        const ud = await slackPost('users.info', `user=${userId}`);
        const name = ud.ok ? (ud.user?.profile?.display_name || ud.user?.real_name || ud.user?.name || userId) : userId;
        userCache[userId] = name;
        return name;
      } catch { userCache[userId] = userId; return userId; }
    }

    async function resolveChan(channelId) {
      if (chanCache[channelId]) return chanCache[channelId];
      try {
        const cd = await slackPost('conversations.info', `channel=${channelId}`);
        let name = '';
        if (cd.ok) {
          if (cd.channel?.is_im) name = 'DM';
          else if (cd.channel?.is_mpim) name = 'Group DM';
          else name = cd.channel?.name || '';
        }
        chanCache[channelId] = name;
        return name;
      } catch { chanCache[channelId] = ''; return ''; }
    }

    // Fetch actual message content + channel info + user names in parallel
    const enriched = await Promise.all(savedItems.map(async (item) => {
      try {
        const channelId = item.item_id;
        const ts = item.ts;

        const [msgData, channelName] = await Promise.all([
          slackPost('conversations.history', `channel=${channelId}&latest=${ts}&oldest=${ts}&inclusive=true&limit=1`),
          resolveChan(channelId),
        ]);

        const msg = msgData.ok ? msgData.messages?.[0] : null;
        const userName = await resolveUser(msg?.user);

        return {
          type: item.item_type || 'message',
          text: msg?.text?.substring(0, 400) || '(no content)',
          channel: channelName,
          channelId: channelId,
          user: userName,
          date: item.date_created,
          msgTs: msg?.ts ? parseFloat(msg.ts) : item.date_created,
          ts: item.ts,
        };
      } catch (e) {
        return {
          type: item.item_type || 'message',
          text: '(failed to load)',
          channel: '',
          channelId: '',
          user: '',
          date: item.date_created,
          msgTs: item.date_created,
          ts: '',
        };
      }
    }));

    const counts = data.counts || {};
    res.json({
      count: counts.uncompleted_count || 0,
      uncompleted: counts.uncompleted_count || 0,
      completed: counts.completed_count || 0,
      total: counts.total_count || 0,
      items: enriched,
      nextCursor: nextCursor,
      slackDomain: global._slackDomain || '',
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
    const endOfInviteWindow = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());

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

      // Individual attendee details for tooltip
      const attendees = (e.attendees || []).filter(a => !a.self).map(a => ({
        name: a.displayName || a.email,
        status: a.responseStatus,
      }));

      return {
        summary: e.summary,
        description: e.description || null,
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
        status: e.status,
        responseStatus: e.attendees?.find(a => a.self)?.responseStatus,
        htmlLink: e.htmlLink,
        meetingLink,
        isAllDay: !e.start?.dateTime,
        attendeeCounts,
        attendees,
        tag,
        eventType,
      };
    });

    // Pending invites in next 12 months
    const upcomingResp = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: endOfInviteWindow.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const pendingInvites = (upcomingResp.data.items || []).filter(e => {
      const myResponse = e.attendees?.find(a => a.self);
      return myResponse && myResponse.responseStatus === 'needsAction';
    }).map(e => ({
      id: e.id,
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

    // Weekly meeting stats: 6 past weeks + current week + next week
    const day = now.getDay(); // 0=Sun, 1=Mon ...
    const diffToMon = day === 0 ? -6 : 1 - day;
    const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMon);
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

    // Build week ranges: 5 weeks ago through next week (8 weeks total)
    const weekStarts = [];
    for (let i = -5; i <= 2; i++) {
      weekStarts.push(new Date(startOfWeek.getTime() + i * WEEK_MS));
    }
    // Fetch entire range in one call
    const allWeeksResp = await calendar.events.list({
      calendarId: 'primary',
      timeMin: weekStarts[0].toISOString(),
      timeMax: weekStarts[weekStarts.length - 1].toISOString(),
      singleEvents: true, orderBy: 'startTime', maxResults: 2500,
    });

    function calcAcceptedMeetingMins(items) {
      let mins = 0;
      for (const raw of (items || [])) {
        const et = raw.eventType || 'default';
        if (et === 'outOfOffice' || et === 'focusTime' || et === 'workingLocation') continue;
        if (!raw.start?.dateTime) continue;
        const myResponse = raw.attendees?.find(a => a.self);
        const status = myResponse ? myResponse.responseStatus : 'accepted';
        if (status !== 'accepted') continue;
        mins += (new Date(raw.end.dateTime) - new Date(raw.start.dateTime)) / 60000;
      }
      return mins;
    }

    // Bucket events into weeks
    const allItems = allWeeksResp.data.items || [];
    const weeklyBreakdown = [];
    for (let i = 0; i < weekStarts.length - 1; i++) {
      const wStart = weekStarts[i];
      const wEnd = weekStarts[i + 1];
      const weekItems = allItems.filter(e => {
        const t = new Date(e.start?.dateTime || e.start?.date);
        return t >= wStart && t < wEnd;
      });
      const label = wStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      weeklyBreakdown.push({
        label,
        start: wStart.toISOString(),
        minutes: calcAcceptedMeetingMins(weekItems),
        isCurrent: i === 5,
        isNext: i === 6,
      });
    }

    const weeklyMeetingMinutes = weeklyBreakdown[5]?.minutes || 0;
    const lastWeekMeetingMinutes = weeklyBreakdown[4]?.minutes || 0;

    res.json({ events, pendingInvites, meetingCount, meetingMinutes, weeklyMeetingMinutes, lastWeekMeetingMinutes, weeklyBreakdown });
  } catch (err) {
    console.error('Calendar error:', err.message);
    res.json({ error: err.message });
  }
});

// --- Upcoming Releases (from ClickUp Calendars folder) ---
app.get('/api/releases', async (req, res) => {
  try {
    const token = process.env.CLICKUP_API_TOKEN;
    const folderId = process.env.CLICKUP_CALENDAR_FOLDER_ID;
    const masterCalId = process.env.CLICKUP_RELEASES_LIST_ID;
    if (!token) return res.json({ error: 'No ClickUp token configured' });

    function mapTask(t, listName) {
      const platformsField = (t.custom_fields || []).find(f => f.name === 'Platforms');
      let platforms = [];
      if (platformsField && platformsField.value && platformsField.type_config?.options) {
        const selected = Array.isArray(platformsField.value) ? platformsField.value : [];
        platforms = selected.map(id => {
          const opt = platformsField.type_config.options.find(o => o.id === id);
          return opt ? opt.label : null;
        }).filter(Boolean);
      }
      return {
        name: t.name,
        date: t.due_date ? new Date(parseInt(t.due_date)).toISOString() : null,
        status: t.status?.status,
        statusColor: t.status?.color,
        assignees: (t.assignees || []).map(a => a.username),
        platforms,
        category: listName || '',
        url: t.url,
      };
    }

    const sortByDate = (a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return new Date(a.date) - new Date(b.date);
    };

    // Get all lists in the Calendars folder
    const folderResp = await fetch(
      `https://api.clickup.com/api/v2/folder/${folderId}/list`,
      { headers: { Authorization: token } }
    );
    const folderData = await folderResp.json();

    // Separate Release Calendar from the rest
    const releaseCalList = (folderData.lists || []).find(l => l.name === 'Release Calendar');
    const releaseCalId = releaseCalList ? releaseCalList.id : null;
    // Skip master calendar (empty rollup) and Release Calendar from the event lists
    const eventLists = (folderData.lists || []).filter(l => l.id !== masterCalId && (!releaseCalId || l.id !== releaseCalId));

    // Fetch Release Calendar and all event lists in parallel
    const fetchList = async (id, name) => {
      const resp = await fetch(
        `https://api.clickup.com/api/v2/list/${id}/task?include_closed=false&subtasks=false&order_by=due_date`,
        { headers: { Authorization: token } }
      );
      const d = await resp.json();
      return (d.tasks || []).map(t => ({ ...t, listName: name }));
    };

    const [releaseCalTasks, ...eventTaskArrays] = await Promise.all([
      releaseCalId ? fetchList(releaseCalId, 'Release Calendar') : Promise.resolve([]),
      ...eventLists.map(l => fetchList(l.id, l.name)),
    ]);

    // Releases = from Release Calendar list
    const releases = releaseCalTasks
      .filter(t => t.status?.status !== 'launched' && t.status?.status !== 'archive')
      .map(t => mapTask(t, 'Release Calendar'))
      .sort(sortByDate);

    // All Events = from all other lists (not Release Calendar, not Master Calendar)
    const allEvents = eventTaskArrays.flat()
      .filter(t => t.status?.status !== 'launched' && t.status?.status !== 'archive')
      .map(t => mapTask(t, t.listName))
      .sort(sortByDate);

    res.json({ releases, allEvents });
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
    const myEmail = process.env.MY_EMAIL;
    // Filter to this week + only meetings I attended/was invited to
    return transcripts.filter(t => {
      const d = new Date(parseInt(t.date));
      if (d < weekStart || d >= weekEnd) return false;
      // Check if I'm organizer or participant
      const isOrganizer = t.organizer_email === myEmail;
      const myName = (process.env.MY_NAME || '').toLowerCase();
      const isParticipant = (t.participants || []).some(p =>
        p === myEmail || (myName && typeof p === 'string' && p.toLowerCase().includes(myName))
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
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
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
    // Auto-update .env with new refresh token
    if (tokens.refresh_token) {
      const envPath = require('path').join(__dirname, '.env');
      let envContent = require('fs').readFileSync(envPath, 'utf8');
      envContent = envContent.replace(/GOOGLE_REFRESH_TOKEN=.*/, 'GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token);
      require('fs').writeFileSync(envPath, envContent);
      // Update current process env too
      process.env.GOOGLE_REFRESH_TOKEN = tokens.refresh_token;
      res.send('<h2>Auth successful!</h2><p>Refresh token has been automatically updated in .env. Restart the server to apply.</p><p>You can close this tab.</p>');
    } else {
      res.send('<h2>Auth successful!</h2><p>No new refresh token was returned. The existing token may still work. Try restarting the server.</p>');
    }
  } catch (err) {
    console.error('Auth error:', err.message);
    res.status(500).send('Auth error: ' + err.message);
  }
});

// --- Respond to Calendar Invite ---
app.post('/api/calendar/respond', express.json(), async (req, res) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID) return res.json({ error: 'No Google credentials configured' });
    const { eventId, calendarId, response } = req.body;
    if (!eventId || !response) return res.json({ error: 'Missing eventId or response' });

    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: 'v3', auth });

    // Get the event first to preserve existing data
    const event = await calendar.events.get({
      calendarId: calendarId || 'primary',
      eventId: eventId,
    });

    // Find self in attendees and update response
    const myEmail = process.env.GOOGLE_CALENDAR_ID || 'primary';
    const attendees = (event.data.attendees || []).map(a => {
      if (a.self) {
        return { ...a, responseStatus: response };
      }
      return a;
    });

    await calendar.events.patch({
      calendarId: calendarId || 'primary',
      eventId: eventId,
      requestBody: { attendees },
      sendUpdates: 'all',
    });

    res.json({ ok: true, response });
  } catch (err) {
    console.error('Calendar respond error:', err.message);
    res.json({ error: err.message });
  }
});

// --- Team OOO (from OOO calendar) ---
app.get('/api/calendar/team-ooo', async (req, res) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID) return res.json({ error: 'No Google credentials configured' });
    const oooCalId = process.env.OOO_CALENDAR_ID;
    if (!oooCalId) return res.json({ error: 'No OOO calendar configured' });

    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: 'v3', auth });

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfYear = new Date(now.getFullYear(), 11, 31, 23, 59, 59); // through end of year

    const resp = await calendar.events.list({
      calendarId: oooCalId,
      timeMin: startOfDay.toISOString(),
      timeMax: endOfYear.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    });

    const rawList = (resp.data.items || []).map(e => {
      // Clean name: remove pipeline suffixes like ":: All Managers > hidden > OOO Pipeline"
      let name = e.summary || 'Unknown';
      name = name.replace(/\s*::.*$/, '').replace(/^🔄\s*/, '').trim();
      // Extract just the person's name from patterns like "Name OOO"
      name = name.replace(/\s+OOO$/i, '').trim();
      return {
        name,
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
        isAllDay: !e.start?.dateTime,
      };
    });

    // Deduplicate: same name + same start + same end = duplicate
    const seen = new Set();
    const oooList = rawList.filter(o => {
      const key = `${o.name}|${o.start}|${o.end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    res.json({ ooo: oooList });
  } catch (err) {
    console.error('Team OOO error:', err.message);
    res.json({ error: err.message });
  }
});

// --- Gmail Inbox Preview ---
app.get('/api/gmail/inbox', async (req, res) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID) return res.json({ error: 'No Google credentials configured' });
    const auth = getGoogleAuth();
    const gmail = google.gmail({ version: 'v1', auth });

    const listResp = await gmail.users.messages.list({
      userId: 'me',
      labelIds: ['INBOX', 'UNREAD'],
      maxResults: 15,
    });

    const messages = [];
    for (const msg of (listResp.data.messages || [])) {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });
      const headers = detail.data.payload?.headers || [];
      const getHeader = (name) => headers.find(h => h.name === name)?.value || '';
      messages.push({
        id: msg.id,
        threadId: detail.data.threadId,
        snippet: detail.data.snippet,
        from: getHeader('From'),
        subject: getHeader('Subject'),
        date: getHeader('Date'),
        unread: (detail.data.labelIds || []).includes('UNREAD'),
      });
    }
    res.json({ messages });
  } catch (err) {
    console.error('Gmail inbox error:', err.message);
    res.json({ error: err.message });
  }
});

// --- Gmail Priority Emails (important + unread) ---
app.get('/api/gmail/followups', async (req, res) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID) return res.json({ error: 'No Google credentials configured' });
    const auth = getGoogleAuth();
    const gmail = google.gmail({ version: 'v1', auth });

    const listResp = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:important is:unread',
      maxResults: 15,
    });

    const messages = [];
    for (const msg of (listResp.data.messages || [])) {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });
      const headers = detail.data.payload?.headers || [];
      const getHeader = (name) => headers.find(h => h.name === name)?.value || '';
      messages.push({
        id: msg.id,
        threadId: detail.data.threadId,
        snippet: detail.data.snippet,
        from: getHeader('From'),
        subject: getHeader('Subject'),
        date: getHeader('Date'),
      });
    }
    res.json({ messages, count: messages.length });
  } catch (err) {
    console.error('Gmail followups error:', err.message);
    res.json({ error: err.message });
  }
});

// --- Slack Mentions ---
app.get('/api/slack/mentions', async (req, res) => {
  try {
    const xoxcToken = process.env.SLACK_XOXC_TOKEN;
    const dCookie = process.env.SLACK_D_COOKIE;
    if (!xoxcToken || !dCookie) return res.json({ error: 'No Slack xoxc token or d cookie configured' });

    // Search for recent mentions
    const resp = await fetch('https://app.slack.com/api/search.messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': `d=${dCookie}`,
      },
      body: `token=${encodeURIComponent(xoxcToken)}&query=${encodeURIComponent('to:me')}&count=15&sort=timestamp&sort_dir=desc`,
    });
    const data = await resp.json();
    if (!data.ok) {
      return res.json({ error: data.error || 'Slack search API error' });
    }

    const mentions = (data.messages?.matches || []).map(m => ({
      text: (m.text || '').substring(0, 200),
      channel: m.channel?.name || 'DM',
      username: m.username || m.user || 'unknown',
      ts: m.ts,
      permalink: m.permalink,
    }));
    res.json({ mentions, total: data.messages?.total || 0 });
  } catch (err) {
    console.error('Slack mentions error:', err.message);
    res.json({ error: err.message });
  }
});

// --- RSS News Feed ---
app.get('/api/news', async (req, res) => {
  try {
    const feedUrl = process.env.NEWS_RSS_URL || 'https://www.gamesindustry.biz/feed';
    const resp = await fetch(feedUrl);
    const xml = await resp.text();

    // Simple XML parsing for RSS items
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && items.length < 20) {
      const itemXml = match[1];
      const get = (tag) => {
        const m = itemXml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
        return m ? (m[1] || m[2] || '').trim() : '';
      };
      items.push({
        title: get('title'),
        link: get('link'),
        description: get('description').replace(/<[^>]+>/g, '').substring(0, 200),
        pubDate: get('pubDate'),
      });
    }
    res.json({ items });
  } catch (err) {
    console.error('News RSS error:', err.message);
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
