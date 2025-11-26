// storage.js
// JSON-based storage for applications, tickets, duty sessions,
// reports, role requests, roster requests, and dynamic settings.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'db.json');

function ensureDB() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = {
      applications: [],
      tickets: [],
      sessions: [],
      reports: [],
      roleRequests: [],
      rosterRequests: [],
      settings: {
        panels: {
          appPanelChannelId: null,
          ticketPanelChannelId: null,
          reportPanelChannelId: null,
          requestPanelChannelId: null
        },
        logs: {
          applicationsLogChannelId: null,
          ticketTranscriptChannelId: null,
          reports: {
            citationLogChannelId: null,
            arrestLogChannelId: null,
            uofLogChannelId: null,
            reaperAARChannelId: null,
            cidIncidentLogChannelId: null,
            cidCaseReportChannelId: null,
            tuShiftReportChannelId: null
          },
          requestsLogChannelId: null
        },
        pings: {
          applicationPingRoles: [],
          ticketPingRoles: [],
          reportPingRoles: [],
          requestPingRoles: []
        },
        adminRoleIds: []
      }
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2), 'utf8');
  }
}

function readDB() {
  ensureDB();
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  try {
    const parsed = JSON.parse(raw);

    // Backfill if old DB layout
    if (!parsed.settings) {
      parsed.settings = {
        panels: {
          appPanelChannelId: null,
          ticketPanelChannelId: null,
          reportPanelChannelId: null,
          requestPanelChannelId: null
        },
        logs: {
          applicationsLogChannelId: null,
          ticketTranscriptChannelId: null,
          reports: {
            citationLogChannelId: null,
            arrestLogChannelId: null,
            uofLogChannelId: null,
            reaperAARChannelId: null,
            cidIncidentLogChannelId: null,
            cidCaseReportChannelId: null,
            tuShiftReportChannelId: null
          },
          requestsLogChannelId: null
        },
        pings: {
          applicationPingRoles: [],
          ticketPingRoles: [],
          reportPingRoles: [],
          requestPingRoles: []
        },
        adminRoleIds: []
      };
    }
    if (!parsed.reports) parsed.reports = [];
    if (!parsed.roleRequests) parsed.roleRequests = [];
    if (!parsed.rosterRequests) parsed.rosterRequests = [];

    return parsed;
  } catch {
    return {
      applications: [],
      tickets: [],
      sessions: [],
      reports: [],
      roleRequests: [],
      rosterRequests: [],
      settings: {
        panels: {
          appPanelChannelId: null,
          ticketPanelChannelId: null,
          reportPanelChannelId: null,
          requestPanelChannelId: null
        },
        logs: {
          applicationsLogChannelId: null,
          ticketTranscriptChannelId: null,
          reports: {
            citationLogChannelId: null,
            arrestLogChannelId: null,
            uofLogChannelId: null,
            reaperAARChannelId: null,
            cidIncidentLogChannelId: null,
            cidCaseReportChannelId: null,
            tuShiftReportChannelId: null
          },
          requestsLogChannelId: null
        },
        pings: {
          applicationPingRoles: [],
          ticketPingRoles: [],
          reportPingRoles: [],
          requestPingRoles: []
        },
        adminRoleIds: []
      }
    };
  }
}

function writeDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

// -------------------- Applications --------------------

function addApplication(app) {
  const db = readDB();
  db.applications.push(app);
  writeDB(db);
  return app;
}

function getLatestApplicationForUser(userId) {
  const db = readDB();
  const apps = db.applications.filter(a => a.userId === userId);
  if (apps.length === 0) return null;
  return apps[apps.length - 1];
}

function updateApplicationStatus(id, status, decidedBy, reasonOrDivision) {
  const db = readDB();
  const idx = db.applications.findIndex(a => a.id === id);
  if (idx === -1) return null;

  const app = db.applications[idx];
  app.status = status;
  app.decidedAt = Date.now();
  app.decidedBy = decidedBy;
  app.decisionReason = reasonOrDivision;
  db.applications[idx] = app;

  writeDB(db);
  return app;
}

// -------------------- Tickets --------------------

function addTicket(ticket) {
  const db = readDB();
  db.tickets.push(ticket);
  writeDB(db);
  return ticket;
}

function closeTicket(channelId) {
  const db = readDB();
  const idx = db.tickets.findIndex(t => t.channelId === channelId);
  if (idx === -1) return null;

  const ticket = db.tickets[idx];
  ticket.closedAt = Date.now();
  db.tickets[idx] = ticket;
  writeDB(db);
  return ticket;
}

function listTickets() {
  const db = readDB();
  return db.tickets || [];
}

// -------------------- Duty Sessions --------------------

// clockIn: allow single assignment or array of assignments
function clockIn(userId, assignmentOrAssignments) {
  const db = readDB();

  const existing = db.sessions.find(s => s.userId === userId && !s.clockOut);
  if (existing) return null;

  let assignments = [];
  if (Array.isArray(assignmentOrAssignments)) {
    assignments = assignmentOrAssignments;
  } else if (typeof assignmentOrAssignments === 'string') {
    assignments = [assignmentOrAssignments];
  }

  const session = {
    id: `${userId}-${Date.now()}`,
    userId,
    assignments,
    clockIn: Date.now(),
    clockOut: null
  };

  db.sessions.push(session);
  writeDB(db);
  return session;
}

function clockOut(userId) {
  const db = readDB();
  const idx = db.sessions.findIndex(s => s.userId === userId && !s.clockOut);
  if (idx === -1) return null;

  db.sessions[idx].clockOut = Date.now();
  const session = db.sessions[idx];
  writeDB(db);
  return session;
}

function getOpenSession(userId) {
  const db = readDB();
  return db.sessions.find(s => s.userId === userId && !s.clockOut) || null;
}

function getAllOpenSessions() {
  const db = readDB();
  return db.sessions.filter(s => !s.clockOut);
}

function getSessionsForUserInRange(userId, fromMs) {
  const db = readDB();
  return db.sessions.filter(
    s =>
      s.userId === userId &&
      s.clockOut &&
      s.clockIn >= fromMs &&
      s.clockOut >= s.clockIn
  );
}

// assignmentFilter: null or a specific assignment string (e.g. 'Patrol')
function getSessionsInRange(fromMs, assignmentFilter = null) {
  const db = readDB();
  return db.sessions.filter(s => {
    if (!s.clockOut) return false;
    if (s.clockIn < fromMs) return false;
    if (assignmentFilter) {
      const assignments = Array.isArray(s.assignments) ? s.assignments : [];
      if (!assignments.includes(assignmentFilter)) return false;
    }
    return true;
  });
}

// -------------------- Reports --------------------

function addReport(report) {
  const db = readDB();
  db.reports.push(report);
  writeDB(db);
  return report;
}

function listReports() {
  const db = readDB();
  return db.reports || [];
}

// -------------------- Requests --------------------

function addRoleRequest(req) {
  const db = readDB();
  db.roleRequests.push(req);
  writeDB(db);
  return req;
}

function listRoleRequests() {
  const db = readDB();
  return db.roleRequests || [];
}

function addRosterRequest(req) {
  const db = readDB();
  db.rosterRequests.push(req);
  writeDB(db);
  return req;
}

function listRosterRequests() {
  const db = readDB();
  return db.rosterRequests || [];
}

// -------------------- Settings --------------------

function getSettings() {
  const db = readDB();
  return db.settings || {};
}

function saveSettings(newSettings) {
  const db = readDB();
  db.settings = {
    ...db.settings,
    ...newSettings,
    panels: {
      ...(db.settings.panels || {}),
      ...(newSettings.panels || {})
    },
    logs: {
      ...(db.settings.logs || {}),
      ...(newSettings.logs || {}),
      reports: {
        ...((db.settings.logs || {}).reports || {}),
        ...(((newSettings.logs || {}).reports) || {})
      }
    },
    pings: {
      ...(db.settings.pings || {}),
      ...(newSettings.pings || {})
    },
    adminRoleIds: newSettings.adminRoleIds || db.settings.adminRoleIds || []
  };
  writeDB(db);
  return db.settings;
}

module.exports = {
  addApplication,
  updateApplicationStatus,
  getLatestApplicationForUser,

  addTicket,
  closeTicket,
  listTickets,

  clockIn,
  clockOut,
  getOpenSession,
  getAllOpenSessions,
  getSessionsForUserInRange,
  getSessionsInRange,

  addReport,
  listReports,

  addRoleRequest,
  listRoleRequests,
  addRosterRequest,
  listRosterRequests,

  getSettings,
  saveSettings
};
