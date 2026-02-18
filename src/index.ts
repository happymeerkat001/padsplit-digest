import cron from 'node-cron';
import { config, validateConfig } from './config.js';
import { closeDb, getDb } from './db/init.js';
import { insertItem, itemExists } from './db/items.js';
import { classifyPendingItems } from './classifier/index.js';
import { buildAndSendDigest } from './digest/builder.js';
import { fetchPadSplitEmails, isLinkOnlyEmail } from './gmail/fetch.js';
import { cleanup as cleanupScraper, resolveLinks } from './scraper/resolver.js';
import { hasHoneywellCredentials, scrapeHoneywellThermostats } from './scraper/honeywell.js';
import { logger } from './utils/logger.js';

async function runPipeline(): Promise<void> {
  const startedAt = Date.now();
  logger.info('Pipeline started');

  try {
    logger.info('Step 1: Fetching PadSplit emails from Gmail');
    let emails: Awaited<ReturnType<typeof fetchPadSplitEmails>> = [];
    let newItems = 0;

    try {
      emails = await fetchPadSplitEmails();

      for (const email of emails) {
        if (itemExists(email.id)) {
          continue;
        }

        insertItem({
          source: email.source,
          sender_email: email.senderEmail,
          external_id: email.id,
          subject: email.subject,
          body_raw: email.body,
          link_url: isLinkOnlyEmail(email) ? email.links[0] : undefined,
          received_at: email.receivedAt,
        });

        newItems += 1;
      }
    } catch (err) {
      logger.error('Gmail fetch failed; continuing with existing data', { error: String(err) });
    }

    logger.info('Email ingestion complete', { fetched: emails.length, inserted: newItems });

    logger.info('Step 2: Resolving link-only emails via PadSplit Playwright session');
    let resolved = 0;
    try {
      resolved = await resolveLinks();
    } catch (err) {
      logger.error('Link resolution failed; continuing without resolved content', {
        error: String(err),
      });
    }

    logger.info('Step 3: Classifying pending messages');
    const classified = await classifyPendingItems();

    logger.info('Step 4: Scraping Honeywell thermostat data');
    const honeywellConfigured = hasHoneywellCredentials();
    const thermostats = honeywellConfigured ? await scrapeHoneywellThermostats() : [];
    if (!honeywellConfigured) {
      logger.warn('Honeywell credentials not configured. Thermostat section will be empty.');
    }

    logger.info('Step 5: Building digest report');
    const digest = await buildAndSendDigest(thermostats);

    logger.info('Pipeline complete', {
      durationMs: Date.now() - startedAt,
      fetched: emails.length,
      inserted: newItems,
      resolved,
      classified,
      thermostatReadings: thermostats.length,
      digestSent: digest.sent,
      digestItemCount: digest.itemCount,
      reportPath: digest.reportPath,
    });
  } catch (err) {
    logger.error('Pipeline failed', { error: String(err) });
    throw err;
  }
}

async function runOnce(): Promise<void> {
  logger.info('Running one digest cycle');
  await runPipeline();
  await cleanupScraper();
  closeDb();
}

function startScheduler(): void {
  const { digestTimes, timezone } = config.schedule;

  logger.info('Starting scheduler', { digestTimes, timezone });

  for (const cronExpression of digestTimes) {
    cron.schedule(
      cronExpression,
      async () => {
        try {
          await runPipeline();
        } catch (err) {
          logger.error('Scheduled run failed', { error: String(err), cronExpression });
        }
      },
      { timezone }
    );
  }

  logger.info('Scheduler active');
}

async function main(): Promise<void> {
  logger.info('PadSplit Digest booting', { dbPath: config.db.path });

  const warnings = validateConfig();
  if (warnings.length > 0) {
    logger.warn('Configuration warnings', { warnings });
  }

  try {
    getDb();
    logger.info('Database initialized', { path: config.db.path });
  } catch (err) {
    logger.fatal('Failed to initialize database', { error: String(err) });
    process.exit(1);
  }

  if (process.argv.includes('--once') || process.argv.includes('--run')) {
    await runOnce();
    return;
  }

  startScheduler();
}

async function shutdown(): Promise<void> {
  logger.info('Shutting down');
  await cleanupScraper();
  closeDb();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled rejection', { error: String(err) });
});

process.on('uncaughtException', (err) => {
  logger.fatal('Uncaught exception', { error: String(err) });
  process.exit(1);
});

main().catch((err) => {
  logger.fatal('Startup failure', { error: String(err) });
  process.exit(1);
});
