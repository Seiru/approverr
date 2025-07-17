import yaml from 'js-yaml';
import fs from 'fs';

export default function loadConfig() {
  const config = yaml.load(fs.readFileSync('config/config.yml', 'utf8'));

  if (!config.overseerr) {
    throw new Error('Missing Overseerr configuration');
  } else if (!config.overseerr.url) {
    throw new Error('Missing Overseerr URL');
  } else if (!config.overseerr.apiKey) {
    throw new Error('Missing Overseerr API key');
  }

  if (config.ntfy && config.ntfy.enabled && !config.ntfy.topic) {
    throw new Error('ntfy topic is required when ntfy notifications are enabled');
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
