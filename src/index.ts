import cron from 'node-cron';
import { readdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyPendingItems } from './classifier/index.js';
import { config, resolveSenderCategory, validateConfig } from './config.js';
import { firebaseDeploy, generateHistoryPage, publishToPublic } from './deploy/publish.js';
import { closeDb, getDb } from './db/init.js';
import { insertItem, itemExists } from './db/items.js';
import { buildDigest } from './digest/builder.js';
import { closeBrowser } from './scraper/browser.js';
import { scrapeCommunication, scrapeTasks } from './scraper/padsplit.js';
import { logger } from './utils/logger.js';

let lastDeployedAt = 0;
let isPipelineRunning = false;
const SCRAPER_TIMEOUT_MS = 120_000;
const OUT_DIR = resolve(process.cwd(), 'out');
const MAX_OUT_REPORT_FILES = 500;

async function withTimeout<T>(task: Promise<T>, step: string): Promise<T> {
  const timeoutToken = Symbol('timeout');
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  try {
    const result = await Promise.race([
      task,
      new Promise<typeof timeoutToken>((resolvePromise) => {
        timeoutHandle = setTimeout(() => resolvePromise(timeoutToken), SCRAPER_TIMEOUT_MS);
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

function pruneOutReports(): void {
  try {
    const reports = readdirSync(OUT_DIR)
      .filter((name) => /^digest-\d{8}-\d{6}\.html$/.test(name))
      .sort((a, b) => b.localeCompare(a));

    const stale = reports.slice(MAX_OUT_REPORT_FILES);
    for (const filename of stale) {
      try {
        unlinkSync(resolve(OUT_DIR, filename));
      } catch {
        // Ignore per-file cleanup failures.
      }
    }

    if (stale.length > 0) {
      logger.info(`Pruned ${stale.length} old out reports`);
    }
  } catch {
    // out/ may not exist yet.
  }
}

async function runPipeline(): Promise<void> {
  const startedAt = Date.now();
  logger.info('Pipeline started');

  try {
    logger.info('Step 1: Scraping PadSplit communication and tasks');

    let communicationItems: Awaited<ReturnType<typeof scrapeCommunication>> = [];
    let taskItems: Awaited<ReturnType<typeof scrapeTasks>> = [];

    try {
      communicationItems = await withTimeout(scrapeCommunication(), 'scrapeCommunication()');
    } catch (err) {
      logger.error('Communication scrape failed; continuing', { error: String(err) });
    }

    try {
      taskItems = await withTimeout(scrapeTasks(), 'scrapeTasks()');
    } catch (err) {
      logger.error('Tasks scrape failed; continuing', { error: String(err) });
    }

    const scrapedItems = [...communicationItems, ...taskItems];
    let newItems = 0;

    for (const item of scrapedItems) {
      if (itemExists(item.messageId)) {
        continue;
      }

      insertItem({
        source: resolveSenderCategory(item.senderName),
        sender_email: item.senderName,
        external_id: item.messageId,
        subject: item.subject,
        body_raw: item.body,
        link_url: item.messageUrl,
        received_at: item.timestamp,
        status: 'pending',
        resolved_flag: 1,
      });

      newItems += 1;
    }

    logger.info('PadSplit ingestion complete', {
      communication: communicationItems.length,
      tasks: taskItems.length,
      fetched: scrapedItems.length,
      inserted: newItems,
    });

    logger.info('Step 2: Classifying pending messages');
    const classified = await classifyPendingItems();

    logger.info('Step 3: Building digest report');
    const digest = await buildDigest(newItems);

    let published = { latestPath: '', archivePath: '' };
    let historyPath = '';
    const deploySkipped = process.argv.includes('--no-deploy');
    let deployed = false;
    let deployIntervalMinutes = config.digest.deployIntervalMinutes;

    if (!Number.isFinite(deployIntervalMinutes) || deployIntervalMinutes <= 0) {
      deployIntervalMinutes = 30;
    }

    if (digest.reportPath) {
      logger.info('Step 4: Publishing to Firebase Hosting');
      published = publishToPublic(digest.reportPath);
      historyPath = generateHistoryPage();
      pruneOutReports();

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
    } else {
      logger.info('Step 4: Skipped - digest unchanged');
      logger.info('Skipped no-op digest publish/deploy', { itemCount: digest.itemCount });
    }

    logger.info('Pipeline complete', {
      durationMs: Date.now() - startedAt,
      communicationScraped: communicationItems.length,
      tasksScraped: taskItems.length,
      inserted: newItems,
      classified,
      digestItemCount: digest.itemCount,
      reportPath: digest.reportPath,
      publicLatestPath: published.latestPath,
      publicArchivePath: published.archivePath,
      historyPath,
      deployed,
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
  await closeBrowser();
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
  await closeBrowser();
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
