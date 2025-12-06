// guildStorage.js
const fs = require('fs');
const path = require('path');

const FILE_PATH = path.join(__dirname, 'guildConfig.json');

let state = { guilds: {} };

// Load config from disk (if present)
function load() {
  try {
    if (fs.existsSync(FILE_PATH)) {
      const raw = fs.readFileSync(FILE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        state = parsed;
      }
    }
  } catch (err) {
    console.error('[guildStorage] Failed to load guildConfig.json:', err);
  }

  if (!state.guilds) state.guilds = {};
}

// Save config to disk
function save() {
  try {
    fs.writeFileSync(FILE_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error('[guildStorage] Failed to save guildConfig.json:', err);
  }
}

// Get config for a single guild
function getGuildConfig(guildId) {
  if (!state.guilds[guildId]) {
    state.guilds[guildId] = {
      name: null,
      adminRoleIds: []
    };
    save();
  }
  return state.guilds[guildId];
}

// Set admin roles for a guild
function setGuildAdminRoles(guildId, roleIds = [], guildName = null) {
  if (!state.guilds[guildId]) {
    state.guilds[guildId] = { name: null, adminRoleIds: [] };
  }
  state.guilds[guildId].adminRoleIds = Array.from(new Set(roleIds));
  if (guildName) {
    state.guilds[guildId].name = guildName;
  }
  save();
  return state.guilds[guildId];
}

// Return the whole thing (if needed later)
function getAllGuildConfigs() {
  return state.guilds;
}

load();

module.exports = {
  getGuildConfig,
  setGuildAdminRoles,
  getAllGuildConfigs
};
