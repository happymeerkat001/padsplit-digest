// Purpose: categorizes messages based on sender names (control), call in config by resolveSenderCategory function, used for categorizing messages in the digest based on sender patterns, and provides main configuration settings for the application, including API keys, URLs, scheduling, and database configuration, with a function to validate critical configuration at startup to ensure necessary settings are in place for proper functionality using dependencies like dotenv for environment variable management and node:fs and node:path for file system operations related to database setup.

import 'dotenv/config'; // Run On-  process.env 
import { existsSync, mkdirSync } from 'node:fs'; // Run On - node: infrastructure 
import { dirname } from 'node:path'; // Run On - node: infrastructure

function optional(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

export interface SenderCategory { // know as- Durable 
  key: string;
  label: string;
  senders: string[];
}

export const SENDER_CATEGORIES: SenderCategory[] = [ // call in- named const, module
  {
    key: 'support',
    label: 'Support',
    senders: ['padsplit support', 'support'],
  },
  {
    key: 'maintenance',
    label: 'Maintenance',
    senders: ['maintenance'],
  },
  {
    key: 'tasks',
    label: 'Tasks',
    senders: ['task'],
  },
  {
    key: 'member_messages',
    label: 'Member Messages',
    senders: [],
  },
  {
    key: 'others',
    label: 'Others',
    senders: [],
  },
];

export function resolveSenderCategory(senderName: string): string { // run for-Domain logic. control- categorizes sender name into predefined categories based on patterns, with a default categorization for member messages and others, used to classify messages in the digest based on who sent them, enabling better organization and filtering of messages for the end-users.
  const normalized = senderName.toLowerCase().trim(); // stack- memread- normalize sender name for matching - control

  for (const category of SENDER_CATEGORIES) {
    if (category.key === 'member_messages' || category.key === 'others') {
      continue;
    }

    if (category.senders.some((pattern) => normalized.includes(pattern))) {
      return category.key; // return-control (string as data)
    }
  }

  if (normalized.length > 0) {
    return 'member_messages';
  }

  return 'others'; // Return-Control (guard/default)
}

const dbPath = optional('DB_PATH', './data/padsplit-digest.sqlite'); // config- database file path, defaulting to ./data/padsplit-digest.sqlite, can be overridden with DB_PATH environment variable, used for storing classified items and other data related to the digest
const dbDir = dirname(dbPath); // derived directory from dbPath, used to ensure the directory exists before trying to create the database file, preventing errors when the application starts and tries to access the database
if (!existsSync(dbDir)) {  //crosses to disk to check if the directory for the database file exists
  mkdirSync(dbDir, { recursive: true }); // memwrite- sustain - creates directory so environment is in valid state to run
}

export const config = { // call in config, main configuration object for the application, containing settings for OpenAI API, sender categories, PadSplit API, Honeywell integration, scheduling, digest parameters, and database configuration, all of which can be customized through environment variables or default values. durable memory for configuration settings that are used across the application, ensuring consistent access to critical parameters and enabling easy updates through environment variables without changing the codebase.
  openai: {
    apiKey: optional('OPENAI_API_KEY', ''),
    model: 'gpt-4o-mini',
  },
  senderCategories: SENDER_CATEGORIES,
  padsplit: {
    cookie: optional('PADSPLIT_COOKIE', ''),
    communicationUrl: optional('PADSPLIT_COMMUNICATION_URL', 'https://www.padsplit.com/host/communication'),
    tasksUrl: optional('PADSPLIT_TASKS_URL', 'https://www.padsplit.com/host/tasks'),
sessionPath: optional('PADSPLIT_SESSION_PATH', '/root/padsplit-digest/data/padsplit-state.json'),  honeywell: {
    username: optional('HONEYWELL_USERNAME', ''),
    password: optional('HONEYWELL_PASSWORD', ''),
    sessionPath: optional('HONEYWELL_SESSION_PATH', './data/honeywell-session.json'),
  },
  schedule: {
    digestTimes: ['*/30 * * * *'],
    timezone: optional('TZ', 'America/Chicago'),
  },
  digest: {
    visibilityWindowHours: Number.parseInt(optional('DIGEST_VISIBILITY_WINDOW_HOURS', '48'), 10),
    deployIntervalMinutes: Number.parseInt(optional('DEPLOY_INTERVAL_MINUTES', '30'), 10),
    taskStatuses: optional('DIGEST_TASK_STATUSES', '')
      .split(',')
      .map((status) => status.trim())
      .filter(Boolean),
    groups: optional('DIGEST_GROUPS', '')
      .split(',')
      .map((groupKey) => groupKey.trim())
      .filter(Boolean),
  },
  db: {
    path: dbPath,
  },
};

export function validateConfig(): string[] { // run for- no input, Out- string array. Control-returns warnings to caller 
  const warnings: string[] = [];

  if (!config.padsplit.cookie && !existsSync(config.padsplit.sessionPath)) {
    warnings.push('PADSPLIT_COOKIE is not set and no browser session found (PadSplit API ingestion disabled)');
  }

  if (!config.openai.apiKey) {
    warnings.push('OPENAI_API_KEY is not set (LLM fallback disabled)');
  }

  return warnings; 
}
