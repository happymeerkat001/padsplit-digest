/**
 * Classification orchestrator
 * Rules-first, LLM fallback
 */
// purpose: (output) classifies messages using a rules first then llm, then pending messages (Computation) by calling classifymessage for each using (Input) dependencies from rules, llm, db, and logger modules  
// purpose: reads pending messages from DB (Control),
//         classifies each using rules-first/LLM-fallback (Control, Output),
//         writes results back to DB (Mutation)

import { classifyWithRules, computeUrgency } from './rules.js'; // know from ./path, local sibling module for rules-based classification and urgency computation 
import { classifyWithLLM } from './llm.js'; // known from ./path, local sibling module for LLM classification
import { getPendingItems, updateItemClassification } from '../db/items.js'; // know from ../db/items.js, database access for pending items and updating classification results
import { logger } from '../utils/logger.js'; // knwon from ../utils/logger.js, logging utility for structured logs

export interface ClassificationResult { // know as classification result
  intent: string;
  confidence: number;
  isHighRisk: boolean;
  urgency: 'high' | 'medium' | 'low';
  reason: string;
  method: 'rules' | 'llm';
}

// Classify a single message
export async function classifyMessage(text: string): Promise<ClassificationResult> { // run classification function, with text input and return classification result
  // Step 1: Rules-based classification
  const rules = classifyWithRules(text); //memread- module and stack-> control ()

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
    const llm = await classifyWithLLM(text); // memread- text input, calls OpenAI API for classification - control 
    const urgency = computeUrgency(llm.intent, llm.confidence, rules.isHighRisk); // memread- compute urgency based on LLM result and rules high-risk flag - control

    return { //return-> control classification result from LLM
      intent: llm.intent,
      confidence: llm.confidence,
      isHighRisk: rules.isHighRisk, // Rules override for high-risk
      urgency,
      reason: llm.reason,
      method: 'llm',
    };
  } catch (err) {
    logger.error('LLM classification failed, using rules', { error: String(err) }); // tell- log error if LLM classification fails

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
export async function classifyPendingItems(): Promise<number> { //run classification for pending items, no input, returns number of items classified
  const items = getPendingItems(); // memread- DB call to get pending items - control

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
      logger.warn('Skipping item with no content', { id: item.id }); // tell- log warning if item has no content to classify
      continue;
    }

    try {
      const result = await classifyMessage(text);

      updateItemClassification(item.id, { //memwrite- update database with classification result - mutation
        intent: result.intent, 
        confidence: result.confidence,
        is_high_risk: result.isHighRisk,
        urgency: result.urgency,
        reason: result.reason,
      });

      classified++; // mutation- increment classified count

      logger.info('Classified item', { // tell- log info about classified item  
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
  return classified; // return number of items classified - control
}
