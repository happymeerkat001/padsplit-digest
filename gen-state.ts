import { chromium } from 'playwright';
import fs from 'fs';

// Ensure it looks like this (pointing to the file):
const statePath = process.env.STORAGE_STATE_PATH || './data/padsplit-state.json';
await context.storageState({ path: statePath });

(async () => {
  console.log('🚀 Launching Real Google Chrome... Log in to PadSplit manually.');

  // 1. Define the browser FIRST
  const browser = await chromium.launch({ 
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false,
    args: ['--remote-debugging-port=9222'] 
  });

  // 2. Now you can create the context and page
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto('https://www.padsplit.com/login', { waitUntil: 'networkidle' });
  } catch (e) {
    console.log('⚠️ Automatic navigation failed. Please manually go to padsplit.com in the window.');
  }

  console.log('⚠️  WAIT: Log in completely until you see your dashboard.');
  console.log('➡️  Once logged in, come back here and press ENTER to save state.');

  process.stdin.once('data', async () => {
    if (!fs.existsSync('data')) fs.mkdirSync('data');

    // EXPORT THE MASTER KEY
    await context.storageState({ path: 'data/padsplit-state.json' });
    
    console.log('✅ State saved to data/padsplit-state.json');
    await browser.close();
    process.exit();
  });
})();