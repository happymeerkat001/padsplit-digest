import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWithRules, computeUrgency, containsHighRiskLanguage, detectIntent } from './rules.js';

test('containsHighRiskLanguage detects emergency keywords', () => {
  const result = containsHighRiskLanguage('There is an emergency gas leak in the kitchen.');

  assert.equal(result.isHighRisk, true);
  assert.ok(result.keywords.includes('emergency'));
  assert.ok(result.keywords.includes('gas leak'));
});

test('detectIntent identifies maintenance requests', () => {
  const result = detectIntent('My AC is broken and the sink has a leak. Please repair.');

  assert.equal(result.intent, 'maintenance');
  assert.ok(result.confidence >= 0.7);
  assert.ok(result.matched.length >= 2);
});

test('classifyWithRules returns high risk when legal threat appears', () => {
  const result = classifyWithRules('I will call my lawyer about this unsafe issue.');

  assert.equal(result.isHighRisk, true);
  assert.ok(result.matchedKeywords.includes('lawyer'));
});

test('computeUrgency prioritizes maintenance as high', () => {
  const urgency = computeUrgency('maintenance', 0.8, false);
  assert.equal(urgency, 'high');
});
