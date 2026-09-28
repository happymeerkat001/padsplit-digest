

import { createHash } from 'node:crypto'; //computation/transformation
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'; // boudary in/out 
import { resolve } from 'node:path'; // computation/transformation
import { config } from '../config.js'; // memory store
import {
  createDigest,
  getLastDigestHash,
  getVisibleClassifiedItems,
  markItemsSent,
  type DigestItem,
} from '../db/items.js'; // boundary in/out
import { logger } from '../utils/logger.js'; // boundary out

export interface SenderGroup {
  key: string;
  label: string;
  items: DigestItem[];
}

export type DigestRenderMode = 'local' | 'public';

const TASK_COLUMNS = [
  { status: 'Requests', color: '#555555' },
  { status: 'Open', color: '#0067c7' },
  { status: 'In Progress', color: '#ecbc3e' },
  { status: 'On Hold', color: '#d00000' },
  { status: 'Complete', color: '#128050' },
] as const;

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

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit - 1)}...`;
}

function parseTaskDetails(item: DigestItem): {
  taskType: string;
  room: string;
  description: string;
  status: string;
} {
  const lines = (item.body_raw || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  let status = '';
  const content = lines.filter((line) => {
    if (line.toLowerCase().startsWith('status:')) {
      status = line.replace(/^status:\s*/i, '').trim();
      return false;
    }
    return true;
  });

  return {
    taskType: content[0] || '(No type)',
    room: content[1] || '',
    description: content.slice(2).join(' ') || '(No description)',
    status: status || 'Other',
  };
}

/**
 * Public digest policy (files copied to public/ and Firebase Hosting only).
 *
 * Kept:
 * - Counts: total, urgent, per-section, and per-status task counts.
 * - Known status labels (Open, In Progress, and the other fixed columns). They are
 *   count buckets. Unrecognized status text is counted under "Other" and not printed.
 * - Ticket subject (`item.subject`) when it is not copied from body_raw, sender_email,
 *   or tenant_name. The ticket adapter stores the property address in subject.
 * - Task type only for the structured label this codebase writes ("Type: Maintenance Ticket").
 *   Any other first body line is free text and is dropped.
 * - Room only when it matches a short room-label allowlist ("Bedroom", "Room 2", ...).
 *   parseTaskDetails reads room from body line 2. The ticket adapter puts the free-text
 *   ticket description in that slot, so those values fail the allowlist and are omitted.
 *
 * Omitted from the public page:
 * - Member-message rows and all other non-task rows (those sections are counts only).
 * - sender_email, tenant_name, body_raw, and the parsed description.
 *
 * Local digest HTML still renders member rows and task descriptions. Neither mode
 * embeds DIGEST_SITE_PASSWORD or SECRET_PIN.
 */
const PUBLIC_TASK_TYPES = new Set(['type: maintenance ticket']);

const PUBLIC_ROOM_LABELS = new Set([
  'bedroom',
  'bathroom',
  'kitchen',
  'living room',
  'hallway',
  'basement',
  'attic',
  'laundry',
  'common area',
  'exterior',
]);

function publicTaskType(taskType: string): string | null {
  const trimmed = taskType.trim();
  if (!PUBLIC_TASK_TYPES.has(trimmed.toLowerCase())) {
    return null;
  }
  return trimmed;
}

function publicRoomLabel(room: string): string | null {
  const trimmed = room.trim();
  if (!trimmed) {
    return null;
  }
  if (PUBLIC_ROOM_LABELS.has(trimmed.toLowerCase())) {
    return trimmed;
  }
  if (/^room\s+[a-z0-9-]{1,8}$/i.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function publicTicketSubject(item: DigestItem): string | null {
  const subject = (item.subject || '').trim();
  if (!subject) {
    return null;
  }

  const body = item.body_raw ?? '';
  if (body.includes(subject)) {
    return null;
  }

  const identities = [item.sender_email, item.tenant_name]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  if (identities.some((value) => subject.includes(value) || value.includes(subject))) {
    return null;
  }

  return subject;
}

function publicUrgency(value: DigestItem['urgency']): string {
  if (value === 'high' || value === 'medium' || value === 'low') {
    return value;
  }
  return 'unknown';
}

function renderPublicCountOnly(group: SenderGroup): string {
  const urgent = group.items.filter((item) => item.urgency === 'high').length;
  return `<p class="meta">${group.items.length} items · ${urgent} urgent. Item details are omitted from the public digest.</p>`;
}

function renderPublicTaskBoard(group: SenderGroup): string {
  const byStatus = new Map<string, Array<{
    item: DigestItem;
    taskType: string | null;
    room: string | null;
  }>>();

  for (const item of group.items) {
    const parsed = parseTaskDetails(item);
    const statusKey = parsed.status || 'Other';
    const bucket = byStatus.get(statusKey) ?? [];
    bucket.push({
      item,
      taskType: publicTaskType(parsed.taskType),
      room: publicRoomLabel(parsed.room),
    });
    byStatus.set(statusKey, bucket);
  }

  const { taskStatuses } = config.digest;
  if (taskStatuses.length > 0) {
    const allowedStatuses = new Set(taskStatuses);
    for (const key of Array.from(byStatus.keys())) {
      if (!allowedStatuses.has(key)) {
        byStatus.delete(key);
      }
    }
  }

  const knownStatuses = new Set<string>(TASK_COLUMNS.map((column) => column.status));
  const sections: string[] = [];

  const renderCards = (
    cards: Array<{ item: DigestItem; taskType: string | null; room: string | null }>,
  ): string =>
    cards
      .map(({ item, taskType, room }) => {
        const receivedAt = new Date(item.received_at).toLocaleString('en-US', {
          timeZone: config.schedule.timezone,
        });
        const subject = publicTicketSubject(item);
        const meta = [taskType, room].filter((part): part is string => Boolean(part)).join(' | ');
        const urgency = publicUrgency(item.urgency);

        return `<div class="task-card">
  ${subject ? `<div class="task-address">${escapeHtml(subject)}</div>` : ''}
  ${meta ? `<div class="task-meta">${escapeHtml(meta)}</div>` : ''}
  <div class="task-footer">${escapeHtml(urgency)} · ${escapeHtml(receivedAt)}</div>
</div>`;
      })
      .join('\n');

  for (const column of TASK_COLUMNS) {
    const cards = byStatus.get(column.status) ?? [];
    if (cards.length === 0) {
      continue;
    }

    sections.push(`<h3 style="border-left: 4px solid ${column.color}">${escapeHtml(column.status)} (${cards.length})</h3>
${renderCards(cards)}`);
  }

  const otherCards = Array.from(byStatus.entries())
    .filter(([status]) => !knownStatuses.has(status))
    .flatMap(([, cards]) => cards);

  if (otherCards.length > 0) {
    sections.push(`<h3 style="border-left: 4px solid #6b7280">Other (${otherCards.length})</h3>
${renderCards(otherCards)}`);
  }

  return `<div class="task-board">
${sections.join('\n')}
</div>`;
}

function renderPublicItems(group: SenderGroup): string {
  if (group.key !== 'tasks') {
    return renderPublicCountOnly(group);
  }
  return renderPublicTaskBoard(group);
}

function filterTaskItemsByStatus(items: DigestItem[]): DigestItem[] {
  const { taskStatuses } = config.digest;
  if (taskStatuses.length === 0) {
    return items;
  }

  const allowedStatuses = new Set(taskStatuses);
  return items.filter((item) => allowedStatuses.has(parseTaskDetails(item).status));
}

function getRenderableTasks(items: DigestItem[]): DigestItem[] {
  return items.filter((item) => {
    const { description } = parseTaskDetails(item);
    const subject = (item.subject || '').trim().toLowerCase();
    const desc = description.trim().toLowerCase();
    if (!description) return false;
    if (desc === '(no description)' || desc === 'task item') return false;
    if (subject === 'task') return false;
    return true;
  });
}

function getRecentMemberMessages(items: DigestItem[], limit = 3): DigestItem[] {
  const uniqueByContent = new Map<string, DigestItem>();
  const sorted = [...items].sort(
    (a, b) => new Date(b.received_at).getTime() - new Date(a.received_at).getTime()
  );

  for (const item of sorted) {
    const key = `${item.body_raw ?? ''}::${item.sender_email ?? item.tenant_name ?? ''}`;
    if (!uniqueByContent.has(key)) {
      uniqueByContent.set(key, item);
    }
    if (uniqueByContent.size >= limit) {
      break;
    }
  }

  return Array.from(uniqueByContent.values());
}

function renderItems(group: SenderGroup): string {
  if (group.key === 'member_messages') {
    const latestMessages = getRecentMemberMessages(group.items, 3);

    const rows = latestMessages.map((item) => {
      const member = escapeHtml(item.sender_email || 'Member');
      const property = escapeHtml(item.subject || '(No property)');
      const message = escapeHtml(truncateText(item.body_raw || '(No message)', 60));
      const urgency = escapeHtml(item.urgency || 'medium');
      const receivedAt = new Date(item.received_at).toLocaleString('en-US', {
        timeZone: config.schedule.timezone,
      });

      return `<tr>
      <td>${member}</td>
      <td class="subject">${property}</td>
      <td>${message}</td>
      <td>${urgency}</td>
      <td>${escapeHtml(receivedAt)}</td>
    </tr>`;
    });

    return `<table>
    <thead>
      <tr>
        <th>Member</th>
        <th>Property</th>
        <th>Message</th>
        <th>Urgency</th>
        <th>Received (${escapeHtml(config.schedule.timezone)})</th>
      </tr>
    </thead>
    <tbody>
      ${rows.join('\n')}
    </tbody>
  </table>`;
  }

  if (group.key === 'tasks') {
    const filteredItems = getRenderableTasks(group.items);
    const byStatus = new Map<string, Array<{
      item: DigestItem;
      taskType: string;
      room: string;
      description: string;
      status: string;
    }>>();

    for (const item of filteredItems) {
      const { taskType, room, description, status } = parseTaskDetails(item);
      const statusKey = status || 'Other';
      const bucket = byStatus.get(statusKey) ?? [];
      bucket.push({
        item,
        taskType,
        room,
        description,
        status: statusKey,
      });
      byStatus.set(statusKey, bucket);
    }

    const { taskStatuses } = config.digest;
    if (taskStatuses.length > 0) {
      const allowedStatuses = new Set(taskStatuses);
      for (const key of Array.from(byStatus.keys())) {
        if (!allowedStatuses.has(key)) {
          byStatus.delete(key);
        }
      }
    }

    const knownStatuses = new Set<string>(TASK_COLUMNS.map((column) => column.status));
    const sections: string[] = [];

    for (const column of TASK_COLUMNS) {
      const cards = byStatus.get(column.status) ?? [];
      if (cards.length === 0) {
        continue;
      }

      const renderedCards = cards.map(({ item, taskType, room, description }) => {
        const receivedAt = new Date(item.received_at).toLocaleString('en-US', {
          timeZone: config.schedule.timezone,
        });
        const meta = [taskType, room].filter(Boolean).join(' | ');
        const urgency = item.urgency || 'medium';

        return `<div class="task-card">
  <div class="task-address">${escapeHtml(item.subject || '(No address)')}</div>
  <div class="task-meta">${escapeHtml(meta || '(No type)')}</div>
  <div class="task-desc">${escapeHtml(description)}</div>
  <div class="task-footer">${escapeHtml(urgency)} · ${escapeHtml(receivedAt)}</div>
</div>`;
      });

      sections.push(`<h3 style="border-left: 4px solid ${column.color}">${escapeHtml(column.status)} (${cards.length})</h3>
${renderedCards.join('\n')}`);
    }

    const otherCards = Array.from(byStatus.entries())
      .filter(([status]) => !knownStatuses.has(status))
      .flatMap(([, cards]) => cards);

    if (otherCards.length > 0) {
      const renderedOther = otherCards.map(({ item, taskType, room, description, status }) => {
        const receivedAt = new Date(item.received_at).toLocaleString('en-US', {
          timeZone: config.schedule.timezone,
        });
        const meta = [taskType, room].filter(Boolean).join(' | ');
        const urgency = item.urgency || 'medium';
        const descriptionWithStatus = status ? `${description} (${status})` : description;

        return `<div class="task-card">
  <div class="task-address">${escapeHtml(item.subject || '(No address)')}</div>
  <div class="task-meta">${escapeHtml(meta || '(No type)')}</div>
  <div class="task-desc">${escapeHtml(descriptionWithStatus)}</div>
  <div class="task-footer">${escapeHtml(urgency)} · ${escapeHtml(receivedAt)}</div>
</div>`;
      });

      sections.push(`<h3 style="border-left: 4px solid #6b7280">Other (${otherCards.length})</h3>
${renderedOther.join('\n')}`);
    }

    return `<div class="task-board">
${sections.join('\n')}
</div>`;
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

function buildDigestHtml(groups: SenderGroup[], now: Date, mode: DigestRenderMode = 'local'): string {
  const { groups: allowedGroups } = config.digest;
  const visibleGroups = groups
    .map((group): SenderGroup => {
      if (group.key !== 'tasks') {
        if (group.key === 'member_messages') {
          return {
            ...group,
            items: getRecentMemberMessages(group.items, 3),
          };
        }
        return group;
      }

      return {
        ...group,
        items: getRenderableTasks(filterTaskItemsByStatus(group.items)),
      };
    })
    .filter((group) => group.items.length > 0)
    .filter((group) => allowedGroups.length === 0 || allowedGroups.includes(group.key));

  const totalItems = visibleGroups.reduce((sum, group) => sum + group.items.length, 0);
  const urgentCount = visibleGroups.reduce(
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

  const sections = visibleGroups.map((group) => {
    const label = group.key === 'member_messages' ? 'Recent Context (Last 3)' : group.label;
    const displayCount =
      group.key === 'member_messages'
        ? getRecentMemberMessages(group.items, 3).length
        : group.key === 'tasks'
          ? getRenderableTasks(group.items).length
          : group.items.length;
    return `
    <section>
      <h2>${escapeHtml(label)} (${displayCount})</h2>
      ${mode === 'public' ? renderPublicItems(group) : renderItems(group)}
    </section>
  `;
  });

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
    .task-board h3 {
      padding: 4px 0 4px 10px;
      margin: 14px 0 8px;
      font-size: 0.95rem;
    }
    .task-card {
      background: #fbfcfd;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 8px;
    }
    .task-address {
      font-weight: 600;
      margin-bottom: 4px;
    }
    .task-meta {
      color: var(--muted);
      font-size: 0.88rem;
      margin-bottom: 4px;
    }
    .task-desc {
      font-size: 0.9rem;
      margin-bottom: 6px;
    }
    .task-footer {
      font-size: 0.83rem;
      color: var(--muted);
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
  </main>
</body>
</html>`;
}

export function renderDigestPage(
  groups: SenderGroup[],
  now: Date,
  mode: DigestRenderMode,
): string {
  return buildDigestHtml(groups, now, mode);
}

function writeDigestReport(html: string, now: Date): string {
  const outDir = resolve(process.cwd(), 'out');
  mkdirSync(outDir, { recursive: true });

  const timestamp = formatTimestampForFile(now);
  const outputPath = resolve(outDir, `digest-${timestamp}.html`);

  writeFileSync(outputPath, html, 'utf-8');
  return outputPath;
}

export async function buildDigest(newItemCount = 0): Promise<{
  itemCount: number;
  reportPath: string;
  groups: SenderGroup[];
  generatedAt: Date;
}> {
  const items = getVisibleClassifiedItems(config.digest.visibilityWindowHours); // boundary in
  const groups = groupBySenderCategory(items); // computation/transformation

  const urgentCount = items.filter((item) => item.urgency === 'high').length; // computation/transformation
  const itemIds = items.map((item) => item.id).filter((id): id is number => Number.isInteger(id)); // computation/transformation
  const visibleItemsHash = createHash('sha256').update(JSON.stringify(itemIds)).digest('hex'); // computation/transformation

  const lastHash = getLastDigestHash(); // boundary in
  if (lastHash === visibleItemsHash && newItemCount === 0) { // computation/ iteration
    logger.info('Digest unchanged - skipping no-op digest', {
      visibleItemsHash,
      itemCount: items.length,
    });
    return { itemCount: items.length, reportPath: '', groups: [], generatedAt: new Date() };
  }

  const now = new Date();
  const html = renderDigestPage(groups, now, 'local');
  const reportPath = writeDigestReport(html, now);

  const digestId = createDigest({
    sent_at: now.toISOString(),
    item_count: items.length,
    urgent_count: urgentCount,
    recipient: 'local-report',
    visible_items_hash: visibleItemsHash,
    status: 'generated',
  });

  if (itemIds.length > 0) {
    markItemsSent(itemIds, digestId);
  }

  logger.info('Digest report written', {
    reportPath,
    itemCount: items.length,
    digestId,
  });

  return { itemCount: items.length, reportPath, groups, generatedAt: now };
}
