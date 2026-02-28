import 'dotenv/config';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function optional(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

export interface SenderCategory {
  key: string;
  label: string;
  senders: string[];
}

export const SENDER_CATEGORIES: SenderCategory[] = [
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

export function resolveSenderCategory(senderName: string): string {
  const normalized = senderName.toLowerCase().trim();

  for (const category of SENDER_CATEGORIES) {
    if (category.key === 'member_messages' || category.key === 'others') {
      continue;
    }

    if (category.senders.some((pattern) => normalized.includes(pattern))) {
      return category.key;
    }
  }

  if (normalized.length > 0) {
    return 'member_messages';
  }

  return 'others';
}

const dbPath = optional('DB_PATH', './data/padsplit-digest.sqlite');
const dbDir = dirname(dbPath);
if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true });
}

export const config = {
  openai: {
    apiKey: optional('OPENAI_API_KEY', ''),
    model: 'gpt-4o-mini',
  },
  senderCategories: SENDER_CATEGORIES,
  padsplit: {
    cookie: optional('PADSPLIT_COOKIE', ''),
    communicationUrl: optional('PADSPLIT_COMMUNICATION_URL', 'https://www.padsplit.com/host/communication'),
    tasksUrl: optional('PADSPLIT_TASKS_URL', 'https://www.padsplit.com/host/tasks'),
  },
  honeywell: {
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

export function validateConfig(): string[] {
  const warnings: string[] = [];

  if (!config.padsplit.cookie) {
    warnings.push('PADSPLIT_COOKIE is not set (PadSplit API ingestion disabled)');
  }

  if (!config.openai.apiKey) {
    warnings.push('OPENAI_API_KEY is not set (LLM fallback disabled)');
  }

  return warnings;
}
