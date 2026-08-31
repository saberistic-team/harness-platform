import { describe, expect, it } from "vitest";
import {
  MAX_MODEL_TEXT_DELTA_CHARS,
  normalizeModelTextDeltas,
} from "../src";

describe("normalizeModelTextDeltas", () => {
  it("drops empty chunks and splits large chunks without changing content", () => {
    const oversized = "a".repeat(MAX_MODEL_TEXT_DELTA_CHARS + 2);

    const normalized = normalizeModelTextDeltas(["", oversized, "", "bc"]);

    expect(normalized.map((delta) => delta.length)).toEqual([
      MAX_MODEL_TEXT_DELTA_CHARS,
      2,
      2,
    ]);
    expect(normalized.every((delta) => delta.length > 0)).toBe(true);
    expect(normalized.every((delta) => delta.length <= MAX_MODEL_TEXT_DELTA_CHARS))
      .toBe(true);
    expect(normalized.join("")).toBe(`${oversized}bc`);
  });
});
