import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from 'playwright';
import { config } from '../config.js';
import { getBrowserContext } from './browser.js';
import { logger } from '../utils/logger.js';

const DEBUG = process.env['PADSPLIT_DEBUG'] === '1';
const DEBUG_DIR = resolve(process.cwd(), 'tmp', 'padsplit-debug');
const MAX_CONVERSATIONS_PER_RUN = 50;

export interface InboxMessage {
  messageId: string;
  source: 'communication' | 'task';
  senderName: string;
  subject: string;
  body: string;
  messageUrl: string;
  timestamp: string;
}

interface MessageRow {
  name: string;
  room: string;
  address: string;
  content: string;
  time: string;
}

interface TaskCard {
  id: string;
  status: string;
  address: string;
  description: string;
  taskType: string;
  room: string;
  createdOn: string;
}

interface ColumnResult {
  status: string;
  expectedCount: number;
  actualCount: number;
  cards: TaskCard[];
}

function normalizeTimestamp(timestampText: string): string {
  const parsed = new Date(timestampText);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }
  return parsed.toISOString();
}

function generateMessageId(url: string, sender: string, timestamp: string): string {
  try {
    const parsedUrl = new URL(url);
    const segments = parsedUrl.pathname.split('/').filter(Boolean);

    for (const segment of segments) {
      if (/^[0-9]+$/.test(segment) || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment)) {
        return `padsplit-${segment}`;
      }
    }
  } catch {
    // Fallback hash below.
  }

  return createHash('sha256').update(`${url}|${sender}|${timestamp}`).digest('hex');
}

async function debugScreenshot(page: Page, name: string): Promise<void> {
  if (!DEBUG) {
    return;
  }

  if (!existsSync(DEBUG_DIR)) {
    mkdirSync(DEBUG_DIR, { recursive: true });
  }

  const filename = `${Date.now()}-${name}.png`;
  const outputPath = resolve(DEBUG_DIR, filename);
  await page.screenshot({ path: outputPath, fullPage: true }).catch(() => undefined);

  logger.info('PadSplit debug screenshot', { path: outputPath, url: page.url() });
}

async function dumpDomStructure(page: Page, label: string): Promise<void> {
  if (!DEBUG) {
    return;
  }

  if (!existsSync(DEBUG_DIR)) {
    mkdirSync(DEBUG_DIR, { recursive: true });
  }

  const dump = await page.evaluate(() => ({
    url: window.location.href,
    title: document.title,
    chatPreviewCount: document.querySelectorAll('[class*="ChatPreview_root"]').length,
    ticketCount: document.querySelectorAll('[class*="Ticket_root"]').length,
    columnCount: document.querySelectorAll('[class*="TasksColumn_root"]').length,
    allClassPrefixes: Array.from(
      new Set(
        Array.from(document.querySelectorAll('[class]'))
          .flatMap((el) => Array.from(el.classList))
          .filter((className) => /^[A-Z]/.test(className))
          .map((className) => className.replace(/__.+/, ''))
      )
    )
      .sort()
      .slice(0, 50),
    bodyTextPreview: document.body?.innerText?.slice(0, 2000) ?? '',
  }));

  const outputPath = resolve(DEBUG_DIR, `${Date.now()}-${label}-dom.json`);
  writeFileSync(outputPath, JSON.stringify(dump, null, 2), 'utf-8');
  logger.info('DOM structure dump', { path: outputPath, url: page.url() });
}

async function dumpTasksDom(page: Page): Promise<void> {
  if (!DEBUG) {
    return;
  }

  if (!existsSync(DEBUG_DIR)) {
    mkdirSync(DEBUG_DIR, { recursive: true });
  }

  const dump = await page.evaluate(() => {
    const columnHeaders = Array.from(document.querySelectorAll('[class*="TasksColumn_root"] .ps-tp'))
      .map((element) => element.textContent?.trim() ?? '')
      .filter(Boolean);
    const firstColumnHtml = document.querySelector('[class*="TasksColumn_root"]')?.outerHTML?.slice(0, 5000) ?? '';
    const firstTicketHtml = document.querySelector('[class*="Ticket_root"]')?.outerHTML?.slice(0, 3000) ?? '';

    return {
      url: window.location.href,
      title: document.title,
      columnHeaders,
      firstColumnHtml,
      firstTicketHtml,
    };
  });

  const outputPath = resolve(DEBUG_DIR, `${Date.now()}-tasks-full-dom.html`);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>PadSplit Tasks DOM Dump</title>
  <style>
    body { font-family: monospace; padding: 16px; }
    h2 { margin-top: 20px; }
    pre { white-space: pre-wrap; word-break: break-word; border: 1px solid #ddd; padding: 10px; }
  </style>
</head>
<body>
  <h1>PadSplit Tasks DOM Dump</h1>
  <pre>${JSON.stringify({ url: dump.url, title: dump.title, columnHeaders: dump.columnHeaders }, null, 2)}</pre>
  <h2>First Column HTML</h2>
  <pre>${dump.firstColumnHtml}</pre>
  <h2>First Ticket HTML</h2>
  <pre>${dump.firstTicketHtml}</pre>
</body>
</html>`;

  writeFileSync(outputPath, html, 'utf-8');
  logger.info('Tasks DOM dump', { path: outputPath, url: page.url() });
}

async function verifyLogin(page: Page, context: string): Promise<void> {
  const currentUrl = page.url().toLowerCase();
  if (currentUrl.includes('/login') || currentUrl.includes('/signin')) {
    await debugScreenshot(page, `${context}-login-redirect`);
    throw new Error(`PadSplit session invalid while scraping ${context}. Run: npm run setup:padsplit`);
  }

  const hasSignIn = await page.getByText('Sign in with Google', { exact: false }).count();
  if (hasSignIn > 0) {
    await debugScreenshot(page, `${context}-login-screen`);
    throw new Error(`PadSplit login screen detected while scraping ${context}. Run: npm run setup:padsplit`);
  }
}

async function extractMessageRows(page: Page): Promise<MessageRow[]> {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[class*="ChatPreview_root"]'));
    return rows
      .map((row) => ({
        name: row.querySelector('[class*="ChatPreview_title"]')?.textContent?.trim() ?? '',
        room:
          row.querySelector('[class*="ChatPreview_header"] .pst-body')?.textContent?.trim() ??
          row.querySelector('.pst-body')?.textContent?.trim() ??
          '',
        address: row.querySelector('[class*="ChatPreview_propertyText"]')?.textContent?.trim() ?? '',
        content: row.querySelector('[class*="ChatPreview_messageText"]')?.textContent?.trim() ?? '',
        time: row.querySelector('[class*="ChatPreview_dateTime"]')?.textContent?.trim() ?? '',
      }))
      .filter((entry) => entry.name.length > 0);
  });
}

export async function scrapeCommunication(): Promise<InboxMessage[]> {
  const context = await getBrowserContext();
  const listPage = await context.newPage();

  try {
    await listPage.goto(config.padsplit.communicationUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await verifyLogin(listPage, 'communication');
    await listPage.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
    await dumpDomStructure(listPage, 'communication-list');

    const communicationDomStats = await listPage.evaluate(() => {
      const visibleRowCount = document.querySelectorAll('[class*="ChatPreview_root"]').length;

      const textCandidates = Array.from(
        document.querySelectorAll('h1, h2, h3, [class*="header"], .ps-tp, .pst-body, .pst-bodyS')
      )
        .map((element) => element.textContent?.trim() ?? '')
        .filter(Boolean);

      let headerExpectedCount: number | null = null;
      for (const text of textCandidates) {
        const normalized = text.toLowerCase();
        if (!normalized.includes('communication') && !normalized.includes('conversation') && !normalized.includes('message')) {
          continue;
        }

        const match = text.match(/\((\d+)\)\s*$/);
        if (!match) {
          continue;
        }

        headerExpectedCount = Number.parseInt(match[1] ?? '0', 10);
        break;
      }

      return { visibleRowCount, headerExpectedCount };
    });

    const rows = (await extractMessageRows(listPage)).slice(0, MAX_CONVERSATIONS_PER_RUN);

    if (communicationDomStats.visibleRowCount > 0 && rows.length === 0) {
      throw new Error('Communication extraction mismatch - DOM likely changed');
    }

    if (communicationDomStats.headerExpectedCount != null) {
      const expectedComparable = Math.min(communicationDomStats.headerExpectedCount, MAX_CONVERSATIONS_PER_RUN);
      if (rows.length !== expectedComparable) {
        throw new Error(`Communication mismatch: expected ${expectedComparable}, got ${rows.length}`);
      }
    }

    logger.info('PadSplit communication rows discovered', { count: rows.length });

    const messages: InboxMessage[] = rows.map((row) => {
      const timestamp = normalizeTimestamp(row.time);
      const address = row.address.trim();
      const room = row.room.trim();
      const subject = room && address ? `${room}, ${address}` : room || address || 'Conversation';

      return {
        messageId: generateMessageId(config.padsplit.communicationUrl, row.name, timestamp),
        source: 'communication',
        senderName: row.name,
        subject,
        body: row.content || '(No message preview found)',
        messageUrl: config.padsplit.communicationUrl,
        timestamp,
      };
    });

    logger.info('PadSplit communication scrape complete', { count: messages.length });
    return messages;
  } catch (err) {
    logger.error('Failed to scrape communication inbox', { error: String(err) });
    await debugScreenshot(listPage, 'communication-list-error');
    throw err;
  } finally {
    await listPage.close();
  }
}

export async function scrapeTasks(): Promise<InboxMessage[]> {
  const context = await getBrowserContext();
  const page = await context.newPage();

  try {
    await page.goto(config.padsplit.tasksUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await verifyLogin(page, 'tasks');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
    await dumpTasksDom(page);

    for (let i = 0; i < 3; i += 1) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1000);
    }
    await page.evaluate(() => window.scrollTo(0, 0));

    const columnResults = await page.evaluate<ColumnResult[]>(() => {
      const columns = Array.from(document.querySelectorAll('[class*="TasksColumn_root"]'));
      const results: ColumnResult[] = [];

      for (const column of columns) {
        const headerElement = column.querySelector('.ps-tp');
        const headerText = headerElement?.textContent?.trim() ?? '';
        const status = headerText.replace(/\s*\(\d+\)\s*$/, '');
        const countMatch = headerText.match(/\((\d+)\)\s*$/);
        const expectedCount = countMatch ? Number.parseInt(countMatch[1] ?? '0', 10) : 0;
        const cards: TaskCard[] = [];

        const tickets = Array.from(column.querySelectorAll('[class*="Ticket_root"]'));
        for (const ticket of tickets) {
          const topTexts = ticket.querySelectorAll('[class*="Ticket_topRow"] .pst-bodyS');
          const idText = topTexts[0]?.textContent?.trim() ?? '';
          const createdText = topTexts[1]?.textContent?.trim() ?? '';

          const divider = ticket.querySelector('[class*="Ticket_dividerWrapper"]');
          const boldElements = divider ? Array.from(divider.querySelectorAll('.pst-bodySBold')) : [];
          const normalElements = divider ? Array.from(divider.querySelectorAll('.pst-bodyS')) : [];

          cards.push({
            id: idText.replace(/^ID:\s*/, ''),
            status,
            address: ticket.querySelector('[class*="Ticket_textWrapper"]')?.textContent?.trim() ?? '',
            description: ticket.querySelector('[class*="Ticket_ticketDetails"]')?.textContent?.trim() ?? '',
            taskType: boldElements.length > 1 ? boldElements[1]?.textContent?.trim() ?? '' : '',
            room: normalElements[0]?.textContent?.trim() ?? '',
            createdOn: createdText.replace(/^Created on\s*/, ''),
          });
        }

        results.push({
          status: status || 'Other',
          expectedCount,
          actualCount: cards.length,
          cards,
        });
      }

      return results;
    });

    const columnBreakdown: Record<string, number> = {};
    let totalExtracted = 0;

    for (const column of columnResults) {
      columnBreakdown[column.status] = column.actualCount;
      totalExtracted += column.actualCount;

      if (column.expectedCount !== column.actualCount) {
        throw new Error(`Column ${column.status} mismatch: expected ${column.expectedCount}, got ${column.actualCount}`);
      }

      logger.info('Column extracted', {
        status: column.status,
        expectedCount: column.expectedCount,
        actualCount: column.actualCount,
      });
    }

    logger.info('Task summary', { totalExtracted, columnBreakdown });

    if (totalExtracted === 0) {
      throw new Error('No tasks extracted - DOM likely changed');
    }

    const messages: InboxMessage[] = columnResults.flatMap((column) =>
      column.cards.map((card) => {
        const timestamp = normalizeTimestamp(card.createdOn);
        const bodyParts = [card.taskType, card.room, card.description, card.status ? `Status: ${card.status}` : '']
          .map((part) => part.trim())
          .filter(Boolean);

        return {
          messageId: card.id ? `padsplit-${card.id}` : generateMessageId(config.padsplit.tasksUrl, 'Task', timestamp),
          source: 'task',
          senderName: 'Task',
          subject: card.address || 'Task',
          body: bodyParts.join('\n') || 'Task item',
          messageUrl: config.padsplit.tasksUrl,
          timestamp,
        };
      })
    );

    logger.info('PadSplit tasks scrape complete', { count: messages.length });
    return messages;
  } catch (err) {
    logger.error('Failed to scrape tasks', { error: String(err) });
    await debugScreenshot(page, 'tasks-error');
    throw err;
  } finally {
    await page.close();
  }
}
