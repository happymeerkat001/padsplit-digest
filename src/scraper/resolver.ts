import { isLoggedIn, closeBrowser } from './browser.js';
import { scrapeMessagePage } from './padsplit.js';
import { getPendingItems, updateItemResolved } from '../db/items.js';
import { logger } from '../utils/logger.js';

// Resolve link-only emails by scraping PadSplit
export async function resolveLinks(): Promise<number> {
  // Check login status first
  const loggedIn = await isLoggedIn();
  if (!loggedIn) {
    logger.error('Not logged into PadSplit', {
      hint: 'Run: npm run setup:padsplit',
    });
    return 0;
  }

  // Get items with links that need resolution
  const items = getPendingItems().filter(
    (item) => item.link_url && !item.body_resolved
  );

  if (items.length === 0) {
    logger.info('No links to resolve');
    return 0;
  }

  logger.info('Resolving links', { count: items.length });

  let resolved = 0;

  for (const item of items) {
    if (!item.link_url || !item.id) continue;

    try {
      const scraped = await scrapeMessagePage(item.link_url);

      if (scraped?.messageContent) {
        updateItemResolved(item.id, scraped.messageContent);
        resolved++;

        logger.info('Resolved link', {
          id: item.id,
          tenant: scraped.tenantName,
          contentLength: scraped.messageContent.length,
        });
      }
    } catch (err) {
      logger.error('Failed to resolve link', {
        id: item.id,
        url: item.link_url,
        error: String(err),
      });
    }

    // Rate limit
    await new Promise((r) => setTimeout(r, 1500));
  }

  logger.info('Link resolution complete', { resolved, total: items.length });

  return resolved;
}

// Cleanup browser on shutdown
export async function cleanup(): Promise<void> {
  await closeBrowser();
}
