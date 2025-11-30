// storage.js
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');

function load() {
  if (!fs.existsSync(DATA_FILE)) {
    return {
      applications: [],
      tickets: [],
      sessions: [],
      reports: [],
      requests: [],
      stickyPanels: []
    };
  }
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      applications: parsed.applications || [],
      tickets: parsed.tickets || [],
      sessions: parsed.sessions || [],
      reports: parsed.reports || [],
      requests: parsed.requests || [],
      stickyPanels: parsed.stickyPanels || []
    };
  } catch (e) {
    console.error('[Storage] Failed to load data.json:', e);
    return {
      applications: [],
      tickets: [],
      sessions: [],
      reports: [],
      requests: [],
      stickyPanels: []
    };
  }
}

function save(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[Storage] Failed to save data.json:', e);
  }
}

// ----------------- Applications -----------------
function addApplication(app) {
  const data = load();
  data.applications.push(app);
  save(data);
  return app;
}

function getLatestApplicationForUser(userId) {
  const data = load();
  const apps = data.applications.filter(a => a.userId === userId);
  if (apps.length === 0) return null;
  return apps.sort((a, b) => b.createdAt - a.createdAt)[0];
}

function updateApplicationStatus(id, status, decidedBy, reasonOrDivision) {
  const data = load();
  const idx = data.applications.findIndex(a => a.id === id);
  if (idx === -1) return null;
  const app = data.applications[idx];
  app.status = status;
  app.decidedAt = Date.now();
  app.decidedBy = decidedBy;
  app.decisionReason = reasonOrDivision;
  data.applications[idx] = app;
  save(data);
  return app;
}

function getApplications() {
  const data = load();
  return data.applications;
}

function getApplicationById(id) {
  const data = load();
  return data.applications.find(a => a.id === id) || null;
}

// ----------------- Tickets -----------------
function addTicket(ticket) {
  const data = load();
  data.tickets.push({ ...ticket, id: ticket.id || `ticket_${Date.now()}`, done: false });
  save(data);
  return ticket;
}

function closeTicket(channelId) {
  const data = load();
  const idx = data.tickets.findIndex(t => t.channelId === channelId && !t.closedAt);
  if (idx === -1) return null;
  data.tickets[idx].closedAt = Date.now();
  save(data);
  return data.tickets[idx];
}

function getTickets() {
  const data = load();
  return data.tickets;
}

function getTicketById(id) {
  const data = load();
  return data.tickets.find(t => t.id === id) || null;
}

function setTicketDone(id, done) {
  const data = load();
  const idx = data.tickets.findIndex(t => t.id === id);
  if (idx === -1) return null;
  data.tickets[idx].done = !!done;
  save(data);
  return data.tickets[idx];
}

// ----------------- Sessions (clock / activity) -----------------
function getAllOpenSessions() {
  const data = load();
  return data.sessions.filter(s => !s.clockOut);
}

function getOpenSession(userId) {
  const data = load();
  return data.sessions.find(s => s.userId === userId && !s.clockOut) || null;
}

function clockIn(userId, assignmentOrAssignments) {
  const data = load();
  const already = data.sessions.find(s => s.userId === userId && !s.clockOut);
  if (already) return null;
  const session = {
    id: `sess_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
    userId,
    clockIn: Date.now(),
    clockOut: null,
    assignments: Array.isArray(assignmentOrAssignments)
      ? assignmentOrAssignments
      : assignmentOrAssignments
      ? [assignmentOrAssignments]
      : []
  };
  data.sessions.push(session);
  save(data);
  return session;
}

function clockOut(userId) {
  const data = load();
  const idx = data.sessions.findIndex(s => s.userId === userId && !s.clockOut);
  if (idx === -1) return null;
  data.sessions[idx].clockOut = Date.now();
  save(data);
  return data.sessions[idx];
}

function getSessionsForUserInRange(userId, fromTs) {
  const data = load();
  return data.sessions.filter(
    s =>
      s.userId === userId &&
      s.clockOut &&
      s.clockOut >= fromTs
  );
}

function getSessionsInRange(fromTs, assignmentFilter = null) {
  const data = load();
  return data.sessions.filter(s => {
    if (!s.clockOut || s.clockOut < fromTs) return false;
    if (!assignmentFilter) return true;
    const arr = Array.isArray(s.assignments) ? s.assignments : [];
    return arr.includes(assignmentFilter);
  });
}

// ----------------- Reports -----------------
function addReport(report) {
  const data = load();
  const r = {
    ...report,
    id: report.id || `report_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
    done: false
  };
  data.reports.push(r);
  save(data);
  return r;
}

function getReports() {
  const data = load();
  return data.reports;
}

function getReportById(id) {
  const data = load();
  return data.reports.find(r => r.id === id) || null;
}

function setReportDone(id, done) {
  const data = load();
  const idx = data.reports.findIndex(r => r.id === id);
  if (idx === -1) return null;
  data.reports[idx].done = !!done;
  save(data);
  return data.reports[idx];
}

// ----------------- Requests (roster, role) -----------------
function addRequest(request) {
  const data = load();
  const r = {
    ...request,
    id: request.id || `request_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
    done: false
  };
  data.requests.push(r);
  save(data);
  return r;
}

function getRequests() {
  const data = load();
  return data.requests;
}

function getRequestById(id) {
  const data = load();
  return data.requests.find(r => r.id === id) || null;
}

function setRequestDone(id, done) {
  const data = load();
  const idx = data.requests.findIndex(r => r.id === id);
  if (idx === -1) return null;
  data.requests[idx].done = !!done;
  save(data);
  return data.requests[idx];
}

// ----------------- Sticky panels -----------------
function setStickyPanel(channelId, panelType) {
  const data = load();
  const existingIdx = data.stickyPanels.findIndex(sp => sp.channelId === channelId);
  const record = {
    channelId,
    panelType,
    updatedAt: Date.now()
  };
  if (existingIdx === -1) {
    data.stickyPanels.push(record);
  } else {
    data.stickyPanels[existingIdx] = { ...data.stickyPanels[existingIdx], ...record };
  }
  save(data);
  return record;
}

function getStickyPanels() {
  const data = load();
  return data.stickyPanels;
}

function getStickyPanelForChannel(channelId) {
  const data = load();
  return data.stickyPanels.find(sp => sp.channelId === channelId) || null;
}

module.exports = {
  // applications
  addApplication,
  updateApplicationStatus,
  getLatestApplicationForUser,
  getApplications,
  getApplicationById,

  // tickets
  addTicket,
  closeTicket,
  getTickets,
  getTicketById,
  setTicketDone,

  // sessions
  getAllOpenSessions,
  getOpenSession,
  clockIn,
  clockOut,
  getSessionsForUserInRange,
  getSessionsInRange,

  // reports
  addReport,
  getReports,
  getReportById,
  setReportDone,

  // requests
  addRequest,
  getRequests,
  getRequestById,
  setRequestDone,

  // sticky
  setStickyPanel,
  getStickyPanels,
  getStickyPanelForChannel
};
