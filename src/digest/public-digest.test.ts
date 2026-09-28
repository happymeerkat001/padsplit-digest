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
          external_id: 'task-safe',
          sender_email: MEMBER_EMAIL,
          tenant_name: TENANT_NAME,
          subject: '100 Public Test Ave',
          body_raw: ['Type: Maintenance Ticket', 'Bedroom', 'Status: Open', ASSIGNED_LINE].join('\n'),
          urgency: 'medium',
        }),
        item({
          source: 'tasks',
          external_id: 'task-free-text',
          sender_email: MEMBER_EMAIL,
          tenant_name: TENANT_NAME,
          subject: '200 Public Test Ave',
          body_raw: ['Type: Maintenance Ticket', DESCRIPTION_TEXT, 'Status: Open', BODY_TEXT].join('\n'),
          urgency: 'low',
        }),
        item({
          source: 'tasks',
          external_id: 'task-unknown-status',
          sender_email: MEMBER_EMAIL,
          tenant_name: TENANT_NAME,
          subject: '300 Public Test Ave',
          body_raw: ['Type: Maintenance Ticket', 'Kitchen', `Status: ${STATUS_TEXT}`, 'Note omitted'].join('\n'),
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
    const html = renderDigestPage(fixtureGroups(), new Date('2026-04-01T15:00:00.000Z'), 'public');

    for (const [label, value] of PUBLIC_FORBIDDEN) {
      assert.equal(html.includes(value), false, `public digest contains ${label}`);
    }

    assert.match(html, /100 Public Test Ave/);
    assert.match(html, /200 Public Test Ave/);
    assert.match(html, /300 Public Test Ave/);
    assert.match(html, /Type: Maintenance Ticket/);
    assert.match(html, /Bedroom/);
    assert.match(html, /Kitchen/);
    assert.match(html, /Total items: 5/);
    assert.match(html, /Urgent items: 1/);
    assert.match(html, /Open \(2\)/);
    assert.match(html, /Other \(1\)/);
    assert.match(html, /Item details are omitted from the public digest/);
    assert.equal(html.includes('<th>Member</th>'), false);
    assert.equal(html.includes('<th>Sender</th>'), false);
    assert.equal(html.includes('<script'), false);
  });
});

test('local digest keeps member rows and still omits client-side secrets', () => {
  withSecretEnv(() => {
    const html = renderDigestPage(fixtureGroups(), new Date('2026-04-01T15:00:00.000Z'), 'local');

    assert.equal(html.includes(MEMBER_EMAIL), true, 'local digest keeps member email');
    assert.equal(html.includes(BODY_TEXT), true, 'local digest keeps body text');
    assert.equal(html.includes(DESCRIPTION_TEXT), true, 'local digest keeps task description');
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
