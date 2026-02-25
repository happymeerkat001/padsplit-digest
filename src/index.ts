import cron from 'node-cron';
import { config, validateConfig } from './config.js';
import { closeDb, getDb } from './db/init.js';
import { insertItem, itemExists } from './db/items.js';
import { classifyPendingItems } from './classifier/index.js';
import { buildAndSendDigest } from './digest/builder.js';
import { fetchPadSplitEmails, isLinkOnlyEmail } from './gmail/fetch.js';
import { cleanup as cleanupScraper, resolveLinks } from './scraper/resolver.js';
import {
  closeHoneywellBrowserContext,
  hasHoneywellCredentials,
  scrapeHoneywellThermostats,
} from './scraper/honeywell.js';
import { firebaseDeploy, generateHistoryPage, publishToPublic } from './deploy/publish.js';
import { logger } from './utils/logger.js';

let lastDeployedAt = 0;
let isPipelineRunning = false;
const SCRAPER_TIMEOUT_MS = 120_000;

async function withTimeout<T>(task: Promise<T>, step: string): Promise<T> {
  const timeoutToken = Symbol('timeout');
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  try {
    const result = await Promise.race([
      task,
      new Promise<typeof timeoutToken>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(timeoutToken), SCRAPER_TIMEOUT_MS);
      }),
    ]);

    if (result === timeoutToken) {
      const timeoutError = new Error(`${step} timed out after ${SCRAPER_TIMEOUT_MS}ms`);
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    }

    return result;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

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
      resolved = await withTimeout(resolveLinks(), 'resolveLinks()');
    } catch (err) {
      if (isTimeoutError(err)) {
        logger.warn(`resolveLinks() timed out after ${SCRAPER_TIMEOUT_MS}ms; continuing pipeline`);
        try {
          await cleanupScraper();
        } catch (cleanupErr) {
          logger.warn('Failed to close PadSplit browser context after timeout', {
            error: String(cleanupErr),
          });
        }
      } else {
        logger.error('Link resolution failed; continuing without resolved content', {
          error: String(err),
        });
      }
    }

    logger.info('Step 3: Classifying pending messages');
    const classified = await classifyPendingItems();

    logger.info('Step 4: Scraping Honeywell thermostat data');
    const honeywellConfigured = hasHoneywellCredentials();
    let thermostats: Awaited<ReturnType<typeof scrapeHoneywellThermostats>> = [];
    if (honeywellConfigured) {
      try {
        thermostats = await withTimeout(
          scrapeHoneywellThermostats(),
          'Honeywell scraping'
        );
      } catch (err) {
        if (isTimeoutError(err)) {
          logger.warn(`Honeywell scraping timed out after ${SCRAPER_TIMEOUT_MS}ms; continuing pipeline`);
          try {
            await closeHoneywellBrowserContext();
          } catch (cleanupErr) {
            logger.warn('Failed to close Honeywell browser context after timeout', {
              error: String(cleanupErr),
            });
          }
        } else {
          logger.error('Honeywell scrape failed; continuing without thermostat data', {
            error: String(err),
          });
        }
      }
    } else {
      logger.warn('Honeywell credentials not configured. Thermostat section will be empty.');
    }

    logger.info('Step 5: Building digest report');
    const digest = await buildAndSendDigest(thermostats);

    logger.info('Step 6: Publishing to Firebase Hosting');
    const published = publishToPublic(digest.reportPath);
    const historyPath = generateHistoryPage();

    const deploySkipped = process.argv.includes('--no-deploy');
    let deployed = false;
    let deployIntervalMinutes = config.digest.deployIntervalMinutes;

    if (!Number.isFinite(deployIntervalMinutes) || deployIntervalMinutes <= 0) {
      deployIntervalMinutes = 30;
    }

    if (deploySkipped) {
      logger.info('Firebase deploy skipped (--no-deploy flag present)');
    } else {
      const msSinceDeploy = Date.now() - lastDeployedAt;
      const deployIntervalMs = deployIntervalMinutes * 60_000;

      if (msSinceDeploy >= deployIntervalMs) {
        deployed = firebaseDeploy();
        if (deployed) {
          lastDeployedAt = Date.now();
        }
      } else {
        const nextIn = Math.ceil((deployIntervalMs - msSinceDeploy) / 60_000);
        logger.info(`Firebase deploy throttled - next deploy in ~${nextIn} min`);
      }
    }

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
      publicLatestPath: published.latestPath,
      publicArchivePath: published.archivePath,
      historyPath,
      deployed,
      deployIntervalMinutes,
      deploySkipped,
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
        if (isPipelineRunning) {
          logger.info('Skipping cycle - previous run still active');
          return;
        }

        isPipelineRunning = true;

        try {
          await runPipeline();
        } catch (err) {
          logger.error('Scheduled run failed', { error: String(err), cronExpression });
        } finally {
          isPipelineRunning = false;
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
