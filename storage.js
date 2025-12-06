// storage.js
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');

let data = {
  guilds: {},     // guildId -> { config }
  tickets: [],    // { id, guildId, channelId, userId, type, status, createdAt, closedAt }
  applications: [], // { id, guildId, userId, type, answers, status, createdAt, decidedAt, decidedBy, roleAddIds, roleRemoveIds }
  sessions: [],   // { id, guildId, userId, clockTypes: [string], clockIn, clockOut }
  globalBans: []  // { userId, reason, bannedBy, createdAt }
};

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      data = JSON.parse(raw);
    }
  } catch (err) {
    console.error('[Storage] Error loading data.json:', err);
  }
}

function save() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('[Storage] Error saving data.json:', err);
  }
}

// --- Guild config helpers ---

function getGuildConfig(guildId) {
  if (!data.guilds[guildId]) {
    data.guilds[guildId] = {
      name: null,

      adminRoleIds: [],

      // Clock system
      clockTypes: [
        // { key: 'patrol', label: 'Patrol', addRoleIds: [], removeRoleIdsOnOut: [] }
      ],
      onDutyRoleId: null,
      clockStatusChannelId: null,

      // Tickets
      ticketTypes: [
        // { key: 'general', label: 'General Support', template: '...', pingRoleIds: [] }
      ],
      ticketPanelChannelId: null,
      ticketPanelMessageId: null,

      // Applications
      applicationTypes: [
        // { key: 'patrol', label: 'Patrol Application', questions: ['q1','q2'], addRoleIds: [], removeRoleIds: [], pingRoleIds: [] }
      ],
      applicationPanelChannelId: null,
      applicationPanelMessageId: null
    };
  }
  return data.guilds[guildId];
}

function updateGuildConfig(guildId, patch) {
  const cfg = getGuildConfig(guildId);
  Object.assign(cfg, patch);
  save();
  return cfg;
}

// --- Tickets ---

function createTicket(ticketData) {
  const ticket = {
    id: `t_${Date.now()}_${Math.floor(Math.random() * 999999)}`,
    status: 'open',
    createdAt: Date.now(),
    closedAt: null,
    ...ticketData
  };
  data.tickets.push(ticket);
  save();
  return ticket;
}

function getTicketByChannel(guildId, channelId) {
  return data.tickets.find(t => t.guildId === guildId && t.channelId === channelId);
}

function closeTicket(ticketId) {
  const t = data.tickets.find(x => x.id === ticketId);
  if (!t) return null;
  t.status = 'closed';
  t.closedAt = Date.now();
  save();
  return t;
}

function listTickets(guildId, filter = {}) {
  return data.tickets.filter(t => t.guildId === guildId).filter(t => {
    if (filter.status && t.status !== filter.status) return false;
    if (filter.type && t.type !== filter.type) return false;
    return true;
  });
}

// --- Applications ---

function createApplication(appData) {
  const app = {
    id: `a_${Date.now()}_${Math.floor(Math.random() * 999999)}`,
    status: 'pending',
    createdAt: Date.now(),
    decidedAt: null,
    decidedBy: null,
    ...appData
  };
  data.applications.push(app);
  save();
  return app;
}

function getApplicationById(id) {
  return data.applications.find(a => a.id === id);
}

function listApplications(guildId, filter = {}) {
  return data.applications.filter(a => a.guildId === guildId).filter(a => {
    if (filter.status && a.status !== filter.status) return false;
    if (filter.type && a.type !== filter.type) return false;
    return true;
  });
}

function decideApplication(id, status, decidedBy) {
  const app = getApplicationById(id);
  if (!app) return null;
  app.status = status;
  app.decidedAt = Date.now();
  app.decidedBy = decidedBy;
  save();
  return app;
}

// --- Duty sessions ---

function clockIn(guildId, userId, clockTypeKeys) {
  // Close any existing open session
  data.sessions.forEach(s => {
    if (s.guildId === guildId && s.userId === userId && !s.clockOut) {
      s.clockOut = Date.now();
    }
  });

  const session = {
    id: `s_${Date.now()}_${Math.floor(Math.random() * 999999)}`,
    guildId,
    userId,
    clockTypes: clockTypeKeys,
    clockIn: Date.now(),
    clockOut: null
  };
  data.sessions.push(session);
  save();
  return session;
}

function clockOut(guildId, userId) {
  const open = data.sessions.find(
    s => s.guildId === guildId && s.userId === userId && !s.clockOut
  );
  if (!open) return null;
  open.clockOut = Date.now();
  save();
  return open;
}

function getOpenSessions(guildId) {
  return data.sessions.filter(s => s.guildId === guildId && !s.clockOut);
}

function getUserSessionsInRange(guildId, userId, fromTs) {
  return data.sessions.filter(
    s =>
      s.guildId === guildId &&
      s.userId === userId &&
      s.clockOut &&
      s.clockOut >= fromTs
  );
}

function getSessionsInRange(guildId, fromTs, clockTypeKey = null) {
  return data.sessions.filter(s => {
    if (s.guildId !== guildId) return false;
    if (!s.clockOut || s.clockOut < fromTs) return false;
    if (clockTypeKey && !s.clockTypes.includes(clockTypeKey)) return false;
    return true;
  });
}

// --- Global bans ---

function addGlobalBan(userId, reason, bannedBy) {
  if (data.globalBans.find(b => b.userId === userId)) return;
  data.globalBans.push({
    userId,
    reason: reason || 'No reason provided',
    bannedBy,
    createdAt: Date.now()
  });
  save();
}

function removeGlobalBan(userId) {
  data.globalBans = data.globalBans.filter(b => b.userId !== userId);
  save();
}

function isGloballyBanned(userId) {
  return !!data.globalBans.find(b => b.userId === userId);
}

function listGlobalBans() {
  return data.globalBans;
}

// --- Init ---
load();

module.exports = {
  getGuildConfig,
  updateGuildConfig,
  createTicket,
  getTicketByChannel,
  closeTicket,
  listTickets,
  createApplication,
  getApplicationById,
  listApplications,
  decideApplication,
  clockIn,
  clockOut,
  getOpenSessions,
  getUserSessionsInRange,
  getSessionsInRange,
  addGlobalBan,
  removeGlobalBan,
  isGloballyBanned,
  listGlobalBans
};
