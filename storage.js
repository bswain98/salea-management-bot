// storage.js
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');

const defaultData = {
  guilds: {},        // guildId -> config
  tickets: [],       // ticket records
  applications: [],  // application records
  sessions: [],      // clock/in duty sessions
};

let data = JSON.parse(JSON.stringify(defaultData));

function ensureShape() {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    data = JSON.parse(JSON.stringify(defaultData));
    return;
  }

  if (!data.guilds || typeof data.guilds !== 'object' || Array.isArray(data.guilds)) {
    data.guilds = {};
  }
  if (!Array.isArray(data.tickets)) data.tickets = [];
  if (!Array.isArray(data.applications)) data.applications = [];
  if (!Array.isArray(data.sessions)) data.sessions = [];
}

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      if (raw && raw.trim()) {
        data = JSON.parse(raw);
      } else {
        data = JSON.parse(JSON.stringify(defaultData));
      }
    } else {
      data = JSON.parse(JSON.stringify(defaultData));
    }
  } catch (err) {
    console.error('[Storage] Failed to load data.json, using defaults:', err);
    data = JSON.parse(JSON.stringify(defaultData));
  }

  ensureShape();
}

function save() {
  try {
    ensureShape();
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('[Storage] Error saving data.json:', err);
  }
}

function getGuildConfig(guildId) {
  ensureShape();

  if (!data.guilds[guildId]) {
    data.guilds[guildId] = {
      name: null,

      // who can use the admin panel for this guild
      adminRoleIds: [],

      // clock / duty
      onDutyRoleId: null,
      clockStatusChannelId: null,
      clockTypes: [
        // example:
        // { key: 'patrol', label: 'Patrol', addRoleIds: [], removeRoleIdsOnOut: [] }
      ],

      // tickets
      ticketPanelChannelId: null,
      ticketPanelMessageId: null,
      ticketTypes: [
        // {
        //   key: 'general',
        //   label: 'General Support',
        //   description: 'Help with general questions or issues.',
        //   pingRoleIds: []
        // }
      ],

      // applications
      applicationPanelChannelId: null,
      applicationPanelMessageId: null,
      applicationTypes: [
        // {
        //   key: 'patrol',
        //   label: 'Patrol Application',
        //   questions: [
        //     'In-game name',
        //     'Age (OOC)',
        //     'RP / LEO experience',
        //     'Why do you want to join this division?'
        //   ],
        //   addRoleIds: [],       // on approve
        //   removeRoleIds: [],    // on approve
        //   pingRoleIds: []       // pinged when app is submitted
        // }
      ]
    };
    save();
  }

  return data.guilds[guildId];
}

function updateGuildConfig(guildId, patch) {
  const cfg = getGuildConfig(guildId);
  Object.assign(cfg, patch);
  data.guilds[guildId] = cfg;
  save();
  return cfg;
}

// ------------- Tickets -------------

function createTicket(ticketData) {
  ensureShape();
  const t = {
    id: `t_${Date.now()}_${Math.floor(Math.random() * 999999)}`,
    status: 'open',
    createdAt: Date.now(),
    closedAt: null,
    ...ticketData
  };
  data.tickets.push(t);
  save();
  return t;
}

function listTickets(guildId, filter = {}) {
  ensureShape();
  return data.tickets
    .filter(t => t.guildId === guildId)
    .filter(t => {
      if (filter.status && t.status !== filter.status) return false;
      if (filter.type && t.type !== filter.type) return false;
      return true;
    });
}

function getTicketByChannel(guildId, channelId) {
  ensureShape();
  return data.tickets.find(t => t.guildId === guildId && t.channelId === channelId);
}

function getTicketById(id) {
  ensureShape();
  return data.tickets.find(t => t.id === id);
}

function closeTicketByChannel(guildId, channelId) {
  ensureShape();
  const t = data.tickets.find(x => x.guildId === guildId && x.channelId === channelId && x.status === 'open');
  if (!t) return null;
  t.status = 'closed';
  t.closedAt = Date.now();
  save();
  return t;
}

// ------------- Applications -------------

function createApplication(appData) {
  ensureShape();
  const a = {
    id: `a_${Date.now()}_${Math.floor(Math.random() * 999999)}`,
    status: 'pending',
    createdAt: Date.now(),
    decidedAt: null,
    decidedBy: null,
    ...appData
  };
  data.applications.push(a);
  save();
  return a;
}

function listApplications(guildId, filter = {}) {
  ensureShape();
  return data.applications
    .filter(a => a.guildId === guildId)
    .filter(a => {
      if (filter.status && a.status !== filter.status) return false;
      if (filter.type && a.type !== filter.type) return false;
      return true;
    });
}

function getApplicationById(id) {
  ensureShape();
  return data.applications.find(a => a.id === id);
}

function decideApplication(id, status, decidedBy) {
  ensureShape();
  const app = getApplicationById(id);
  if (!app) return null;
  app.status = status;
  app.decidedAt = Date.now();
  app.decidedBy = decidedBy;
  save();
  return app;
}

// ------------- Duty sessions -------------

function clockIn(guildId, userId, clockTypeKeys) {
  ensureShape();

  // close any existing open sessions for that user in this guild
  data.sessions.forEach(s => {
    if (s.guildId === guildId && s.userId === userId && !s.clockOut) {
      s.clockOut = Date.now();
    }
  });

  const s = {
    id: `s_${Date.now()}_${Math.floor(Math.random() * 999999)}`,
    guildId,
    userId,
    clockTypes: clockTypeKeys,
    clockIn: Date.now(),
    clockOut: null
  };
  data.sessions.push(s);
  save();
  return s;
}

function clockOut(guildId, userId) {
  ensureShape();
  const open = data.sessions.find(
    s => s.guildId === guildId && s.userId === userId && !s.clockOut
  );
  if (!open) return null;
  open.clockOut = Date.now();
  save();
  return open;
}

function getOpenSessions(guildId) {
  ensureShape();
  return data.sessions.filter(s => s.guildId === guildId && !s.clockOut);
}

function getUserSessionsInRange(guildId, userId, fromTs) {
  ensureShape();
  return data.sessions.filter(
    s =>
      s.guildId === guildId &&
      s.userId === userId &&
      s.clockOut &&
      s.clockOut >= fromTs
  );
}

function getSessionsInRange(guildId, fromTs, clockTypeKey = null) {
  ensureShape();
  return data.sessions.filter(s => {
    if (s.guildId !== guildId) return false;
    if (!s.clockOut || s.clockOut < fromTs) return false;
    if (clockTypeKey && !(s.clockTypes || []).includes(clockTypeKey)) return false;
    return true;
  });
}

// --- init ---
load();

module.exports = {
  getGuildConfig,
  updateGuildConfig,
  createTicket,
  listTickets,
  getTicketByChannel,
  getTicketById,
  closeTicketByChannel,
  createApplication,
  listApplications,
  getApplicationById,
  decideApplication,
  clockIn,
  clockOut,
  getOpenSessions,
  getUserSessionsInRange,
  getSessionsInRange
};
