import test from 'node:test';
import assert from 'node:assert/strict';
import type { DigestItem } from '../db/items.js';
import { renderDigestPage, type SenderGroup } from './builder.js';

const MEMBER_EMAIL = 'member-canary-9f3a@example.test';
const BODY_TEXT = 'body-canary-xylophone-quartz-77';
const TENANT_NAME = 'tenant-canary-zephyr-44';
const DESCRIPTION_TEXT = 'description-canary-lantern-18';
const SITE_PASSWORD = 'pw-canary-ember-orchid-55';
const SITE_PIN = 'pin-canary-4187';
const ASSIGNED_LINE = 'Assigned To: Queue';
const OTHERS_SUBJECT = 'others-subject-should-stay-off-page';
const MEMBER_SUBJECT = 'Conversation title';
const STATUS_TEXT = 'status-canary-maple';
const ROOM_NUMBER = 'Room 204';
const SUBJECT_A = '100 Public Test Ave';
const SUBJECT_B = '200 Public Test Ave';
const SUBJECT_C = '300 Public Test Ave';
const SUBJECT_CLOSED = '900 Closed Subject Lane';
const FREE_TEXT_CATEGORY = 'member wrote leak in the kitchen';
const NOW = new Date('2026-04-04T15:00:00.000Z');

function item(overrides: Partial<DigestItem> & Pick<DigestItem, 'source' | 'external_id'>): DigestItem {
  return {
    received_at: '2026-04-01T15:00:00.000Z',
    urgency: 'medium',
    intent: 'maintenance',
    ...overrides,
  };
}

function fixtureGroups(): SenderGroup[] {
  return [
    {
      key: 'member_messages',
      label: 'Member Messages',
      items: [
        item({
          source: 'member_messages',
          external_id: 'member-1',
          sender_email: MEMBER_EMAIL,
          tenant_name: TENANT_NAME,
          subject: MEMBER_SUBJECT,
          body_raw: BODY_TEXT,
          urgency: 'high',
        }),
      ],
    },
    {
      key: 'tasks',
      label: 'Tasks',
      items: [
        item({
          source: 'tasks',
          external_id: 'task-ridge-old',
          house_id: 'ridge oak',
          sender_email: MEMBER_EMAIL,
          tenant_name: TENANT_NAME,
          subject: SUBJECT_A,
          ticket_category: 'repair',
          body_raw: ['Type: Maintenance Ticket', ROOM_NUMBER, 'Status: Open', ASSIGNED_LINE, BODY_TEXT].join('\n'),
          received_at: '2026-04-01T15:00:00.000Z',
          urgency: 'medium',
        }),
        item({
          source: 'tasks',
          external_id: 'task-ridge-new',
          house_id: 'ridge oak',
          sender_email: MEMBER_EMAIL,
          tenant_name: TENANT_NAME,
          subject: SUBJECT_A,
          ticket_category: FREE_TEXT_CATEGORY,
          body_raw: ['Type: Maintenance Ticket', 'Bedroom', 'Status: In Progress', DESCRIPTION_TEXT].join('\n'),
          received_at: '2026-04-03T15:00:00.000Z',
          urgency: 'low',
        }),
        item({
          source: 'tasks',
          external_id: 'task-maple',
          house_id: 'maple court',
          sender_email: MEMBER_EMAIL,
          tenant_name: TENANT_NAME,
          subject: SUBJECT_B,
          body_raw: ['Type: Maintenance Ticket', 'Kitchen', 'Status: Open', 'leak-canary-pond'].join('\n'),
          received_at: '2026-04-03T15:00:00.000Z',
          urgency: 'low',
        }),
        item({
          source: 'tasks',
          external_id: 'task-room-number-house',
          house_id: ROOM_NUMBER,
          sender_email: MEMBER_EMAIL,
          tenant_name: TENANT_NAME,
          subject: SUBJECT_C,
          body_raw: ['Type: Maintenance Ticket', ROOM_NUMBER, `Status: ${STATUS_TEXT}`, 'Note omitted'].join('\n'),
          received_at: '2026-03-30T15:00:00.000Z',
          urgency: 'low',
        }),
        item({
          source: 'tasks',
          external_id: 'task-closed',
          house_id: 'ridge oak',
          sender_email: MEMBER_EMAIL,
          tenant_name: TENANT_NAME,
          subject: SUBJECT_CLOSED,
          ticket_category: 'leak',
          body_raw: ['Type: Maintenance Ticket', ROOM_NUMBER, 'Status: Complete', BODY_TEXT].join('\n'),
          received_at: '2026-03-01T15:00:00.000Z',
          urgency: 'low',
        }),
      ],
    },
    {
      key: 'others',
      label: 'Others',
      items: [
        item({
          source: 'others',
          external_id: 'other-1',
          sender_email: MEMBER_EMAIL,
          tenant_name: TENANT_NAME,
          subject: OTHERS_SUBJECT,
          body_raw: BODY_TEXT,
          urgency: 'low',
        }),
      ],
    },
  ];
}

const PUBLIC_FORBIDDEN: Array<[string, string]> = [
  ['member email', MEMBER_EMAIL],
  ['body text', BODY_TEXT],
  ['tenant name', TENANT_NAME],
  ['description text', DESCRIPTION_TEXT],
  ['site password value', SITE_PASSWORD],
  ['site pin value', SITE_PIN],
  ['password env name', 'DIGEST_SITE_PASSWORD'],
  ['pin env name', 'SECRET_PIN'],
  ['password prompt', 'Enter Password'],
  ['pin prompt', 'Enter PIN'],
  ['legacy lock key', 'padsplit_lock'],
  ['auth overlay', 'auth-overlay'],
  ['assigned line', ASSIGNED_LINE],
  ['non-task subject', OTHERS_SUBJECT],
  ['member subject', MEMBER_SUBJECT],
  ['status text', STATUS_TEXT],
  ['omitted note', 'Note omitted'],
  ['subject line', SUBJECT_A],
  ['subject line', SUBJECT_B],
  ['subject line', SUBJECT_C],
  ['closed subject', SUBJECT_CLOSED],
  ['room number', ROOM_NUMBER],
  ['room label', 'Bedroom'],
  ['room label', 'Kitchen'],
  ['task type text', 'Type: Maintenance Ticket'],
  ['free-text category', FREE_TEXT_CATEGORY],
  ['body leak text', 'leak-canary-pond'],
];

function withSecretEnv(run: () => void): void {
  const previousPassword = process.env['DIGEST_SITE_PASSWORD'];
  const previousPin = process.env['SECRET_PIN'];
  process.env['DIGEST_SITE_PASSWORD'] = SITE_PASSWORD;
  process.env['SECRET_PIN'] = SITE_PIN;
  try {
    run();
  } finally {
    if (previousPassword === undefined) {
      delete process.env['DIGEST_SITE_PASSWORD'];
    } else {
      process.env['DIGEST_SITE_PASSWORD'] = previousPassword;
    }
    if (previousPin === undefined) {
      delete process.env['SECRET_PIN'];
    } else {
      process.env['SECRET_PIN'] = previousPin;
    }
  }
}

test('public digest omits member content and client-side secrets', () => {
  withSecretEnv(() => {
    const html = renderDigestPage(fixtureGroups(), NOW, 'public');

    for (const [label, value] of PUBLIC_FORBIDDEN) {
      assert.equal(html.includes(value), false, `public digest contains ${label}`);
    }

    assert.match(html, /<title>active maintenance tickets<\/title>/);
    assert.match(html, /<h1>active maintenance tickets<\/h1>/);
    assert.match(html, /<p class="meta">updated [^<]+<\/p>/);
    assert.match(html, /<li>ridge oak · 2 open · oldest 3 days · repair<\/li>/);
    assert.match(html, /<li>maple court · 1 open · oldest 1 day<\/li>/);
    assert.match(html, /<li>1 open · oldest 5 days<\/li>/);
    assert.equal(html.includes('leak'), false, 'public digest contains leak text');
    assert.match(html, /details are on the ops page \(sign-in required\)\./);
    assert.equal(html.includes('<a'), false);
    assert.equal(html.includes('href'), false);
    assert.equal(html.includes('<th>Member</th>'), false);
    assert.equal(html.includes('<th>Sender</th>'), false);
    assert.equal(html.includes('<script'), false);
    assert.equal(html.includes('no open tickets.'), false);
  });
});

test('public digest shows an empty state when nothing is open', () => {
  const html = renderDigestPage(
    [
      {
        key: 'tasks',
        label: 'Tasks',
        items: [
          item({
            source: 'tasks',
            external_id: 'closed-only',
            house_id: 'ridge oak',
            subject: SUBJECT_CLOSED,
            ticket_category: 'leak',
            body_raw: ['Room 204', 'Status: Complete', SUBJECT_CLOSED].join('\n'),
          }),
        ],
      },
    ],
    NOW,
    'public',
  );

  assert.match(html, /<h1>active maintenance tickets<\/h1>/);
  assert.match(html, /<p>no open tickets\.<\/p>/);
  assert.match(html, /details are on the ops page \(sign-in required\)\./);
  assert.equal(html.includes('ridge oak'), false, 'empty state contains house label');
  assert.equal(html.includes(SUBJECT_CLOSED), false, 'empty state contains subject');
  assert.equal(html.includes('Room 204'), false, 'empty state contains room number');
  assert.equal(html.includes('leak'), false, 'empty state contains category from a closed ticket');
  assert.equal(html.includes('<a'), false);
});

test('local digest keeps member rows and still omits client-side secrets', () => {
  withSecretEnv(() => {
    const html = renderDigestPage(fixtureGroups(), NOW, 'local');

    assert.equal(html.includes(MEMBER_EMAIL), true, 'local digest keeps member email');
    assert.equal(html.includes(BODY_TEXT), true, 'local digest keeps body text');
    assert.equal(html.includes(DESCRIPTION_TEXT), true, 'local digest keeps task description');
    assert.equal(html.includes(SUBJECT_A), true, 'local digest keeps ticket subject');
    assert.equal(html.includes(ROOM_NUMBER), true, 'local digest keeps room text');
    assert.equal(html.includes('<th>Member</th>'), true, 'local digest keeps member column');
    assert.equal(html.includes(SITE_PASSWORD), false, 'local digest contains site password value');
    assert.equal(html.includes(SITE_PIN), false, 'local digest contains site pin value');
    assert.equal(html.includes('DIGEST_SITE_PASSWORD'), false);
    assert.equal(html.includes('SECRET_PIN'), false);
    assert.equal(html.includes('padsplit_lock'), false);
    assert.equal(html.includes('Enter Password'), false);
    assert.equal(html.includes('Enter PIN'), false);
    assert.equal(html.includes('<script'), false);
  });
});
