import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { logger } from '../utils/logger.js';

const PUBLIC_DIR = resolve(process.cwd(), 'public');
const ARCHIVES_DIR = resolve(PUBLIC_DIR, 'archives');
const DEPLOY_META_PATH = resolve(PUBLIC_DIR, 'deploy-meta.json');
const MAX_ARCHIVE_FILES = 500;

function writeDeployMeta(deployedAt: string): void {
  mkdirSync(PUBLIC_DIR, { recursive: true });
  writeFileSync(
    DEPLOY_META_PATH,
    JSON.stringify({ deployedAt }, null, 2),
    'utf-8'
  );
}

function parseTimestampFromFilename(filename: string): string {
  const match = filename.match(/^digest-(\d{8})-(\d{6})\.html$/);
  if (!match || !match[1] || !match[2]) {
    return filename;
  }

  const datePart = match[1];
  const timePart = match[2];

  const year = Number.parseInt(datePart.slice(0, 4), 10);
  const month = Number.parseInt(datePart.slice(4, 6), 10) - 1;
  const day = Number.parseInt(datePart.slice(6, 8), 10);
  const hour = Number.parseInt(timePart.slice(0, 2), 10);
  const minute = Number.parseInt(timePart.slice(2, 4), 10);
  const second = Number.parseInt(timePart.slice(4, 6), 10);

  const date = new Date(year, month, day, hour, minute, second);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function publishToPublic(reportPath: string): {
  latestPath: string;
  archivePath: string;
} {
  if (!existsSync(reportPath)) {
    throw new Error(`Digest report not found: ${reportPath}`);
  }

  mkdirSync(ARCHIVES_DIR, { recursive: true });

  const filename = basename(reportPath);
  const latestPath = resolve(PUBLIC_DIR, 'index.html');
  const archivePath = resolve(ARCHIVES_DIR, filename);

  copyFileSync(reportPath, latestPath);
  copyFileSync(reportPath, archivePath);

  logger.info('Published digest to public directory', {
    reportPath,
    latestPath,
    archivePath,
  });

  return { latestPath, archivePath };
}

export function generateHistoryPage(): string {
  mkdirSync(ARCHIVES_DIR, { recursive: true });

  const archives = readdirSync(ARCHIVES_DIR)
    .filter((name) => /^digest-\d{8}-\d{6}\.html$/.test(name))
    .sort((a, b) => b.localeCompare(a));

  const kept = archives.slice(0, MAX_ARCHIVE_FILES);
  const stale = archives.slice(MAX_ARCHIVE_FILES);

  for (const filename of stale) {
    try {
      unlinkSync(resolve(ARCHIVES_DIR, filename));
    } catch {
      // File already removed or inaccessible - skip.
    }
  }

  if (stale.length > 0) {
    logger.info(`Pruned ${stale.length} old archives`);
  }

  const rows = kept
    .map((filename) => {
      const timestamp = parseTimestampFromFilename(filename);
      return `<li><a href="/archives/${filename}">${timestamp}</a></li>`;
    })
    .join('\n');

  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PadSplit Digest History</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --card: #ffffff;
      --text: #1e293b;
      --muted: #64748b;
      --line: #dce3ea;
      --accent: #0f766e;
    }
    body { margin: 0; padding: 24px; background: var(--bg); color: var(--text); font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif; }
    main { max-width: 900px; margin: 0 auto; }
    section { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
    h1 { margin-top: 0; }
    p { color: var(--muted); }
    ul { padding-left: 20px; }
    li { margin: 8px 0; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>PadSplit Digest History</h1>
      <p><a href="/">View Latest Digest</a></p>
      <ul>
        ${rows || '<li>No digest archives yet.</li>'}
      </ul>
    </section>
  </main>
</body>
</html>`;

  const historyPath = resolve(PUBLIC_DIR, 'history.html');
  writeFileSync(historyPath, body, 'utf-8');

  logger.info('Generated digest history page', {
    historyPath,
    archiveCount: kept.length,
  });

  return historyPath;
}

export function firebaseDeploy(): boolean {
  try {
    logger.info('Deploying Firebase Hosting');
    execSync('firebase deploy --only hosting', { stdio: 'inherit' });
    writeDeployMeta(new Date().toISOString());
    logger.info('Firebase Hosting deploy complete');
    return true;
  } catch (err) {
    logger.error('Firebase deploy failed - digest was generated but not published', {
      error: String(err),
    });
    return false;
  }
}
