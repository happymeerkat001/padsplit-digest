import { chromium, type Browser, type Page } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

const PORTAL_URL = 'https://mytotalconnectcomfort.com/portal';

export interface ThermostatReading {
  name: string;
  currentTemp: number;
  setpoint: number;
  mode: string;
  lastUpdated: string | null;
}

const LOGIN_SELECTORS = {
  username: ['input[name="userName"]', '#userName', 'input[type="email"]'],
  password: ['input[name="password"]', '#password', 'input[type="password"]'],
  submit: [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Sign In")',
    'button:has-text("Login")',
  ],
};

export function hasHoneywellCredentials(): boolean {
  return Boolean(config.honeywell.username && config.honeywell.password);
}

async function findVisibleSelector(page: Page, selectors: string[]): Promise<string | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
      return selector;
    }
  }

  return null;
}

async function isLoginPage(page: Page): Promise<boolean> {
  const url = page.url().toLowerCase();
  if (url.includes('login') || url.includes('signin')) {
    return true;
  }

  const usernameSelector = await findVisibleSelector(page, LOGIN_SELECTORS.username);
  const passwordSelector = await findVisibleSelector(page, LOGIN_SELECTORS.password);
  return Boolean(usernameSelector && passwordSelector);
}

async function runLogin(page: Page): Promise<void> {
  const usernameSelector = await findVisibleSelector(page, LOGIN_SELECTORS.username);
  const passwordSelector = await findVisibleSelector(page, LOGIN_SELECTORS.password);
  const submitSelector = await findVisibleSelector(page, LOGIN_SELECTORS.submit);

  if (!usernameSelector || !passwordSelector || !submitSelector) {
    throw new Error('Could not find login form fields on Honeywell portal');
  }

  await page.fill(usernameSelector, config.honeywell.username);
  await page.fill(passwordSelector, config.honeywell.password);
  await page.click(submitSelector);

  await page.waitForLoadState('networkidle', { timeout: 30000 });

  if (await isLoginPage(page)) {
    throw new Error('Honeywell login failed or still on login page');
  }
}

async function ensureAuthenticated(page: Page): Promise<void> {
  await page.goto(PORTAL_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  const loginRequired = await isLoginPage(page);
  if (!loginRequired) {
    return;
  }

  logger.info('Honeywell session expired, logging in again');
  await runLogin(page);
}

function parseTemperature(value: string | null): number {
  if (!value) return Number.NaN;
  const match = value.match(/-?\d+(?:\.\d+)?/);
  return match ? Number.parseFloat(match[0]) : Number.NaN;
}

async function scrapeReadings(page: Page): Promise<ThermostatReading[]> {
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => undefined);

  const readings = await page.evaluate(() => {
    const pickText = (root: ParentNode, selectors: string[]): string => {
      for (const selector of selectors) {
        const element = root.querySelector(selector);
        const text = element?.textContent?.trim();
        if (text) return text;
      }
      return '';
    };

    const rootSelectors = [
      '[data-testid*="thermostat"]',
      '.thermostat',
      '.device-card',
      '.location-card',
      '.zone-card',
    ];

    const roots: Element[] = [];
    for (const selector of rootSelectors) {
      for (const element of Array.from(document.querySelectorAll(selector))) {
        roots.push(element);
      }
      if (roots.length > 0) break;
    }

    const candidates = roots.length > 0 ? roots : [document.body];

    return candidates.map((root) => ({
      name: pickText(root, ['.device-name', '.location-name', '.name', '[data-testid*="name"]']),
      currentTemp: pickText(root, [
        '.current-temperature',
        '.current-temp',
        '.temperature',
        '[data-testid*="current"]',
      ]),
      setpoint: pickText(root, ['.setpoint', '.target-temperature', '.target-temp', '[data-testid*="setpoint"]']),
      mode: pickText(root, ['.mode', '.system-mode', '[data-testid*="mode"]']),
      lastUpdated: pickText(root, ['.last-updated', '.updated', 'time']),
    }));
  });

  const normalized: ThermostatReading[] = [];

  for (const candidate of readings) {
    const currentTemp = parseTemperature(candidate.currentTemp || null);
    const setpoint = parseTemperature(candidate.setpoint || null);

    if (!Number.isFinite(currentTemp) || !Number.isFinite(setpoint)) {
      continue;
    }

    normalized.push({
      name: candidate.name || 'Unnamed Thermostat',
      currentTemp,
      setpoint,
      mode: (candidate.mode || 'unknown').toLowerCase(),
      lastUpdated: candidate.lastUpdated || null,
    });
  }

  const unique = new Map<string, ThermostatReading>();
  for (const reading of normalized) {
    const key = `${reading.name}|${reading.currentTemp}|${reading.setpoint}|${reading.mode}`;
    unique.set(key, reading);
  }

  return [...unique.values()];
}

export async function scrapeHoneywellThermostats(): Promise<ThermostatReading[]> {
  if (!hasHoneywellCredentials()) {
    logger.warn('Honeywell credentials missing; skipping thermostat scrape');
    return [];
  }

  const sessionPath = config.honeywell.sessionPath;
  const sessionDir = dirname(sessionPath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }

  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext(
      existsSync(sessionPath) ? { storageState: sessionPath } : undefined
    );

    const page = await context.newPage();

    await withRetry(() => ensureAuthenticated(page), {
      maxAttempts: 2,
      baseDelayMs: 1500,
    });

    const readings = await withRetry(() => scrapeReadings(page), {
      maxAttempts: 2,
      baseDelayMs: 1500,
    });

    await context.storageState({ path: sessionPath });
    await context.close();

    logger.info('Honeywell thermostat scrape complete', { count: readings.length });
    return readings;
  } catch (err) {
    logger.error('Honeywell scrape failed', { error: String(err) });
    return [];
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
