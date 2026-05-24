/*
5/23/2026 - nick decker | split score into raw + penalty
CHANGED
- `ScoreResult` now returns `scoreRaw` (≥0, sum of positive contributions), `scorePenalty` (≥0, magnitude of deductions), and `score` (net = scoreRaw - scorePenalty)
- `ScoreBreakdown.negatives` removed; replaced by `penalty` (stored as positive number)
- `computeScore` updated to populate all three top-level fields

5/23/2026 - nick decker | integer scorer
ADDED
- `ScoreBreakdown` type — { baseline, statedPersona, channelPersona, categoryModifier, penalty, total }
- `ScoreResult` type — { score, scoreRaw, scorePenalty, breakdown }
- `computeScore(signals, sourceType, categoryScore)` — deterministic integer score from stored Claude signals
  - Baseline: channel source +5, other 0
  - Stated persona: strong +10, partial +5; scaled by category multiplier
  - Channel-derived persona: 3+cats +10, 2cats +6, 1cat +3; scaled by category multiplier
  - Category multiplier: 1★=0.2, 2★=0.4, 3★=0.6, 4★=0.8, 5★=1.0 (default 0.6 at 3★)
  - Clickbait: 10 penalty points; total penalty capped at 20
*/

import type { Summary } from "./db.js";
import type { SourceType } from "./summarizer.js";

type ScoringSignals = Pick<Summary, "personaMatch" | "channelCategoriesMatched" | "clickbait">;

export type ScoreBreakdown = {
  baseline: number;
  statedPersona: number;
  channelPersona: number;
  categoryModifier: number;
  penalty: number;
  total: number;
};

export type ScoreResult = {
  score: number;
  scoreRaw: number;
  scorePenalty: number;
  breakdown: ScoreBreakdown;
};

const CATEGORY_MULTIPLIER: Record<number, number> = {
  1: 0.2,
  2: 0.4,
  3: 0.6,
  4: 0.8,
  5: 1.0,
};

export function computeScore(
  signals: ScoringSignals,
  sourceType: SourceType,
  categoryScore = 3
): ScoreResult {
  const multiplier = CATEGORY_MULTIPLIER[categoryScore] ?? 0.6;

  const baseline = sourceType === "channel" ? 5 : 0;

  const rawStatedPersona =
    signals.personaMatch === "strong" ? 10
    : signals.personaMatch === "partial" ? 5
    : 0;

  const rawChannelPersona =
    (signals.channelCategoriesMatched ?? 0) >= 3 ? 10
    : (signals.channelCategoriesMatched ?? 0) === 2 ? 6
    : (signals.channelCategoriesMatched ?? 0) === 1 ? 3
    : 0;

  const statedPersona = Math.round(rawStatedPersona * multiplier);
  const channelPersona = Math.round(rawChannelPersona * multiplier);

  const scoreRaw = baseline + statedPersona + channelPersona;
  const scorePenalty = Math.min(20, signals.clickbait ? 10 : 0);
  const score = scoreRaw - scorePenalty;

  return {
    score,
    scoreRaw,
    scorePenalty,
    breakdown: {
      baseline,
      statedPersona,
      channelPersona,
      categoryModifier: multiplier,
      penalty: scorePenalty,
      total: score,
    },
  };
}
