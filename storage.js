// storage.js
// Simple JSON-based storage for applications, tickets, and duty sessions.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'db.json');

function ensureDB() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = {
      applications: [],
      tickets: [],
      sessions: []
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2), 'utf8');
  }
}

function readDB() {
  ensureDB();
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return { applications: [], tickets: [], sessions: [] };
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

module.exports = {
  addApplication,
  updateApplicationStatus,
  getLatestApplicationForUser,
  addTicket,
  closeTicket,
  clockIn,
  clockOut,
  getOpenSession,
  getAllOpenSessions,
  getSessionsForUserInRange,
  getSessionsInRange
};
