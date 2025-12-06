// guildStorage.js
// Simple JSON-based storage for per-guild config (admin roles, features, etc.)

const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, 'guildConfig.json');

// Ensure the store file exists
function ensureStoreFile() {
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, JSON.stringify({}, null, 2), 'utf8');
  }
}

// Read full store: { [guildId]: { guildId, adminRoleIds, features, ... } }
function readStore() {
  ensureStoreFile();
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (err) {
    console.error('[guildStorage] Failed to read store, resetting:', err);
    return {};
  }
}

// Write full store
function writeStore(store) {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
  } catch (err) {
    console.error('[guildStorage] Failed to write store:', err);
  }
}

// Default features for a new guild
function defaultFeatures() {
  return {
    applications: true,
    tickets: true,
    reports: true,
    clock: true,
    requests: true,
    autoPanels: true,
  };
}

/**
 * Return a map of all guild configs.
 * Shape: { [guildId]: { guildId, adminRoleIds, features, ... } }
 */
function loadGuildConfigs() {
  const store = readStore();
  // Ensure all have default features set
  let modified = false;
  for (const [gid, cfg] of Object.entries(store)) {
    if (!cfg.features) {
      cfg.features = defaultFeatures();
      modified = true;
    } else {
      // Backfill any missing keys if we add new features later
      const d = defaultFeatures();
      for (const key of Object.keys(d)) {
        if (typeof cfg.features[key] === 'undefined') {
          cfg.features[key] = d[key];
          modified = true;
        }
      }
    }
  }
  if (modified) writeStore(store);
  return store;
}

/**
 * Get config for a single guild, with sensible defaults.
 */
function getGuildConfig(guildId) {
  const store = loadGuildConfigs();
  if (!store[guildId]) {
    store[guildId] = {
      guildId,
      adminRoleIds: [],
      features: defaultFeatures(),
    };
    writeStore(store);
  }
  return store[guildId];
}

/**
 * Sometimes we just want to ensure it exists.
 */
function getOrCreateGuildConfig(guildId) {
  return getGuildConfig(guildId);
}

/**
 * Save a full config object for a guild.
 */
function saveGuildConfig(config) {
  if (!config || !config.guildId) return;
  const store = loadGuildConfigs();
  const existing = store[config.guildId] || { guildId: config.guildId };

  // Merge shallow
  store[config.guildId] = {
    ...existing,
    ...config,
    features: {
      ...(existing.features || defaultFeatures()),
      ...(config.features || {}),
    },
  };
  writeStore(store);
}

/**
 * Set / replace admin role IDs for a guild.
 */
function setGuildAdminRoles(guildId, roleIds) {
  const store = loadGuildConfigs();
  const existing = store[guildId] || { guildId, features: defaultFeatures() };
  const uniqueIds = Array.from(new Set(roleIds || []));
  existing.adminRoleIds = uniqueIds;
  store[guildId] = existing;
  writeStore(store);
  return existing;
}

/**
 * Get features for a guild (with defaults).
 */
function getGuildFeatures(guildId) {
  const cfg = getGuildConfig(guildId);
  return cfg.features || defaultFeatures();
}

/**
 * Update features for a guild.
 */
function setGuildFeatures(guildId, featuresUpdate) {
  const store = loadGuildConfigs();
  const existing = store[guildId] || { guildId, features: defaultFeatures(), adminRoleIds: [] };
  const base = existing.features || defaultFeatures();
  existing.features = {
    ...base,
    ...featuresUpdate,
  };
  store[guildId] = existing;
  writeStore(store);
  return existing.features;
}

module.exports = {
  loadGuildConfigs,
  getGuildConfig,
  getOrCreateGuildConfig,
  saveGuildConfig,
  setGuildAdminRoles,
  getGuildFeatures,
  setGuildFeatures,
};
