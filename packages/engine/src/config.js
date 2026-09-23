const fs = require('fs');
const path = require('path');

const CONFIG_DIR = require('./paths').configPath('clients');
const DEFAULT_PATH = path.join(CONFIG_DIR, '_default.json');

function loadDefault() {
  return JSON.parse(fs.readFileSync(DEFAULT_PATH, 'utf-8'));
}

function loadClient(clientSlug) {
  const base = loadDefault();
  if (!clientSlug || clientSlug === '_default') return base;

  const clientPath = path.join(CONFIG_DIR, `${clientSlug}.json`);
  if (!fs.existsSync(clientPath)) {
    console.warn(`[config] no override file for client="${clientSlug}", using _default.json`);
    return base;
  }

  const override = JSON.parse(fs.readFileSync(clientPath, 'utf-8'));
  return { ...base, ...override };
}

module.exports = { loadDefault, loadClient };
