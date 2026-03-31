import { chromium, type Browser, type BrowserContext } from 'playwright';
import { existsSync } from 'node:fs';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { AuthError } from './client.js';

const COMMUNICATION_URL = 'https://www.padsplit.com/host/communication';

// On the VPS: src/api/auth.ts
async function extractCookies() {
  const { sessionPath } = config.padsplit;

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    // 1. Launch browser normally
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    context = await browser.newContext({ storageState: sessionPath });

    const page = await context.newPage();
    // ... keep the rest of your goto and cookie logic ...
    await page.goto(COMMUNICATION_URL, { waitUntil: 'domcontentloaded' });

    if (!page.url().includes('/host/')) {
      throw new AuthError('PadSplit session expired — re-run `npm run setup-session`');
    }

    // Query ALL cookies (no URL filter) so root-domain cookies (.padsplit.com) are included.
    const allCookies = await context.cookies();
    const padsplitCookies = allCookies.filter((c) => c.domain.includes('padsplit.com'));

    logger.info('PadSplit cookies found in persistent session', {
      totalCookies: allCookies.length,
      padsplitCookies: padsplitCookies.map((c) => ({
        name: c.name,
        domain: c.domain,
        path: c.path,
        valueLength: c.value.length,
        httpOnly: c.httpOnly,
        secure: c.secure,
      })),
    });

    const sessionid = padsplitCookies.find((c) => c.name === 'sessionid')?.value;
    const csrftoken = padsplitCookies.find((c) => c.name === 'csrftoken')?.value;

    if (!sessionid || !csrftoken) {
      logger.warn('Session cookies missing in stored state', {
        cookieNames: padsplitCookies.map((c) => c.name),
      });
      throw new AuthError('Session cookies not found — re-run `npm run setup-session`');
    }

    // Send all padsplit cookies in the header, not just sessionid + csrftoken.
    const cookieHeader = padsplitCookies.map((c) => `${c.name}=${c.value}`).join('; ');

    logger.info('PadSplit cookie header built', {
      cookieCount: padsplitCookies.length,
      cookieLength: cookieHeader.length,
      hasSessionId: cookieHeader.includes('sessionid='),
      hasCsrfToken: cookieHeader.includes('csrftoken='),
    });

    return cookieHeader;
  } finally {
    await context?.close();
    await browser?.close();
  }
}

export async function getPadsplitCookies(): Promise<string> {
  return withRetry(extractCookies, { maxAttempts: 2 });
}
