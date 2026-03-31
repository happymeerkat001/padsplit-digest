import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EMAIL = process.env.PADSPLIT_EMAIL;
const PASSWORD = process.env.PADSPLIT_PASSWORD;
const STATE_PATH = path.join(__dirname, '../data/padsplit-state.json');

(async () => {
  if (!EMAIL || !PASSWORD) {
    console.error('❌ Missing credentials in .env');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: false }); 
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }
  });
  const page = await context.newPage();
  const dir = path.dirname(STATE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const waitForSessionId = async (): Promise<boolean> => {
    const maxAttempts = 10;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const cookies = await context.cookies();
      const hasSessionId = cookies.some((c) => c.name === 'sessionid');
      if (hasSessionId) {
        console.log(`✅ sessionid cookie detected (attempt ${attempt})`);
        return true;
      }
      await page.waitForTimeout(1000);
    }
    return false;
  };

  try {
    console.log('🌐 Loading PadSplit...');
    await page.goto('https://www.padsplit.com/', { waitUntil: 'domcontentloaded' });

    console.log('🔘 Opening Sign In Modal...');
    // We target the button specifically by its text since the ID was tricky
    await page.getByRole('button', { name: /Sign In/i }).first().click();

    console.log('⌛ Waiting for Modal fields...');
    // Wait for the Email input to be visible INSIDE the popup
    const emailField = page.locator('input[name="email"], input[type="email"]');
    await emailField.waitFor({ state: 'visible', timeout: 10000 });

    console.log('✍️  Filling credentials...');
    await emailField.fill(EMAIL);
    await page.locator('input[name="password"]').fill(PASSWORD);
    
    console.log('🚀 Clicking Submit...');
    // Clicking the "Sign In" button inside the modal
    await page.getByRole('button', { name: 'Sign in' }).last().click();

    // Instead of waiting for a URL change (which might not happen in a modal),
    // we wait for the "Login" network request to finish successfully.
    console.log('📡 Waiting for API authentication...');
    await page.waitForResponse(resp => resp.url().includes('graphql') && resp.status() === 200);

    // Give it a second to let cookies settle
    await page.waitForTimeout(3000);

    const hasSessionId = await waitForSessionId();
    if (!hasSessionId) {
      console.error('❌ sessionid cookie not detected after login; not saving state.');
      await page.screenshot({ path: path.join(dir, 'session-missing.png') });
      process.exitCode = 1;
      return;
    }

    await context.storageState({ path: STATE_PATH });
    console.log('✅ Success! Master key saved to data/padsplit-state.json');

  } catch (error) {
    console.error('❌ Error:', error.message);
    await page.screenshot({ path: 'data/error.png' });
  } finally {
    await browser.close();
    process.exit();
  }
})();
