/**
 * One-time Honeywell session setup
 *
 * Run: npm run setup:honeywell
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../src/config.js';

const PORTAL_URL = 'https://mytotalconnectcomfort.com/portal';

async function main(): Promise<void> {
  console.log('\n=== Honeywell Total Connect Comfort Setup ===\n');

  if (!config.honeywell.username || !config.honeywell.password) {
    console.error('HONEYWELL_USERNAME and HONEYWELL_PASSWORD must be set in your .env file.');
    process.exit(1);
  }

  const sessionPath = config.honeywell.sessionPath;
  const sessionDir = dirname(sessionPath);

  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded' });

  const usernameSelectors = ['input[name="userName"]', '#userName', 'input[type="email"]'];
  const passwordSelectors = ['input[name="password"]', '#password', 'input[type="password"]'];
  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Sign In")',
    'button:has-text("Login")',
  ];

  async function fillFirst(selectors: string[], value: string): Promise<boolean> {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) > 0) {
        await locator.fill(value);
        return true;
      }
    }
    return false;
  }

  async function clickFirst(selectors: string[]): Promise<boolean> {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) > 0) {
        await locator.click();
        return true;
      }
    }
    return false;
  }

  const usernameFilled = await fillFirst(usernameSelectors, config.honeywell.username);
  const passwordFilled = await fillFirst(passwordSelectors, config.honeywell.password);
  const submitted = await clickFirst(submitSelectors);

  if (usernameFilled && passwordFilled && submitted) {
    console.log('Credentials submitted. Complete MFA in the browser if prompted.');
  } else {
    console.log('Could not auto-submit login fields. Complete login manually in the opened browser.');
  }

  console.log('\nAfter login lands in the thermostat portal, press Enter here to save session.\n');

  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });

  await context.storageState({ path: sessionPath });

  console.log(`Session saved to ${sessionPath}`);
  console.log(`Current URL: ${page.url()}`);

  await context.close();
  await browser.close();
}

main().catch((err) => {
  console.error('Honeywell setup failed:', err);
  process.exit(1);
});
