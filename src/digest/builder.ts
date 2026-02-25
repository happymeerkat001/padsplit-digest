// PASS 4 — Identify the Dominant Responsibility

// This is where you stop labeling lines
// and start summarizing the file.

// You are no longer asking:
// “What does this line do?”

// You are asking:
// “What is this file primarily responsible for?”

// ⸻

// 🔎 After Imports + Orchestrator + Line Labels

// You now ask 5 structural questions.

// ⸻

// 1️⃣ Does this file own state?

// Scan top-level (outside functions).

// Look for:
// 	•	let x =
// 	•	const x = new Map()
// 	•	const cache = {}
// 	•	let db =
// 	•	anything mutable at module scope

// If yes:
// → It owns state.

// If no:
// → It does not own persistent state.

// That’s the first architectural classification.

// ⸻

// 2️⃣ Does it define a lifecycle?

// Lifecycle = create → use → close.

// Example:
// 	•	open DB
// 	•	use DB
// 	•	close DB

// If yes:
// → Resource manager / state owner.

// ⸻

// 3️⃣ Is there exactly one “big” exported function?

// If yes:
// → Likely orchestrator file.

// Especially if:
// 	•	async
// 	•	calls multiple helpers
// 	•	triggers IO

// ⸻

// 4️⃣ Are most functions pure helpers?

// If yes:
// → It is a computation + orchestration blend.

// ⸻

// 5️⃣ What would break if this file disappeared?

// This is the fastest dominance detector.

// Ask:
// If I delete this file, what collapses?
// 	•	DB system? → state owner
// 	•	Digest flow? → orchestrator
// 	•	Rendering only? → computation layer
// 	•	Logging system? → tell layer

// That tells you what it truly owns.
// You’re slightly over-classifying things as “output”.

// There are three output types:
// 	1.	Write (persistent)
// 	2.	Tell (observable)
// 	3.	Control (return/throw)

// But only write and tell cross boundaries.

// Return does not cross external boundary.

// It only transfers to caller.

// ⸻

// Now Re-evaluate Your File Summary

// You concluded:

// • No state owner
// • Orchestrator
// • Digest flow responsibility

// That’s correct.

// Now compress it:

// This file orchestrates digest generation by coordinating DB reads, HTML rendering, filesystem writes, optional email sending, and returning execution status.

// That’s the architectural takeaway.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'; // output - write to filesystem. 
import { resolve } from 'node:path'; // output - 
import { createHash } from 'node:crypto';
import { createDigest, getVisibleClassifiedItems, markItemsSent, type DigestItem } from '../db/items.js';
import { config } from '../config.js'; // input - external configuration that influences how the digest is built and sent, including sender categories, schedule timezone, and email sending settings
import { logger } from '../utils/logger.js'; // output - logging to console or file for observability of the digest building process
import { sendDigestEmail } from '../gmail/send.js'; // output - write to external system (Gmail API) to send the digest email
import type { ThermostatReading } from '../scraper/honeywell.js'; // inpute - external data structure representing thermostat readings that can be included in the digest report, allowing for integration of additional data sources into the report beyond just email items

interface SenderGroup {
  key: string;
  label: string;
  items: DigestItem[];
}

function groupBySenderCategory(items: DigestItem[]): SenderGroup[] { // computation - pure function that transforms a flat list of digest items into categorized groups based on sender email, using the configuration to determine which senders belong to which categories, and returning an array of sender groups with their associated items for rendering in the digest report
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

function readDeployMetaLocalized(): string | null {
  const deployMetaPath = resolve(process.cwd(), 'public', 'deploy-meta.json');
  if (!existsSync(deployMetaPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(deployMetaPath, 'utf-8')) as { deployedAt?: unknown };
    if (typeof parsed.deployedAt !== 'string') {
      return null;
    }

    const deployedAt = new Date(parsed.deployedAt);
    if (Number.isNaN(deployedAt.getTime())) {
      return null;
    }

    return deployedAt.toLocaleString('en-US', {
      timeZone: config.schedule.timezone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
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

function renderThermostatSection(readings: ThermostatReading[]): string { // 
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
  const deployedAt = readDeployMetaLocalized();

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
      ${deployedAt ? `<p class="meta">Deployed: ${escapeHtml(deployedAt)}</p>` : ''}
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

export async function buildAndSendDigest( // Orchestration - coordinates the entire digest building and sending process, acting as the main function that ties together data retrieval, transformation, persistence, and optional email sending based on configuration and command-line arguments
  thermostatReadings: ThermostatReading[] = []
): Promise<{ sent: boolean; itemCount: number; reportPath: string }> {
const items = getVisibleClassifiedItems(
  config.digest.visibilityWindowHours
);  const groups = groupBySenderCategory(items);  

  const now = new Date(); // input -external data representing the current date and time, used for timestamping the generated digest report and determining which items to include based on their received time, as well as for formatting the report header with the generation time in the configured timezone
  const html = buildDigestHtml(groups, thermostatReadings, now); // computation - transforms the grouped items and thermostat readings into a complete HTML document representing the digest report, applying styling and formatting to create a visually organized summary of the day's activity that can be saved as a file and optionally sent via email
  const reportPath = writeDigestReport(html, now); // output - writes the generated HTML digest report to the filesystem, creating a new file with a timestamped name in the 'out' directory, and returns the path to the saved report for logging and potential inclusion in the email summary, ensuring that there is a persistent record of the generated digest that can be accessed later if needed
  const urgentCount = items.filter((item) => item.urgency === 'high').length;
  const itemIds = items.map((item) => item.id).filter((id): id is number => Number.isInteger(id));
  const visibleItemsHash = createHash('sha256')
    .update(JSON.stringify(itemIds))
    .digest('hex');
  const emailSendExplicitlyEnabled =
    config.runtime.enableEmailSending && process.argv.includes('--send-email'); // internal input - checks both configuration and command-line arguments to determine whether the digest email should actually be sent, allowing for flexibility in running the digest generation process without sending emails (e.g., for testing or manual review) while still providing an easy way to enable email sending when desired by passing the appropriate flag and having the necessary configuration in place

  const digestId = createDigest({ // output - writes a new digest record to the database, capturing metadata about the generated digest such as timestamp, item count, urgent item count, recipient, and status (sent vs generated), which allows for tracking the history of generated digests and their associated items, as well as providing a reference ID that can be used to link the digest report with the specific items that were included in it when marking them as sent
    sent_at: now.toISOString(), 
    item_count: items.length,
    urgent_count: urgentCount,
    recipient: config.gmail.digestRecipient || 'local-report',
    visible_items_hash: visibleItemsHash,
    status: emailSendExplicitlyEnabled ? 'sent' : 'generated', 
  });

  if (itemIds.length > 0) {
    markItemsSent(itemIds, digestId); // output - write to database to update the status of the items that were included in the generated digest, marking them as sent and associating them with the specific digest record created for this report, which helps maintain accurate tracking of which items have been processed and included in a digest, and prevents them from being included in future digests
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

    await sendDigestEmail(subject, buildEmailSummary(groups, reportPath)); // output - write to external system (Gmail API) to send the digest email, using the generated subject and a summary of the digest content, which allows for automated delivery of the digest report to the configured recipient, providing timely insights into the day's activity without requiring manual retrieval of the report file
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
