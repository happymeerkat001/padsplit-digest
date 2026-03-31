import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

(async () => {
  console.log('🚀 Launching Real Google Chrome... Log in to PadSplit manually.');

  const statePath = process.env.STORAGE_STATE_PATH || './data/padsplit-state.json';

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

  const ensureStateSaved = async (): Promise<void> => {
    const cookies = await context.cookies();
    const hasSessionId = cookies.some((c) => c.name === 'sessionid');

    if (!hasSessionId) {
      console.log('❌ sessionid cookie not found. Make sure you are fully logged in, then press ENTER again.');
      process.stdin.once('data', ensureStateSaved);
      return;
    }

    const dir = path.dirname(statePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    await context.storageState({ path: statePath });

    console.log(`✅ State saved to ${statePath}`);
    await browser.close();
    process.exit();
  };

  process.stdin.once('data', ensureStateSaved);
})();
