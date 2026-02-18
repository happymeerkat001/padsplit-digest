/**
 * One-time PadSplit session setup
 *
 * Opens a browser window for you to manually log into PadSplit with Google.
 * The session is saved and reused for automated scraping.
 *
 * Run: npm run setup:padsplit
 */

import { chromium } from 'playwright';
import { config } from '../src/config.js';

async function main() {
  console.log('\n=== PadSplit Session Setup ===\n');
  console.log('This will open a browser window.');
  console.log('Please log into PadSplit using your Google account.\n');

  const sessionPath = config.padsplit.sessionPath;

  // Launch browser with persistent context (saves cookies/session)
  const context = await chromium.launchPersistentContext(sessionPath, {
  headless: false,
  channel: 'chrome', // <-- important
  args: ['--disable-blink-features=AutomationControlled'],
});
    headless: false, // Show browser for manual login
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();

  // Navigate to PadSplit login
  await page.goto('https://www.padsplit.com/host/login', {
  waitUntil: 'networkidle'
});

  console.log('Browser opened. Please:');
  console.log('1. Click "Sign in with Google"');
  console.log('2. Complete the Google login');
  console.log('3. Wait until you see the PadSplit dashboard');
  console.log('4. Press Enter in this terminal when done\n');

  // Wait for user to complete login
  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => resolve());
  });

  // Verify login worked
  const url = page.url();
  if (url.includes('/host/dashboard')) {
    console.log('\n=== Success! ===\n');
    console.log(`Session saved to: ${sessionPath}`);
    console.log('You can now run the digest system.\n');
  } else {
    console.log('\n=== Warning ===\n');
    console.log('Login may not have completed successfully.');
    console.log(`Current URL: ${url}`);
    console.log('Try running this script again.\n');
  }

  await context.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
