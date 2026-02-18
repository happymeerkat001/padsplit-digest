import { getBrowserContext } from './browser.js';
import { logger } from '../utils/logger.js';

export interface ScrapedMessage {
  url: string;
  tenantName: string;
  houseAddress: string;
  messageContent: string;
  timestamp: string;
}

// Navigate to a PadSplit message URL and extract content
export async function scrapeMessagePage(url: string): Promise<ScrapedMessage | null> {
  const context = await getBrowserContext();
  const page = await context.newPage();

  try {
    logger.info('Scraping message page', { url });

    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Check if we got redirected to login
    if (page.url().includes('login') || page.url().includes('signin')) {
      logger.error('Session expired - redirected to login', { url });
      return null;
    }

    // Wait for message content to load
    await page.waitForSelector('[data-testid="message-content"], .message-content, .chat-message', {
      timeout: 10000,
    }).catch(() => {
      // Selector might vary, continue anyway
    });

    // Extract message details - selectors may need adjustment based on actual PadSplit UI
    const result = await page.evaluate(() => {
      // Try multiple selector strategies
      const selectors = {
        tenantName: [
          '[data-testid="tenant-name"]',
          '.tenant-name',
          '.sender-name',
          'h1',
          '.member-name',
        ],
        houseAddress: [
          '[data-testid="property-address"]',
          '.property-address',
          '.house-address',
          '.location',
        ],
        messageContent: [
          '[data-testid="message-content"]',
          '.message-content',
          '.chat-message',
          '.message-body',
          '.conversation-message',
        ],
        timestamp: [
          '[data-testid="message-timestamp"]',
          '.message-timestamp',
          '.timestamp',
          'time',
        ],
      };

      const findText = (selectorList: string[]): string => {
        for (const selector of selectorList) {
          const el = document.querySelector(selector);
          if (el?.textContent?.trim()) {
            return el.textContent.trim();
          }
        }
        return '';
      };

      // Get all message text if in a conversation view
      const allMessages = Array.from(
        document.querySelectorAll('.message-content, .chat-message, [class*="message"]')
      )
        .map((el) => el.textContent?.trim())
        .filter(Boolean)
        .join('\n\n');

      return {
        tenantName: findText(selectors.tenantName),
        houseAddress: findText(selectors.houseAddress),
        messageContent: allMessages || findText(selectors.messageContent),
        timestamp: findText(selectors.timestamp),
      };
    });

    if (!result.messageContent) {
      logger.warn('No message content found', { url });
      // Take a screenshot for debugging
      await page.screenshot({ path: './data/debug-scrape.png' });
    }

    return {
      url,
      tenantName: result.tenantName || 'Unknown',
      houseAddress: result.houseAddress || 'Unknown',
      messageContent: result.messageContent || '',
      timestamp: result.timestamp || new Date().toISOString(),
    };
  } catch (err) {
    logger.error('Failed to scrape message', { url, error: String(err) });
    return null;
  } finally {
    await page.close();
  }
}

// Batch scrape multiple URLs
export async function scrapeMessages(urls: string[]): Promise<Map<string, ScrapedMessage>> {
  const results = new Map<string, ScrapedMessage>();

  for (const url of urls) {
    const message = await scrapeMessagePage(url);
    if (message) {
      results.set(url, message);
    }

    // Small delay between requests to be polite
    await new Promise((r) => setTimeout(r, 1000));
  }

  logger.info('Scraping complete', {
    requested: urls.length,
    successful: results.size,
  });

  return results;
}
