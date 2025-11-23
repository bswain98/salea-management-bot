// storage.js
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'db.json');

function loadDb() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      return { applications: [], tickets: [], sessions: [] };
    }
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const data = JSON.parse(raw);
    // sanity defaults
    return {
      applications: Array.isArray(data.applications) ? data.applications : [],
      tickets: Array.isArray(data.tickets) ? data.tickets : [],
      sessions: Array.isArray(data.sessions) ? data.sessions : []
    };
  } catch (err) {
    console.error('Error loading db.json:', err);
    return { applications: [], tickets: [], sessions: [] };
  }
}

function saveDb(db) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving db.json:', err);
  }
}

// ---------- APPLICATIONS ----------
function addApplication(app) {
  const db = loadDb();
  db.applications.push(app);
  saveDb(db);
  return app;
}

function getLatestApplicationForUser(userId) {
  const db = loadDb();
  const apps = db.applications.filter(a => a.userId === userId);
  if (apps.length === 0) return null;
  // latest by createdAt
  return apps.reduce((latest, app) =>
    !latest || app.createdAt > latest.createdAt ? app : latest
  , null);
}

function updateApplicationStatus(id, status, decidedBy, extra) {
  const db = loadDb();
  const app = db.applications.find(a => a.id === id);
  if (!app) return null;

  app.status = status;
  app.decidedAt = Date.now();
  app.decidedBy = decidedBy;

  if (status === 'approved') {
    app.division = extra;
  } else if (status === 'denied') {
    app.decisionReason = extra;
  }

  saveDb(db);
  return app;
}

// ---------- TICKETS ----------
function addTicket(ticket) {
  const db = loadDb();
  db.tickets.push(ticket);
  saveDb(db);
  return ticket;
}

function closeTicket(channelId) {
  const db = loadDb();
  const ticket = db.tickets.find(
    t => t.channelId === channelId && !t.closedAt
  );
  if (!ticket) return null;
  ticket.closedAt = Date.now();
  saveDb(db);
  return ticket;
}

// ---------- DUTY SESSIONS ----------
// Each session: { id, userId, assignments: [..], clockIn, clockOut }

function getOpenSession(userId) {
  const db = loadDb();
  return db.sessions.find(s => s.userId === userId && !s.clockOut) || null;
}

function getAllOpenSessions() {
  const db = loadDb();
  return db.sessions.filter(s => !s.clockOut);
}

function clockIn(userId, assignments) {
  const db = loadDb();
  const open = db.sessions.find(s => s.userId === userId && !s.clockOut);
  if (open) return null;

  const session = {
    id: `${userId}-${Date.now()}`,
    userId,
    assignments: Array.isArray(assignments) ? assignments : [assignments],
    clockIn: Date.now(),
    clockOut: null
  };

  db.sessions.push(session);
  saveDb(db);
  return session;
}

function clockOut(userId) {
  const db = loadDb();
  const session = db.sessions.find(s => s.userId === userId && !s.clockOut);
  if (!session) return null;
  session.clockOut = Date.now();
  saveDb(db);
  return session;
}

function getSessionsForUserInRange(userId, fromTimestamp) {
  const db = loadDb();
  return db.sessions.filter(
    s =>
      s.userId === userId &&
      s.clockOut &&
      s.clockOut >= fromTimestamp
  );
}

function getSessionsInRange(fromTimestamp, assignmentFilter = null) {
  const db = loadDb();
  return db.sessions.filter(s => {
    if (!s.clockOut || s.clockOut < fromTimestamp) return false;
    if (!assignmentFilter) return true;
    const arr = Array.isArray(s.assignments) ? s.assignments : [];
    return arr.includes(assignmentFilter);
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
