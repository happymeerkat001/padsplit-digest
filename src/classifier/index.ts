/**
 * Classification orchestrator
 * Rules-first, LLM fallback
 */

import { classifyWithRules, computeUrgency } from './rules.js';
import { classifyWithLLM } from './llm.js';
import { getPendingItems, updateItemClassification } from '../db/items.js';
import { logger } from '../utils/logger.js';

export interface ClassificationResult {
  intent: string;
  confidence: number;
  isHighRisk: boolean;
  urgency: 'high' | 'medium' | 'low';
  reason: string;
  method: 'rules' | 'llm';
}

// Classify a single message
export async function classifyMessage(text: string): Promise<ClassificationResult> {
  // Step 1: Rules-based classification
  const rules = classifyWithRules(text);

  // If high-risk, rules are authoritative
  if (rules.isHighRisk) {
    return {
      intent: rules.intent === 'unknown' ? 'maintenance' : rules.intent,
      confidence: 0.95,
      isHighRisk: true,
      urgency: 'high',
      reason: `High-risk keywords detected: ${rules.matchedKeywords.join(', ')}`,
      method: 'rules',
    };
  }

  // If rules found clear intent with good confidence, use it
  if (rules.intent !== 'unknown' && rules.confidence >= 0.7) {
    const urgency = computeUrgency(rules.intent, rules.confidence, rules.isHighRisk);
    return {
      intent: rules.intent,
      confidence: rules.confidence,
      isHighRisk: false,
      urgency,
      reason: `Matched keywords: ${rules.matchedKeywords.join(', ')}`,
      method: 'rules',
    };
  }

  // Step 2: LLM fallback for ambiguous messages
  try {
    const llm = await classifyWithLLM(text);
    const urgency = computeUrgency(llm.intent, llm.confidence, rules.isHighRisk);

    return {
      intent: llm.intent,
      confidence: llm.confidence,
      isHighRisk: rules.isHighRisk, // Rules override for high-risk
      urgency,
      reason: llm.reason,
      method: 'llm',
    };
  } catch (err) {
    logger.error('LLM classification failed, using rules', { error: String(err) });

    // Fall back to rules result
    const urgency = computeUrgency(rules.intent, rules.confidence, rules.isHighRisk);
    return {
      intent: rules.intent,
      confidence: rules.confidence,
      isHighRisk: rules.isHighRisk,
      urgency,
      reason: 'LLM unavailable, rules-based fallback',
      method: 'rules',
    };
  }
}

// Classify all pending items in database
export async function classifyPendingItems(): Promise<number> {
  const items = getPendingItems();

  if (items.length === 0) {
    logger.info('No pending items to classify');
    return 0;
  }

  logger.info('Classifying items', { count: items.length });

  let classified = 0;

  for (const item of items) {
    if (!item.id) continue;

    // Use resolved body if available, otherwise raw body
    const text = item.body_resolved || item.body_raw || item.subject || '';

    if (!text.trim()) {
      logger.warn('Skipping item with no content', { id: item.id });
      continue;
    }

    try {
      const result = await classifyMessage(text);

      updateItemClassification(item.id, {
        intent: result.intent,
        confidence: result.confidence,
        is_high_risk: result.isHighRisk,
        urgency: result.urgency,
        reason: result.reason,
      });

      classified++;

      logger.info('Classified item', {
        id: item.id,
        intent: result.intent,
        urgency: result.urgency,
        method: result.method,
      });
    } catch (err) {
      logger.error('Failed to classify item', {
        id: item.id,
        error: String(err),
      });
    }
  }

  logger.info('Classification complete', { classified, total: items.length });
  return classified;
}
