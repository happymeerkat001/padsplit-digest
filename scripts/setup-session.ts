import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';

const SESSION_DIR = process.env['PADSPLIT_SESSION_PATH'] ?? './data/browser-session';
const COMMUNICATION_URL = 'https://www.padsplit.com/host/communication';

async function main(): Promise<void> {
  console.log('\n=== PadSplit Session Setup ===\n');
  console.log(`Session will be saved to: ${SESSION_DIR}\n`);

  if (!existsSync(SESSION_DIR)) {
    mkdirSync(SESSION_DIR, { recursive: true });
  }

  const context = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: false,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    args: [
      '--disable-blink-features=AutomationControlled',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = await context.newPage();
  await page.goto(COMMUNICATION_URL, { waitUntil: 'domcontentloaded' });

  console.log('Browser opened — please log in via Google.');
  console.log('Complete login and any 2FA, then press Enter here when done.\n');

  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });

  await context.close();

  console.log(`\nSession saved to ${SESSION_DIR}`);
  console.log('You can now run the pipeline (npm run digest:once or npm run digest:local).\n');
}

main().catch((err) => {
  console.error('Session setup failed:', err);
  process.exit(1);
});
