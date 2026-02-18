/**
 * LLM-based classification fallback (OpenAI gpt-4o-mini)
 * Used when rules-based classification returns unknown or low confidence
 */

import OpenAI from 'openai';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    if (!config.openai.apiKey) {
      throw new Error('OPENAI_API_KEY is required for LLM classification');
    }
    client = new OpenAI({ apiKey: config.openai.apiKey });
  }
  return client;
}

const SYSTEM_PROMPT = `You are a message classifier for PadSplit, a shared housing platform.

Classify tenant messages into one of these intents:
- maintenance: Repair requests, broken items, facility issues (leaks, HVAC, appliances, plumbing)
- money: Rent, payments, fees, deposits, billing disputes
- move_in: Move-in logistics, welcome questions, key pickup
- move_out: Leaving property, lease termination, final checkout
- gratitude: Thanks, appreciation, closure statements
- informational: General questions, status inquiries
- unknown: Cannot determine intent

Return JSON only:
{
  "intent": "one of the above",
  "confidence": 0.0-1.0,
  "reason": "brief explanation"
}

Rules:
- Gratitude messages (thank you, appreciate it) should be classified as gratitude
- Maintenance issues about water, leaks, or safety are high priority
- Money/billing issues are sensitive - classify carefully
- If truly ambiguous, use unknown with low confidence`;

export interface LLMClassification {
  intent: string;
  confidence: number;
  reason: string;
}

export async function classifyWithLLM(text: string): Promise<LLMClassification> {
  const openai = getClient();

  const response = await withRetry(async () => {
    const completion = await openai.chat.completions.create({
      model: config.openai.model,
      temperature: 0.3,
      max_tokens: 200,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty LLM response');
    }

    return content;
  });

  try {
    // Parse JSON response
    const parsed = JSON.parse(response);

    // Validate response structure
    if (!parsed.intent || typeof parsed.confidence !== 'number') {
      throw new Error('Invalid LLM response structure');
    }

    logger.debug('LLM classification', {
      intent: parsed.intent,
      confidence: parsed.confidence,
      textLength: text.length,
    });

    return {
      intent: parsed.intent,
      confidence: Math.min(Math.max(parsed.confidence, 0), 1),
      reason: parsed.reason || '',
    };
  } catch (err) {
    logger.error('Failed to parse LLM response', {
      response,
      error: String(err),
    });

    // Fallback
    return {
      intent: 'unknown',
      confidence: 0.3,
      reason: 'LLM response parsing failed',
    };
  }
}
