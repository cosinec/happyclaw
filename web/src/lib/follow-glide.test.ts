import { describe, expect, test } from 'vitest';
import { FOLLOW_GLIDE_MS, glideOffsetAt, stickyTrack } from './follow-glide';

describe('glideOffsetAt', () => {
  const glide = { from: 120, startedAt: 1000 };
  const at = (progress: number) =>
    glideOffsetAt(glide, 1000 + progress * FOLLOW_GLIDE_MS);

  test('shows the whole offset until the glide starts and none once over', () => {
    expect(glideOffsetAt(glide, 990)).toBe(120);
    expect(at(0)).toBe(120);
    expect(at(1)).toBe(0);
    expect(glideOffsetAt(glide, 5000)).toBe(0);
  });

  test('eases on cubic-bezier(0.4, 0, 0.2, 1): slow start, steady fall to rest', () => {
    // The curve solved independently by Newton's method: 0.0259 at 0.1,
    // 0.7756 at 0.5.
    expect(at(0.1)).toBeCloseTo(120 * (1 - 0.0259), 0);
    expect(at(0.5)).toBeCloseTo(120 * (1 - 0.7756), 0);
    let previous = 120;
    for (let i = 1; i <= 20; i += 1) {
      const offset = at(i / 20);
      expect(offset).toBeLessThan(previous);
      previous = offset;
    }
  });
});

describe('stickyTrack', () => {
  /** Where an element shows at `progress`, linearly between keyframes. */
  function sample(offsets: number[], progress: number): number {
    const at = progress * (offsets.length - 1);
    const i = Math.min(Math.floor(at), offsets.length - 2);
    return offsets[i] + (offsets[i + 1] - offsets[i]) * (at - i);
  }

  test('a row stuck deeper than the glide is held for all of it', () => {
    expect(stickyTrack(64, 300)).toEqual({
      offsets: [-64, 0],
      easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
    });
    expect(stickyTrack(64, 64).offsets).toEqual([-64, 0]);
  });

  test('a row that sticks during the glide is held only once the content passes it', () => {
    const from = 66;
    const depth = 28;
    const { offsets, easing } = stickyTrack(from, depth);
    expect(easing).toBe('linear');
    expect(offsets[0]).toBe(-depth);
    expect(offsets.at(-1)).toBeCloseTo(0, 10);
    for (let i = 0; i <= 40; i += 1) {
      const progress = i / 40;
      const content = glideOffsetAt(
        { from, startedAt: 0 },
        progress * FOLLOW_GLIDE_MS,
      );
      // On screen: where the flow puts it (content offset, `depth` above the
      // stuck spot) or the stuck spot, whichever is lower.
      const shown = content + sample(offsets, progress);
      expect(shown).toBeCloseTo(Math.max(content - depth, 0), 0);
    }
  });
});
