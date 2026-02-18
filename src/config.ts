import 'dotenv/config';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function optional(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

function optionalBoolean(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true';
}

export interface SenderCategory {
  key: string;
  label: string;
  senders: string[];
}

export const SENDER_CATEGORIES: SenderCategory[] = [
  {
    key: 'support',
    label: 'Support / Move-In / Move-Out / Rating',
    senders: ['support@padsplit.com'],
  },
  {
    key: 'maintenance',
    label: 'Maintenance',
    senders: ['maintenance@padsplit.com', 'maint@padsplit.com'],
  },
  {
    key: 'no_reply_info',
    label: 'No Reply / Info',
    senders: ['no-reply@padsplit.com', 'info@padsplit.com'],
  },
  {
    key: 'member_messages',
    label: 'Member Messages',
    senders: ['messenger@padsplit.com'],
  },
  {
    key: 'others',
    label: 'Others',
    senders: [],
  },
];

// Ensure data directory exists
const dbPath = optional('DB_PATH', './data/padsplit-digest.sqlite');
const dbDir = dirname(dbPath);
if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true });
}

export const config = {
  gmail: {
    clientId: optional('GMAIL_CLIENT_ID', ''),
    clientSecret: optional('GMAIL_CLIENT_SECRET', ''),
    refreshToken: optional('GMAIL_REFRESH_TOKEN', ''),
    digestRecipient: optional('DIGEST_RECIPIENT', ''),
    senderLookbackDays: optional('GMAIL_SENDER_LOOKBACK_DAYS', '1'),
  },
  openai: {
    apiKey: optional('OPENAI_API_KEY', ''),
    model: 'gpt-4o-mini',
  },
  senderCategories: SENDER_CATEGORIES,
  padsplit: {
    sessionPath: './data/padsplit-session',
  },
  honeywell: {
    username: optional('HONEYWELL_USERNAME', ''),
    password: optional('HONEYWELL_PASSWORD', ''),
    sessionPath: optional('HONEYWELL_SESSION_PATH', './data/honeywell-session.json'),
  },
  schedule: {
    digestTimes: ['0 12 * * *'],
    timezone: 'America/Chicago',
  },
  db: {
    path: dbPath,
  },
  runtime: {
    enableEmailSending: optionalBoolean('ENABLE_EMAIL_SENDING', false),
  },
};

// Validate required config for production
export function validateConfig(): string[] {
  const warnings: string[] = [];

  if (!config.gmail.clientId) warnings.push('GMAIL_CLIENT_ID is not set');
  if (!config.gmail.clientSecret) warnings.push('GMAIL_CLIENT_SECRET is not set');
  if (!config.gmail.refreshToken) warnings.push('GMAIL_REFRESH_TOKEN is not set');
  if (!config.gmail.digestRecipient) warnings.push('DIGEST_RECIPIENT is not set');
  if (!config.openai.apiKey) warnings.push('OPENAI_API_KEY is not set (LLM fallback disabled)');

  return warnings;
}
