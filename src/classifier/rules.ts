/**
 * Rules-based classification (runs first, before LLM)
 * Ported from agent-brain
 */

// High-risk keywords that require immediate attention
export const HIGH_RISK_KEYWORDS = [
  'lawyer', 'sue', 'legal', 'threat', 'police',
  'urgent', 'emergency', 'fire', 'flood', 'gas leak', 'dangerous',
];

// Additional escalation triggers
const ESCALATION_TRIGGERS = [
  'lawyer', 'attorney', 'sue', 'legal', 'court', 'police', 'report',
  'call me', 'phone',
];

// Intent patterns (simple keyword matching)
const INTENT_PATTERNS: Record<string, string[]> = {
  maintenance: [
    'leak', 'broken', 'repair', 'fix', 'not working', 'damage',
    'water', 'heater', 'ac', 'hvac', 'plumbing', 'electric',
    'appliance', 'washer', 'dryer', 'dishwasher', 'fridge', 'refrigerator',
    'toilet', 'sink', 'shower', 'faucet', 'pipe', 'clog',
    'roof', 'window', 'door', 'lock', 'key',
  ],
  money: [
    'rent', 'payment', 'pay', 'fee', 'deposit', 'refund',
    'charge', 'bill', 'invoice', 'owe', 'money', 'late',
    'balance', 'account',
  ],
  move_in: [
    'move in', 'moving in', 'check in', 'arrival', 'arriving',
    'keys', 'access', 'welcome', 'new member', 'first day',
  ],
  move_out: [
    'move out', 'moving out', 'leaving', 'vacate', 'checkout',
    'last day', 'departure', 'terminate', 'end lease', 'notice',
  ],
  gratitude: [
    'thank', 'thanks', 'appreciate', 'grateful', 'awesome',
    'great', 'perfect', 'excellent', 'wonderful',
  ],
};

export interface RulesClassification {
  intent: string;
  confidence: number;
  isHighRisk: boolean;
  hasEscalationTriggers: boolean;
  matchedKeywords: string[];
}

// Check for high-risk language
export function containsHighRiskLanguage(text: string): { isHighRisk: boolean; keywords: string[] } {
  const lower = text.toLowerCase();
  const matched = HIGH_RISK_KEYWORDS.filter((kw) => lower.includes(kw));
  return {
    isHighRisk: matched.length > 0,
    keywords: matched,
  };
}

// Check for escalation triggers
export function hasEscalationTriggers(text: string): boolean {
  const lower = text.toLowerCase();

  // Check explicit triggers
  if (ESCALATION_TRIGGERS.some((t) => lower.includes(t))) {
    return true;
  }

  // Long messages often need human review
  if (text.length > 200) {
    return true;
  }

  return false;
}

// Detect intent from text using keyword patterns
export function detectIntent(text: string): { intent: string; confidence: number; matched: string[] } {
  const lower = text.toLowerCase();
  const scores: Record<string, { count: number; keywords: string[] }> = {};

  for (const [intent, keywords] of Object.entries(INTENT_PATTERNS)) {
    const matched = keywords.filter((kw) => lower.includes(kw));
    if (matched.length > 0) {
      scores[intent] = { count: matched.length, keywords: matched };
    }
  }

  // Find highest scoring intent
  let bestIntent = 'unknown';
  let bestScore = 0;
  let bestKeywords: string[] = [];

  for (const [intent, { count, keywords }] of Object.entries(scores)) {
    if (count > bestScore) {
      bestIntent = intent;
      bestScore = count;
      bestKeywords = keywords;
    }
  }

  // Calculate confidence based on match strength
  const confidence = bestScore === 0 ? 0.3 : Math.min(0.5 + bestScore * 0.1, 0.85);

  return {
    intent: bestIntent,
    confidence,
    matched: bestKeywords,
  };
}

// Main rules classification
export function classifyWithRules(text: string): RulesClassification {
  const { isHighRisk, keywords: riskKeywords } = containsHighRiskLanguage(text);
  const { intent, confidence, matched } = detectIntent(text);
  const escalation = hasEscalationTriggers(text);

  return {
    intent,
    confidence,
    isHighRisk,
    hasEscalationTriggers: escalation,
    matchedKeywords: [...new Set([...riskKeywords, ...matched])],
  };
}

// Compute urgency level
export function computeUrgency(
  intent: string,
  confidence: number,
  isHighRisk: boolean
): 'high' | 'medium' | 'low' {
  if (isHighRisk) return 'high';
  if (intent === 'maintenance') return 'high';
  if (intent === 'money') return 'medium';
  if (confidence < 0.7) return 'medium';
  if (intent === 'gratitude') return 'low';
  return 'medium';
}
