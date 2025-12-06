// storage.js
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');

// Base/default shape for our data store
const defaultData = {
  guilds: {},     // guildId -> { config }
  tickets: [],    // { id, guildId, channelId, userId, type, status, createdAt, closedAt }
  applications: [], // { id, guildId, userId, type, answers, status, createdAt, decidedAt, decidedBy, roleAddIds, roleRemoveIds }
  sessions: [],   // { id, guildId, userId, clockTypes: [string], clockIn, clockOut }
  globalBans: []  // { userId, reason, bannedBy, createdAt }
};

let data = JSON.parse(JSON.stringify(defaultData));

/**
 * Ensure data has the correct top-level shape,
 * even if an old/bad data.json was loaded.
 */
function ensureShape() {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    data = JSON.parse(JSON.stringify(defaultData));
    return;
  }

  // Ensure each key exists with correct type
  if (!data.guilds || typeof data.guilds !== 'object' || Array.isArray(data.guilds)) {
    data.guilds = {};
  }

  if (!Array.isArray(data.tickets)) {
    data.tickets = [];
  }

  if (!Array.isArray(data.applications)) {
    data.applications = [];
  }

  if (!Array.isArray(data.sessions)) {
    data.sessions = [];
  }

  if (!Array.isArray(data.globalBans)) {
    data.globalBans = [];
  }
}

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      if (raw && raw.trim().length > 0) {
        data = JSON.parse(raw);
      } else {
        data = JSON.parse(JSON.stringify(defaultData));
      }
    } else {
      data = JSON.parse(JSON.stringify(defaultData));
    }
  } catch (err) {
    console.error('[Storage] Error loading data.json, using defaults:', err);
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

// --- Guild config helpers ---

function getGuildConfig(guildId) {
  ensureShape();

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
        // { key: 'patrol', label: 'Patrol Application', questions: [], addRoleIds: [], removeRoleIds: [], pingRoleIds: [] }
      ],
      applicationPanelChannelId: null,
      applicationPanelMessageId: null
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

// --- Tickets ---

function createTicket(ticketData) {
  ensureShape();
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
  ensureShape();
  return data.tickets.find(t => t.guildId === guildId && t.channelId === channelId);
}

function getTicketById(id) {
  ensureShape();
  return data.tickets.find(t => t.id === id);
}

function closeTicket(ticketId) {
  ensureShape();
  const t = data.tickets.find(x => x.id === ticketId);
  if (!t) return null;
  t.status = 'closed';
  t.closedAt = Date.now();
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

// --- Applications ---

function createApplication(appData) {
  ensureShape();
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
  ensureShape();
  return data.applications.find(a => a.id === id);
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

// --- Duty sessions ---

function clockIn(guildId, userId, clockTypeKeys) {
  ensureShape();
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
    if (clockTypeKey && !s.clockTypes.includes(clockTypeKey)) return false;
    return true;
  });
}

// --- Global bans ---

function addGlobalBan(userId, reason, bannedBy) {
  ensureShape();
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
  ensureShape();
  data.globalBans = data.globalBans.filter(b => b.userId !== userId);
  save();
}

function isGloballyBanned(userId) {
  ensureShape();
  return !!data.globalBans.find(b => b.userId === userId);
}

function listGlobalBans() {
  ensureShape();
  return data.globalBans;
}

// --- Init ---
load();

module.exports = {
  getGuildConfig,
  updateGuildConfig,
  createTicket,
  getTicketByChannel,
  getTicketById,
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
