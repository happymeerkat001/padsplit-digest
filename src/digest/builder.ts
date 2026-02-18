import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDigest, getUnsentClassifiedItems, markItemsSent, type DigestItem } from '../db/items.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { sendDigestEmail } from '../gmail/send.js';
import type { ThermostatReading } from '../scraper/honeywell.js';

interface SenderGroup {
  key: string;
  label: string;
  items: DigestItem[];
}

function groupBySenderCategory(items: DigestItem[]): SenderGroup[] {
  const groupMap = new Map<string, SenderGroup>();

  for (const category of config.senderCategories) {
    groupMap.set(category.key, {
      key: category.key,
      label: category.label,
      items: [],
    });
  }

  for (const item of items) {
    const key = groupMap.has(item.source) ? item.source : 'others';
    const group = groupMap.get(key);
    if (!group) {
      continue;
    }
    group.items.push(item);
  }

  return config.senderCategories
    .map((category) => groupMap.get(category.key))
    .filter((group): group is SenderGroup => Boolean(group));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTimestampForFile(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');

  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function renderItems(group: SenderGroup): string {
  if (group.items.length === 0) {
    return '<p class="empty">No items in this category.</p>';
  }

  const rows = group.items.map((item) => {
    const subject = escapeHtml(item.subject || '(No subject)');
    const sender = escapeHtml(item.sender_email || item.source || 'unknown');
    const intent = escapeHtml(item.intent || 'unknown');
    const urgency = escapeHtml(item.urgency || 'medium');
    const receivedAt = new Date(item.received_at).toLocaleString('en-US', {
      timeZone: config.schedule.timezone,
    });

    return `<tr>
      <td class="subject">${subject}</td>
      <td>${sender}</td>
      <td>${intent}</td>
      <td>${urgency}</td>
      <td>${escapeHtml(receivedAt)}</td>
    </tr>`;
  });

  return `<table>
    <thead>
      <tr>
        <th>Subject</th>
        <th>Sender</th>
        <th>Intent</th>
        <th>Urgency</th>
        <th>Received (${escapeHtml(config.schedule.timezone)})</th>
      </tr>
    </thead>
    <tbody>
      ${rows.join('\n')}
    </tbody>
  </table>`;
}

function renderThermostatSection(readings: ThermostatReading[]): string {
  if (readings.length === 0) {
    return `
      <section>
        <h2>Thermostat Status</h2>
        <p class="empty">No thermostat readings available.</p>
      </section>
    `;
  }

  const items = readings.map((reading) => {
    const updated = reading.lastUpdated ? ` - Updated ${escapeHtml(reading.lastUpdated)}` : '';
    return `<li><strong>${escapeHtml(reading.name)}</strong>: ${reading.currentTemp}°F (set: ${reading.setpoint}°F, mode: ${escapeHtml(reading.mode)})${updated}</li>`;
  });

  return `
    <section>
      <h2>Thermostat Status</h2>
      <ul>
        ${items.join('\n')}
      </ul>
    </section>
  `;
}

function buildDigestHtml(groups: SenderGroup[], thermostatReadings: ThermostatReading[], now: Date): string {
  const totalItems = groups.reduce((sum, group) => sum + group.items.length, 0);
  const urgentCount = groups.reduce(
    (sum, group) => sum + group.items.filter((item) => item.urgency === 'high').length,
    0
  );

  const generatedAt = now.toLocaleString('en-US', {
    timeZone: config.schedule.timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  const sections = groups.map((group) => `
    <section>
      <h2>${escapeHtml(group.label)} (${group.items.length})</h2>
      ${renderItems(group)}
    </section>
  `);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PadSplit Daily Digest</title>
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
    body {
      margin: 0;
      padding: 24px;
      background: var(--bg);
      color: var(--text);
      font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
    }
    main {
      max-width: 1100px;
      margin: 0 auto;
    }
    header {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 18px 20px;
      margin-bottom: 16px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 1.4rem;
    }
    .meta {
      color: var(--muted);
      margin: 0;
      font-size: 0.95rem;
    }
    section {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 14px 16px;
      margin-bottom: 14px;
    }
    h2 {
      margin: 0 0 10px;
      font-size: 1.05rem;
      color: var(--accent);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.93rem;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 8px;
      text-align: left;
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-weight: 600;
      background: #fbfcfd;
    }
    .subject {
      font-weight: 600;
      min-width: 260px;
    }
    ul {
      margin: 0;
      padding-left: 20px;
    }
    li {
      margin: 6px 0;
    }
    .empty {
      color: var(--muted);
      margin: 0;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>PadSplit Daily Digest</h1>
      <p class="meta">Generated ${escapeHtml(generatedAt)} (${escapeHtml(config.schedule.timezone)})</p>
      <p class="meta">Total items: ${totalItems} | Urgent items: ${urgentCount}</p>
    </header>
    ${sections.join('\n')}
    ${renderThermostatSection(thermostatReadings)}
  </main>
</body>
</html>`;
}

function writeDigestReport(html: string, now: Date): string {
  const outDir = resolve(process.cwd(), 'out');
  mkdirSync(outDir, { recursive: true });

  const timestamp = formatTimestampForFile(now);
  const outputPath = resolve(outDir, `digest-${timestamp}.html`);

  writeFileSync(outputPath, html, 'utf-8');
  return outputPath;
}

function buildEmailSummary(groups: SenderGroup[], reportPath: string): string {
  const lines: string[] = ['PadSplit Daily Digest generated.', '', `Report: ${reportPath}`, ''];

  for (const group of groups) {
    lines.push(`${group.label}: ${group.items.length}`);
  }

  return lines.join('\n');
}

export async function buildAndSendDigest(
  thermostatReadings: ThermostatReading[] = []
): Promise<{ sent: boolean; itemCount: number; reportPath: string }> {
  const items = getUnsentClassifiedItems();
  const groups = groupBySenderCategory(items);

  const now = new Date();
  const html = buildDigestHtml(groups, thermostatReadings, now);
  const reportPath = writeDigestReport(html, now);
  const urgentCount = items.filter((item) => item.urgency === 'high').length;
  const emailSendExplicitlyEnabled =
    config.runtime.enableEmailSending && process.argv.includes('--send-email');

  const digestId = createDigest({
    sent_at: now.toISOString(),
    item_count: items.length,
    urgent_count: urgentCount,
    recipient: config.gmail.digestRecipient || 'local-report',
    status: emailSendExplicitlyEnabled ? 'sent' : 'generated',
  });

  const itemIds = items.map((item) => item.id).filter((id): id is number => Number.isInteger(id));
  if (itemIds.length > 0) {
    markItemsSent(itemIds, digestId);
  }

  logger.info('Digest report written', {
    reportPath,
    itemCount: items.length,
    thermostatCount: thermostatReadings.length,
    digestId,
  });

  if (emailSendExplicitlyEnabled && config.gmail.digestRecipient) {
    const subjectDate = now.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: config.schedule.timezone,
    });
    const subject = `PadSplit Digest - ${subjectDate}`;

    await sendDigestEmail(subject, buildEmailSummary(groups, reportPath));
    logger.info('Digest email sent', { recipient: config.gmail.digestRecipient });
    return { sent: true, itemCount: items.length, reportPath };
  }

  logger.info('Digest email sending skipped', {
    enabled: emailSendExplicitlyEnabled,
    hasRecipient: Boolean(config.gmail.digestRecipient),
    hint: 'Pass --send-email and set ENABLE_EMAIL_SENDING=true to enable delivery',
  });

  return { sent: false, itemCount: items.length, reportPath };
}
