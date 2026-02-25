import { chromium, type BrowserContext } from 'playwright';
import { existsSync } from 'node:fs';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

let context: BrowserContext | null = null;
let disabled = false;

export function disableBrowser(): void {
  disabled = true;
}

export function enableBrowser(): void {
  disabled = false;
}

export async function getBrowserContext(): Promise<BrowserContext> {
  if (disabled) {
    throw new Error('Browser disabled after timeout');
  }

  if (context) {
    return context;
  }

  const sessionPath = config.padsplit.sessionPath;
  const hasSession = existsSync(sessionPath);

  if (!hasSession) {
    logger.warn('No PadSplit session found', {
      path: sessionPath,
      hint: 'Run: npm run setup:padsplit',
    });
  }

  context = await chromium.launchPersistentContext(sessionPath, {
    headless: true,
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  logger.info('Browser context created', { sessionPath, hasSession });

  return context;
}

export async function closeBrowser(): Promise<void> {
  if (context) {
    await context.close();
    context = null;
    logger.info('Browser context closed');
  }
}

// Check if we're logged into PadSplit
export async function isLoggedIn(): Promise<boolean> {
  const ctx = await getBrowserContext();
  const page = await ctx.newPage();

  try {
    await page.goto('https://www.padsplit.com/host/dashboard', {
      waitUntil: 'networkidle',
      timeout: 15000,
    });

    // Check if redirected to login
    const url = page.url();
    const loggedIn = url.includes('/dashboard') && !url.includes('login');

    logger.info('Login check', { loggedIn, url });
    return loggedIn;
  } catch (err) {
    logger.error('Login check failed', { error: String(err) });
    return false;
  } finally {
    await page.close();
  }
}
