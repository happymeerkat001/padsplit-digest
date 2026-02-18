import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPadSplitSenderQuery, extractSenderEmail, resolveSenderCategory } from './fetch.js';

test('buildPadSplitSenderQuery includes tracked senders and lookback window', () => {
  const query = buildPadSplitSenderQuery();

  assert.match(query, /support@padsplit\.com/);
  assert.match(query, /maintenance@padsplit\.com/);
  assert.match(query, /maint@padsplit\.com/);
  assert.match(query, /no-reply@padsplit\.com/);
  assert.match(query, /info@padsplit\.com/);
  assert.match(query, /messenger@padsplit\.com/);
  assert.match(query, /newer_than:\d+d/);
});

test('extractSenderEmail parses bracketed email format', () => {
  const sender = extractSenderEmail('PadSplit Support <support@padsplit.com>');
  assert.equal(sender, 'support@padsplit.com');
});

test('extractSenderEmail parses bare email format', () => {
  const sender = extractSenderEmail('messenger@padsplit.com');
  assert.equal(sender, 'messenger@padsplit.com');
});

test('resolveSenderCategory maps known senders and falls back to others', () => {
  assert.equal(resolveSenderCategory('support@padsplit.com'), 'support');
  assert.equal(resolveSenderCategory('maint@padsplit.com'), 'maintenance');
  assert.equal(resolveSenderCategory('info@padsplit.com'), 'no_reply_info');
  assert.equal(resolveSenderCategory('messenger@padsplit.com'), 'member_messages');
  assert.equal(resolveSenderCategory('unknown@example.com'), 'others');
});
