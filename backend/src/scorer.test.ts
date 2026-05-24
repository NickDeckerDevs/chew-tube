import { describe, it, expect } from "vitest";
import { computeScore } from "./scorer.js";

const noSignals = { personaMatch: null, channelCategoriesMatched: null, clickbait: null } as const;

describe("computeScore — baseline", () => {
  it("topic source with no signals → score 0, scoreRaw 0, scorePenalty 0", () => {
    const result = computeScore(noSignals, "topic");
    expect(result.score).toBe(0);
    expect(result.scoreRaw).toBe(0);
    expect(result.scorePenalty).toBe(0);
  });

  it("channel source with no signals → score 5 (baseline only)", () => {
    const result = computeScore(noSignals, "channel");
    expect(result.score).toBe(5);
    expect(result.scoreRaw).toBe(5);
    expect(result.breakdown.baseline).toBe(5);
  });
});

describe("computeScore — stated persona tiers at category ★3 (multiplier 0.6)", () => {
  it("strong persona match → statedPersona 6 (round(10 × 0.6))", () => {
    const result = computeScore({ ...noSignals, personaMatch: "strong" }, "topic", 3);
    expect(result.breakdown.statedPersona).toBe(6);
    expect(result.scoreRaw).toBe(6);
  });

  it("partial persona match → statedPersona 3 (round(5 × 0.6))", () => {
    const result = computeScore({ ...noSignals, personaMatch: "partial" }, "topic", 3);
    expect(result.breakdown.statedPersona).toBe(3);
  });

  it("no persona match → statedPersona 0", () => {
    const result = computeScore({ ...noSignals, personaMatch: "none" }, "topic", 3);
    expect(result.breakdown.statedPersona).toBe(0);
  });
});

describe("computeScore — channel-derived persona tiers at category ★3 (multiplier 0.6)", () => {
  it("1 category matched → channelPersona 2 (round(3 × 0.6))", () => {
    const result = computeScore({ ...noSignals, channelCategoriesMatched: 1 }, "topic", 3);
    expect(result.breakdown.channelPersona).toBe(2);
  });

  it("2 categories matched → channelPersona 4 (round(6 × 0.6))", () => {
    const result = computeScore({ ...noSignals, channelCategoriesMatched: 2 }, "topic", 3);
    expect(result.breakdown.channelPersona).toBe(4);
  });

  it("3 categories matched → channelPersona 6 (round(10 × 0.6))", () => {
    const result = computeScore({ ...noSignals, channelCategoriesMatched: 3 }, "topic", 3);
    expect(result.breakdown.channelPersona).toBe(6);
  });

  it("null channelCategoriesMatched → treated as 0, no crash", () => {
    const result = computeScore({ ...noSignals, channelCategoriesMatched: null }, "topic", 3);
    expect(result.breakdown.channelPersona).toBe(0);
  });
});

describe("computeScore — category multiplier", () => {
  it("★5 multiplier: channel + strong + 3 cats → scoreRaw 25 (max)", () => {
    const result = computeScore(
      { personaMatch: "strong", channelCategoriesMatched: 3, clickbait: null },
      "channel",
      5
    );
    expect(result.scoreRaw).toBe(25);
    expect(result.score).toBe(25);
    expect(result.breakdown.categoryModifier).toBe(1.0);
  });

  it("★1 multiplier: channel + strong + 3 cats → scoreRaw 9 (5 + 2 + 2)", () => {
    const result = computeScore(
      { personaMatch: "strong", channelCategoriesMatched: 3, clickbait: null },
      "channel",
      1
    );
    expect(result.scoreRaw).toBe(9);
    expect(result.breakdown.categoryModifier).toBe(0.2);
  });

  it("omitting categoryScore defaults to ★3 behavior (multiplier 0.6)", () => {
    const explicit = computeScore({ ...noSignals, personaMatch: "strong" }, "topic", 3);
    const defaulted = computeScore({ ...noSignals, personaMatch: "strong" }, "topic");
    expect(defaulted.scoreRaw).toBe(explicit.scoreRaw);
    expect(defaulted.breakdown.categoryModifier).toBe(0.6);
  });
});

describe("computeScore — penalty", () => {
  it("clickbait true → scorePenalty 10, subtracted from scoreRaw", () => {
    const result = computeScore(
      { personaMatch: "strong", channelCategoriesMatched: 3, clickbait: true },
      "channel",
      5
    );
    expect(result.scoreRaw).toBe(25);
    expect(result.scorePenalty).toBe(10);
    expect(result.score).toBe(15);
    expect(result.breakdown.penalty).toBe(10);
  });

  it("clickbait on zero-raw score → score goes negative", () => {
    const result = computeScore({ ...noSignals, clickbait: true }, "topic");
    expect(result.scoreRaw).toBe(0);
    expect(result.scorePenalty).toBe(10);
    expect(result.score).toBe(-10);
  });
});

describe("computeScore — breakdown integrity", () => {
  it("breakdown.total always equals score field", () => {
    const cases = [
      computeScore({ personaMatch: "strong", channelCategoriesMatched: 2, clickbait: true }, "channel", 4),
      computeScore({ personaMatch: "partial", channelCategoriesMatched: 1, clickbait: false }, "topic", 2),
      computeScore(noSignals, "topic"),
    ];
    for (const result of cases) {
      expect(result.breakdown.total).toBe(result.score);
    }
  });
});
