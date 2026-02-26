import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

const PORTAL_URL = 'https://mytotalconnectcomfort.com/portal';
const DEBUG = process.env['HONEYWELL_DEBUG'] === '1';
const DEBUG_DIR = 'tmp/honeywell-debug';
const LOGIN_TIMEOUT_MS = 30_000;

async function debugScreenshot(page: Page, name: string): Promise<void> {
  if (!DEBUG) return;
  if (!existsSync(DEBUG_DIR)) mkdirSync(DEBUG_DIR, { recursive: true });
  const path = `${DEBUG_DIR}/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  logger.info(`[honeywell-debug] screenshot: ${path}  url: ${page.url()}`);
}

let activeBrowser: Browser | null = null;
let activeContext: BrowserContext | null = null;

export interface ThermostatReading {
  name: string;
  currentTemp: number;
  setpoint: number;
  mode: string;
  lastUpdated: string | null;
}

export function hasHoneywellCredentials(): boolean {
  return Boolean(config.honeywell.username && config.honeywell.password);
}

export async function closeHoneywellBrowserContext(): Promise<void> {
  if (activeContext) {
    try {
      await activeContext.close();
    } catch {
      // Ignore cleanup errors; timeout path should continue.
    } finally {
      activeContext = null;
    }
  }

  if (activeBrowser) {
    try {
      await activeBrowser.close();
    } catch {
      // Ignore cleanup errors; timeout path should continue.
    } finally {
      activeBrowser = null;
    }
  }
}

async function isLoginPage(page: Page): Promise<boolean> {
  return (await page.locator('text=Already have an account?').count()) > 0;
}

async function isAuthenticatedState(page: Page): Promise<boolean> {
  const hasWelcome = (await page.locator('text=Welcome Ang').count()) > 0;
  const isPortalUrl = page.url().includes('/portal');
  return hasWelcome || isPortalUrl;
}

async function runLogin(page: Page): Promise<void> {
  await debugScreenshot(page, 'before-login');
  console.log('Honeywell login: before login');

  const emailField = page.getByLabel('Email Address');
  const passwordField = page.getByLabel('My Total Connect Comfort Password');
  const submitButton = page.getByRole('button', { name: /login/i }).first();

  await emailField.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await passwordField.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  await emailField.fill(config.honeywell.username);
  await passwordField.fill(config.honeywell.password);
  await submitButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  console.log('Honeywell login: after fill, before click');
  try {
    await Promise.all([
      page.waitForURL(/\/portal/i, { timeout: LOGIN_TIMEOUT_MS }).catch(() => undefined),
      submitButton.click({ force: true }),
    ]);
  } catch (err) {
    logger.warn('Honeywell login click failed, using fallback submit', { error: String(err) });
    await page.evaluate(() => {
      const submit = document.querySelector(
        'input[type="submit"][value="Login"], button[type="submit"], input[type="submit"]'
      ) as HTMLInputElement | HTMLButtonElement | null;
      submit?.click();
    });
    await passwordField.press('Enter').catch(() => undefined);
    await page.waitForURL(/\/portal/i, { timeout: LOGIN_TIMEOUT_MS }).catch(() => undefined);
  }
  console.log('Honeywell login: after click');

  await page.waitForLoadState('networkidle', { timeout: LOGIN_TIMEOUT_MS }).catch(() => undefined);
  console.log('Honeywell login: after navigation');
  console.log('Current URL:', page.url());

  await debugScreenshot(page, 'after-login');

  const authenticated = await isAuthenticatedState(page);
  if (!authenticated || (await isLoginPage(page))) {
    if (!existsSync(DEBUG_DIR)) mkdirSync(DEBUG_DIR, { recursive: true });
    const failurePath = `${DEBUG_DIR}/login-failed.png`;
    await page.screenshot({ path: failurePath, fullPage: true }).catch(() => undefined);
    const pageContent = await page.content().catch(() => '');
    logger.error('Honeywell login failed', {
      url: page.url(),
      screenshot: failurePath,
      pageContentSnippet: pageContent.slice(0, 2000),
    });
    throw new Error('Honeywell login failed');
  }
}

async function ensureAuthenticated(page: Page): Promise<void> {
  await page.goto(PORTAL_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  if (await isLoginPage(page)) {
    logger.info('Honeywell login required');
    await runLogin(page);
    await page.context().storageState({ path: config.honeywell.sessionPath });
  }
}

function parseTemperature(value: string | null): number {
  if (!value) return Number.NaN;
  const match = value.match(/-?\d+(?:\.\d+)?/);
  return match ? Number.parseFloat(match[0]) : Number.NaN;
}

async function pickText(root: Locator, selectors: string[]): Promise<string> {
  for (const sel of selectors) {
    const el = root.locator(sel).first();
    if ((await el.count()) > 0) {
      const text = await el.textContent().catch(() => null);
      if (text?.trim()) return text.trim();
    }
  }
  return '';
}

const CARD_SELECTORS = [
  '[data-testid*="thermostat"]',
  '.thermostat',
  '.device-card',
  '.location-card',
  '.zone-card',
];

const NAME_SELECTORS = ['.device-name', '.location-name', '.name', '[data-testid*="name"]'];
const TEMP_SELECTORS = ['.current-temperature', '.current-temp', '.temperature', '[data-testid*="current"]'];
const SETPOINT_SELECTORS = ['.setpoint', '.target-temperature', '.target-temp', '[data-testid*="setpoint"]'];
const MODE_SELECTORS = ['.mode', '.system-mode', '[data-testid*="mode"]'];
const UPDATED_SELECTORS = ['.last-updated', '.updated', 'time'];

async function scrapeReadings(page: Page): Promise<ThermostatReading[]> {
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => undefined);

  await debugScreenshot(page, 'dashboard');

  // Find thermostat card elements via locators
  let cards: Locator | null = null;
  for (const selector of CARD_SELECTORS) {
    const locator = page.locator(selector);
    if ((await locator.count()) > 0) {
      cards = locator;
      break;
    }
  }

  const roots = cards ?? page.locator('body');
  const rootCount = await roots.count();

  const normalized: ThermostatReading[] = [];

  for (let i = 0; i < rootCount; i++) {
    const root = roots.nth(i);

    const name = await pickText(root, NAME_SELECTORS);
    const currentTempText = await pickText(root, TEMP_SELECTORS);
    const setpointText = await pickText(root, SETPOINT_SELECTORS);
    const modeText = await pickText(root, MODE_SELECTORS);
    const lastUpdatedText = await pickText(root, UPDATED_SELECTORS);

    const currentTemp = parseTemperature(currentTempText || null);
    const setpoint = parseTemperature(setpointText || null);

    if (!Number.isFinite(currentTemp) || !Number.isFinite(setpoint)) continue;

    normalized.push({
      name: name || 'Unnamed Thermostat',
      currentTemp,
      setpoint,
      mode: (modeText || 'unknown').toLowerCase(),
      lastUpdated: lastUpdatedText || null,
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
    browser = await chromium.launch({
      headless: !DEBUG,
      slowMo: DEBUG ? 300 : 0,
    });
    activeBrowser = browser;
    const context = await browser.newContext(
      existsSync(sessionPath) ? { storageState: sessionPath } : undefined
    );
    activeContext = context;

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
    activeContext = null;

    logger.info('Honeywell thermostat scrape complete', { count: readings.length });
    return readings;
  } catch (err) {
    logger.error('Honeywell scrape failed', { error: String(err) });
    return [];
  } finally {
    if (activeContext) {
      try {
        await activeContext.close();
      } catch {
        // Ignore cleanup errors.
      } finally {
        activeContext = null;
      }
    }

    if (browser) {
      try {
        await browser.close();
      } finally {
        if (activeBrowser === browser) {
          activeBrowser = null;
        }
      }
    }
  }
}
