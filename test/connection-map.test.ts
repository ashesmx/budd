import { describe, expect, it } from 'vitest';
import { JS } from '../src/ui/assets.js';
import { curve, NODE_H, PILL_H } from '../src/ui/connectionMap.js';

type Curve = typeof curve;

/** app.js's copy of curve, which redraws routes as connections are dragged. */
function browserCurve(): Curve {
  const source = /const curve = (\(p, sp, pb, q, sq, qb\) => \{[\s\S]*?\n {2}\});/.exec(JS)?.[1];
  if (!source) throw new Error('curve not found in app.js');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- test only: runs app.js's own code
  return new Function('PILL_H', 'NODE_H', `return ${source}`)(PILL_H, NODE_H) as Curve;
}

const numbers = (d: string) => d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];

describe('message routes', () => {
  it('leave each mailbox outwards, away from its box', () => {
    // From a mailbox on a top edge to one on a bottom edge above it.
    const [ax, ay, c1x, c1y, c2x, c2y, bx, by] = numbers(
      curve([0, 0], -1, [0, 33, 170], [300, -400], 1, [300, -433, 170]),
    );
    expect([ax, ay]).toEqual([0, -PILL_H / 2]);
    expect(c1y).toBeLessThan(ay ?? 0);
    expect(c1x).toBe(ax);
    expect(c2y).toBeGreaterThan(by ?? 0);
    expect(c2x).toBe(bx);
  });

  it('go round the box, not through it, to whatever lies beyond its far edge', () => {
    const box: [number, number, number] = [100, 0, 200];
    // Two of its own mailboxes on opposite edges: past its right edge (x = 200), both ways.
    const [, , c1x, , c2x] = numbers(curve([150, -33], -1, box, [140, 33], 1, box));
    expect(c1x).toBeGreaterThan(200);
    expect(c2x).toBeGreaterThan(200);
    // From the top edge to a mailbox far below and to the left: round the left side.
    const [, , lx] = numbers(curve([150, -33], -1, box, [-300, 400], -1, [-300, 433, 170]));
    expect(lx).toBeLessThan(0);
  });

  it('are drawn the same by app.js', () => {
    const js = browserCurve();
    const cases: Parameters<Curve>[] = [
      [[0, 0], -1, [0, 33, 170], [300, 400], 1, [300, 367, 170]],
      [[10, 20], 1, [10, -13, 170], [-200, 30], 1, [-200, -3, 170]],
      [[150, -33], -1, [100, 0, 200], [140, 33], 1, [100, 0, 200]],
      [[150, -33], -1, [100, 0, 200], [60, -33], -1, [100, 0, 200]],
      [[150, -33], -1, [100, 0, 200], [-300, 400], -1, [-300, 433, 170]],
    ];
    for (const c of cases) expect(js(...c)).toBe(curve(...c));
  });
});
