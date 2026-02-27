import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
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

interface ConversationSeed {
  threadUrl: string;
  senderName: string;
  subject: string;
  preview: string;
  timestampText: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
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

async function extractConversationSeeds(page: Page): Promise<ConversationSeed[]> {
  return page.evaluate(() => {
    const roots = Array.from(document.querySelectorAll('a[href*="/host/communication"], [data-testid*="conversation"], [class*="conversation"]'));
    const seen = new Set<string>();
    const seeds: Array<{
      threadUrl: string;
      senderName: string;
      subject: string;
      preview: string;
      timestampText: string;
    }> = [];

    for (const root of roots) {
      const linkElement =
        root.matches('a[href]')
          ? root
          : root.querySelector('a[href*="/host/communication"], a[href*="/communication/"]');

      const href = linkElement?.getAttribute('href') ?? '';
      if (!href) {
        continue;
      }

      const absoluteUrl = new URL(href, window.location.origin).toString();
      const path = new URL(absoluteUrl).pathname;
      if (!path.includes('/host/communication') || /\/host\/communication\/?$/.test(path)) {
        continue;
      }

      if (seen.has(absoluteUrl)) {
        continue;
      }
      seen.add(absoluteUrl);

      const rootText = root.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      const lines = rootText
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);

      let senderName = '';
      for (const selector of ['[data-testid*="sender"]', '.sender', '.member-name', '.tenant-name']) {
        const text = root.querySelector(selector)?.textContent?.trim();
        if (text) {
          senderName = text;
          break;
        }
      }

      let subject = '';
      for (const selector of ['[data-testid*="subject"]', '.subject', '.thread-title', 'h1', 'h2', 'h3']) {
        const text = root.querySelector(selector)?.textContent?.trim();
        if (text) {
          subject = text;
          break;
        }
      }

      let preview = '';
      for (const selector of ['[data-testid*="preview"]', '.preview', '.snippet', '.last-message']) {
        const text = root.querySelector(selector)?.textContent?.trim();
        if (text) {
          preview = text;
          break;
        }
      }

      let timestampText = '';
      for (const selector of ['time', '[data-testid*="time"]', '.time', '.timestamp']) {
        const text = root.querySelector(selector)?.textContent?.trim();
        if (text) {
          timestampText = text;
          break;
        }
      }

      seeds.push({
        threadUrl: absoluteUrl,
        senderName: senderName || lines[0] || 'Member',
        subject: subject || lines[1] || 'Conversation',
        preview: preview || lines[2] || '',
        timestampText,
      });
    }

    return seeds.slice(0, 250);
  });
}

async function extractLatestThreadBody(page: Page): Promise<string> {
  await page.waitForSelector('[data-testid*="message"], .message-content, .chat-message, .conversation-message', {
    timeout: 10_000,
  }).catch(() => undefined);

  return page.evaluate(() => {
    const messageSelectors = [
      '[data-testid*="message"]',
      '.message-content',
      '.chat-message',
      '.conversation-message',
      '[class*="message-body"]',
    ];

    const texts: string[] = [];
    for (const selector of messageSelectors) {
      for (const el of Array.from(document.querySelectorAll(selector))) {
        const text = el.textContent?.replace(/\s+/g, ' ').trim();
        if (text) {
          texts.push(text);
        }
      }
      if (texts.length > 0) {
        break;
      }
    }

    if (texts.length === 0) {
      const fallback = document.body?.innerText?.replace(/\s+/g, ' ').trim();
      return fallback ? fallback.slice(0, 1500) : '';
    }

    return texts[texts.length - 1] ?? '';
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

    const seeds = (await extractConversationSeeds(listPage)).slice(0, MAX_CONVERSATIONS_PER_RUN);

    logger.info('PadSplit communication threads discovered', { count: seeds.length });

    const messages: InboxMessage[] = [];

    for (const seed of seeds) {
      const threadPage = await context.newPage();

      try {
        await threadPage.goto(seed.threadUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        await verifyLogin(threadPage, 'communication-thread');
        await threadPage.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);

        const body = await extractLatestThreadBody(threadPage);
        const timestamp = normalizeTimestamp(seed.timestampText);

        messages.push({
          messageId: generateMessageId(seed.threadUrl, seed.senderName, timestamp),
          source: 'communication',
          senderName: seed.senderName,
          subject: seed.subject,
          body: body || seed.preview || '(No message body found)',
          messageUrl: seed.threadUrl,
          timestamp,
        });
      } catch (err) {
        logger.error('Failed to scrape communication thread', {
          threadUrl: seed.threadUrl,
          error: String(err),
        });
        await debugScreenshot(threadPage, 'communication-thread-error');
      } finally {
        await threadPage.close();
      }

      await sleep(1200);
    }

    logger.info('PadSplit communication scrape complete', { count: messages.length });
    return messages;
  } catch (err) {
    logger.error('Failed to scrape communication inbox', { error: String(err) });
    await debugScreenshot(listPage, 'communication-list-error');
    return [];
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

    const tasks = await page.evaluate(() => {
      const roots = Array.from(document.querySelectorAll('[data-testid*="task"], [class*="task"], a[href*="/host/tasks/"]'));
      const seen = new Set<string>();
      const results: Array<{
        taskUrl: string;
        title: string;
        description: string;
        status: string;
        timestampText: string;
      }> = [];

      for (const root of roots) {
        const linkElement =
          root.matches('a[href]')
            ? root
            : root.querySelector('a[href*="/host/tasks"], a[href*="/tasks/"]');

        const href = linkElement?.getAttribute('href') ?? '';
        const taskUrl = href ? new URL(href, window.location.origin).toString() : window.location.href;

        if (seen.has(taskUrl)) {
          continue;
        }
        seen.add(taskUrl);

        let title = '';
        for (const selector of ['[data-testid*="title"]', '.task-title', 'h1', 'h2', 'h3']) {
          const text = root.querySelector(selector)?.textContent?.trim();
          if (text) {
            title = text;
            break;
          }
        }

        let description = '';
        for (const selector of ['[data-testid*="description"]', '.task-description', '.description', 'p']) {
          const text = root.querySelector(selector)?.textContent?.trim();
          if (text) {
            description = text;
            break;
          }
        }

        let status = '';
        for (const selector of ['[data-testid*="status"]', '.status', '.task-status']) {
          const text = root.querySelector(selector)?.textContent?.trim();
          if (text) {
            status = text;
            break;
          }
        }

        let timestampText = '';
        for (const selector of ['time', '[data-testid*="time"]', '.timestamp', '.date']) {
          const text = root.querySelector(selector)?.textContent?.trim();
          if (text) {
            timestampText = text;
            break;
          }
        }

        results.push({
          taskUrl,
          title: title || 'Task',
          description,
          status,
          timestampText,
        });
      }

      return results.slice(0, 300);
    });

    const messages: InboxMessage[] = tasks.map((task) => {
      const timestamp = normalizeTimestamp(task.timestampText);
      const bodyParts = [task.description, task.status ? `Status: ${task.status}` : ''].filter(Boolean);

      return {
        messageId: generateMessageId(task.taskUrl, 'Task', timestamp),
        source: 'task',
        senderName: 'Task',
        subject: task.title,
        body: bodyParts.join('\n') || 'Task item',
        messageUrl: task.taskUrl,
        timestamp,
      };
    });

    logger.info('PadSplit tasks scrape complete', { count: messages.length });
    return messages;
  } catch (err) {
    logger.error('Failed to scrape tasks', { error: String(err) });
    await debugScreenshot(page, 'tasks-error');
    return [];
  } finally {
    await page.close();
  }
}
