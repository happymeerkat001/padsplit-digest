import type { gmail_v1 } from 'googleapis';
import { getGmailClient } from './auth.js';
import { config } from '../config.js';
import { getLastReceivedTimestamp } from '../db/items.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

export interface ParsedEmail {
  id: string;
  threadId: string;
  source: string;
  from: string;
  senderEmail: string;
  subject: string;
  body: string;
  links: string[];
  receivedAt: string;
}

function getTrackedSenders(): string[] {
  const senders = config.senderCategories
    .flatMap((category) => category.senders)
    .map((sender) => sender.toLowerCase());

  return [...new Set(senders)];
}

export function buildPadSplitSenderQuery(): string {
  const senderClause = getTrackedSenders().join(' OR ');
  const lastReceived = getLastReceivedTimestamp();

  if (lastReceived) {
    const epochSeconds = Math.floor(new Date(lastReceived).getTime() / 1000);
    return `from:(${senderClause}) after:${epochSeconds}`;
  }

  // First run (empty DB) — use lookback window to bootstrap
  const lookbackDays = Number.parseInt(config.gmail.senderLookbackDays, 10);
  const safeLookbackDays = Number.isFinite(lookbackDays) && lookbackDays > 0 ? lookbackDays : 1;
  return `from:(${senderClause}) newer_than:${safeLookbackDays}d`;
}

export function extractSenderEmail(fromHeader: string): string {
  const bracketMatch = fromHeader.match(/<([^>]+)>/);
  if (bracketMatch?.[1]) {
    return bracketMatch[1].trim().toLowerCase();
  }

  const bareEmailMatch = fromHeader.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return bareEmailMatch?.[0]?.trim().toLowerCase() ?? '';
}

export function resolveSenderCategory(senderEmail: string): string {
  const normalized = senderEmail.toLowerCase();

  for (const category of config.senderCategories) {
    if (category.key === 'others') {
      continue;
    }

    if (category.senders.includes(normalized)) {
      return category.key;
    }
  }

  return 'others';
}

async function fetchMessageIdsWithQuery(query: string, maxResults = 100): Promise<string[]> {
  const gmail = getGmailClient();
  const ids: string[] = [];

  let pageToken: string | undefined;
  do {
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults,
      pageToken,
    });

    const pageIds = (response.data.messages ?? [])
      .map((message) => message.id)
      .filter((id): id is string => Boolean(id));

    ids.push(...pageIds);
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return ids;
}

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf-8');
}

function extractBody(payload: gmail_v1.Schema$MessagePart): string {
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
      if (part.mimeType === 'text/html' && part.body?.data) {
        return stripHtml(decodeBase64Url(part.body.data));
      }
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }

  return '';
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLinks(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"']+/gi;
  const matches = text.match(urlRegex) ?? [];
  return matches.filter((url) => url.includes('padsplit.com'));
}

async function getMessage(messageId: string): Promise<ParsedEmail | null> {
  const gmail = getGmailClient();

  const response = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const message = response.data;
  if (!message.payload) return null;

  const headers = message.payload.headers ?? [];
  const getHeader = (name: string): string =>
    headers.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

  const from = getHeader('from');
  const subject = getHeader('subject');
  const date = getHeader('date');

  const senderEmail = extractSenderEmail(from);
  const source = resolveSenderCategory(senderEmail);

  const body = extractBody(message.payload);
  const links = extractLinks(body);

  return {
    id: messageId,
    threadId: message.threadId ?? messageId,
    source,
    from,
    senderEmail,
    subject,
    body,
    links,
    receivedAt: new Date(date || Date.now()).toISOString(),
  };
}

export async function fetchPadSplitEmails(): Promise<ParsedEmail[]> {
  const query = buildPadSplitSenderQuery();
  const messageIds = await withRetry(() => fetchMessageIdsWithQuery(query));

  logger.info('Fetched PadSplit message IDs', {
    count: messageIds.length,
    query,
  });

  const emails: ParsedEmail[] = [];

  for (const id of messageIds) {
    try {
      const email = await withRetry(() => getMessage(id));
      if (email) {
        emails.push(email);
      }
    } catch (err) {
      logger.error('Failed to fetch message', { id, error: String(err) });
    }
  }

  logger.info('Total PadSplit emails fetched', { count: emails.length });
  return emails;
}

export function isLinkOnlyEmail(email: ParsedEmail): boolean {
  const bodyLength = email.body.replace(/\s+/g, '').length;
  return bodyLength < 100 && email.links.length > 0;
}
