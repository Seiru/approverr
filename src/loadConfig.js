import yaml from 'js-yaml';
import fs from 'fs';

// config/config.yml is deliberately untracked: a real one holds an Overseerr API key and this repo is
// public. config/config.example.yml is the tracked shape to copy. Notification settings are not in this
// file at all — the gateway URL and token are environment variables (see src/notify.js).
const CONFIG_PATH = 'config/config.yml';

export default function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`${CONFIG_PATH} not found. Copy config/config.example.yml to it and fill it in.`);
  }

  const config = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));

  if (!config.overseerr) {
    throw new Error('Missing Overseerr configuration');
  } else if (!config.overseerr.url) {
    throw new Error('Missing Overseerr URL');
  } else if (!config.overseerr.apiKey) {
    throw new Error('Missing Overseerr API key');
  }

  if (!config.rules || !Array.isArray(config.rules)) {
    throw new Error('Missing rules configuration');
  } else {
    config.rules.forEach((rule) => {
      if (!rule.name) {
        throw new Error('Missing rule name');
      } else if (!rule.type) {
        throw new Error('Missing rule type');
      } else if (rule.type !== 'movie' && rule.type !== 'tv') {
        throw new Error('Invalid rule type, rule must be either movie or tv');
      } else if (!rule.actions || !rule.actions.rootFolder) {
        throw new Error('Actions are required for each rule');
      } else if (!rule.keywords && !rule.strings && !rule.regex) {
        throw new Error('Keywords, strings, or regex are required for each rule');
      }
    });
  }

  return config;
}
