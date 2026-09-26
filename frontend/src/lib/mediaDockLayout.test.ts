import { describe, it, expect } from 'vitest';
import {
  DOCK_BAR_H_FALLBACK,
  DOCK_LAYOUT_KEY,
  DOCK_MARGIN,
  DOCK_MAX_W,
  DOCK_MIN_W,
  clampDockLayout,
  dockHeightFor,
  maxDockWidthFor,
  parseDockLayout,
  resizeDockWidth,
  type DockLayout,
  type DockViewport,
} from './mediaDockLayout';

// Default viewport for every geometry test. Expected numbers below are
// worked out by hand from the formulas in mediaDockLayout.ts:
//   height(w, barH) = barH + (w - 2) * 9/16 + 2
//   height(320, 28) = 28 + 178.875 + 2 = 208.875
//   height(720, 28) = 28 + 403.875 + 2 = 433.875
const vp: DockViewport = { vw: 1280, vh: 800, barH: 28 };

describe('constants', () => {
  it('pins the public numbers and the storage key', () => {
    expect(DOCK_MIN_W).toBe(200);
    expect(DOCK_MAX_W).toBe(720);
    expect(DOCK_MARGIN).toBe(8);
    expect(DOCK_BAR_H_FALLBACK).toBe(24);
    expect(DOCK_LAYOUT_KEY).toBe('ircfiber.mediaDockLayout');
  });
  it('uses a dot key, not an ircfiber: preference key', () => {
    expect(DOCK_LAYOUT_KEY.startsWith('ircfiber.')).toBe(true);
    expect(DOCK_LAYOUT_KEY.includes(':')).toBe(false);
  });
});

describe('dockHeightFor', () => {
  it('320 wide, 28 bar → 208.875', () => {
    expect(dockHeightFor(320, 28)).toBe(208.875);
  });
  it('418 wide, 24 bar → 260 (416 * 9/16 = 234)', () => {
    expect(dockHeightFor(418, 24)).toBe(260);
  });
  it('720 wide, 28 bar → 433.875', () => {
    expect(dockHeightFor(720, 28)).toBe(433.875);
  });
  it('200 wide, 28 bar → 141.375', () => {
    expect(dockHeightFor(200, 28)).toBe(141.375);
  });
  it('border-only box: 2 wide, 0 bar → 2', () => {
    expect(dockHeightFor(2, 0)).toBe(2);
  });
});

describe('maxDockWidthFor', () => {
  it('wide viewport → DOCK_MAX_W', () => {
    expect(maxDockWidthFor(vp)).toBe(720);
  });
  it('500 wide viewport → 484 (vw - 16)', () => {
    expect(maxDockWidthFor({ vw: 500, vh: 800, barH: 28 })).toBe(484);
  });
  it('216 wide viewport → exactly DOCK_MIN_W', () => {
    expect(maxDockWidthFor({ vw: 216, vh: 800, barH: 28 })).toBe(200);
  });
  it('100 wide viewport → hard floor 120', () => {
    expect(maxDockWidthFor({ vw: 100, vh: 800, barH: 28 })).toBe(120);
  });
});

describe('clampDockLayout', () => {
  it('layout already inside is returned unchanged', () => {
    expect(clampDockLayout({ x: 100, y: 100, w: 320 }, vp)).toStrictEqual({ x: 100, y: 100, w: 320 });
  });
  it('x past the right edge → vw - w - margin', () => {
    // 1280 - 320 - 8 = 952
    expect(clampDockLayout({ x: 2000, y: 100, w: 320 }, vp)).toStrictEqual({ x: 952, y: 100, w: 320 });
  });
  it('y past the bottom edge → vh - height - margin (uses dockHeightFor)', () => {
    // 800 - 208.875 - 8 = 583.125 → 583
    expect(clampDockLayout({ x: 100, y: 2000, w: 320 }, vp)).toStrictEqual({ x: 100, y: 583, w: 320 });
  });
  it('negative x/y → margin', () => {
    expect(clampDockLayout({ x: -50, y: -50, w: 320 }, vp)).toStrictEqual({ x: 8, y: 8, w: 320 });
  });
  it('w above max is clamped and x re-clamped against the new width', () => {
    // w → 720; x bound = 1280 - 720 - 8 = 552
    expect(clampDockLayout({ x: 600, y: 100, w: 1000 }, vp)).toStrictEqual({ x: 552, y: 100, w: 720 });
  });
  it('w below min is raised to DOCK_MIN_W', () => {
    expect(clampDockLayout({ x: 100, y: 100, w: 50 }, vp)).toStrictEqual({ x: 100, y: 100, w: 200 });
  });
  it('values exactly on the bounds pass through', () => {
    expect(clampDockLayout({ x: 8, y: 8, w: 200 }, vp)).toStrictEqual({ x: 8, y: 8, w: 200 });
    // x bound 952 (1280-320-8); y bound 583.125 → 583 ≤ 583.125 stays
    expect(clampDockLayout({ x: 952, y: 583, w: 320 }, vp)).toStrictEqual({ x: 952, y: 583, w: 320 });
    // w = 720 with x bound 552 and y bound 800 - 433.875 - 8 = 358.125
    expect(clampDockLayout({ x: 552, y: 358, w: 720 }, vp)).toStrictEqual({ x: 552, y: 358, w: 720 });
  });
  it('rounds fractional input', () => {
    expect(clampDockLayout({ x: 100.4, y: 100.6, w: 320.5 }, vp)).toStrictEqual({ x: 100, y: 101, w: 321 });
  });
  it('viewport narrower than DOCK_MIN_W + 16 → w = vw - 16, x = margin', () => {
    // vw 200: wMax = 184; x bound = 200 - 184 - 8 = 8
    const narrow: DockViewport = { vw: 200, vh: 800, barH: 28 };
    expect(clampDockLayout({ x: 100, y: 100, w: 320 }, narrow)).toStrictEqual({ x: 8, y: 100, w: 184 });
  });
  it('viewport narrower than the hard floor → w = 120, x pinned to margin', () => {
    // vw 100: wMax = 120; x bound = 100 - 120 - 8 = -28 < 8 → pin to 8
    const tiny: DockViewport = { vw: 100, vh: 800, barH: 28 };
    expect(clampDockLayout({ x: 100, y: 100, w: 320 }, tiny)).toStrictEqual({ x: 8, y: 100, w: 120 });
  });
  it('viewport shorter than the dock → y pinned to margin', () => {
    // vh 150: y bound = 150 - 208.875 - 8 = -66.875 < 8 → pin to 8
    const short: DockViewport = { vw: 1280, vh: 150, barH: 28 };
    expect(clampDockLayout({ x: 100, y: 100, w: 320 }, short)).toStrictEqual({ x: 100, y: 8, w: 320 });
  });
  it('barH changes the y bound', () => {
    // barH 28: 800 - 208.875 - 8 = 583.125 → 583
    // barH 60: height = 60 + 178.875 + 2 = 240.875; 800 - 240.875 - 8 = 551.125 → 551
    expect(clampDockLayout({ x: 100, y: 2000, w: 320 }, { vw: 1280, vh: 800, barH: 28 }).y).toBe(583);
    expect(clampDockLayout({ x: 100, y: 2000, w: 320 }, { vw: 1280, vh: 800, barH: 60 }).y).toBe(551);
  });
  it('does not mutate its input and returns a new object', () => {
    const input: DockLayout = Object.freeze({ x: 2000, y: 2000, w: 1000 }) as DockLayout;
    const out = clampDockLayout(input, vp);
    expect(out).not.toBe(input);
    expect(input).toStrictEqual({ x: 2000, y: 2000, w: 1000 });
    expect(out).toStrictEqual({ x: 552, y: 358, w: 720 });
  });
});

describe('resizeDockWidth', () => {
  it('width inside every bound is returned as is', () => {
    expect(resizeDockWidth(320, 100, 100, vp)).toBe(320);
  });
  it('caps at the right edge', () => {
    // 1280 - 1000 - 8 = 272
    expect(resizeDockWidth(500, 1000, 100, vp)).toBe(272);
  });
  it('caps at the bottom edge via 16:9', () => {
    // (800 - 600 - 8 - 28 - 2) * 16/9 + 2 = 162 * 16/9 + 2 = 290
    expect(resizeDockWidth(500, 100, 600, vp)).toBe(290);
    // and that width really touches the bottom margin: 600 + height(290) + 8 = 800
    expect(600 + dockHeightFor(290, 28) + 8).toBe(800);
  });
  it('floors at DOCK_MIN_W when there is room', () => {
    expect(resizeDockWidth(50, 100, 100, vp)).toBe(200);
  });
  it('caps at DOCK_MAX_W when there is room', () => {
    expect(resizeDockWidth(5000, 100, 100, vp)).toBe(720);
  });
  it('when the edge cap is below DOCK_MIN_W the cap is both floor and ceiling', () => {
    // 1280 - 1100 - 8 = 172
    expect(resizeDockWidth(50, 1100, 100, vp)).toBe(172);
    expect(resizeDockWidth(5000, 1100, 100, vp)).toBe(172);
  });
  it('never goes below the hard floor even with no room', () => {
    // 1280 - 1270 - 8 = 2 → max(120, 2) = 120
    expect(resizeDockWidth(50, 1270, 100, vp)).toBe(120);
  });
  it('rounds', () => {
    expect(resizeDockWidth(320.4, 100, 100, vp)).toBe(320);
    expect(resizeDockWidth(320.5, 100, 100, vp)).toBe(321);
  });
});

describe('parseDockLayout', () => {
  it('null → null', () => {
    expect(parseDockLayout(null)).toBeNull();
  });
  it('empty string → null', () => {
    expect(parseDockLayout('')).toBeNull();
  });
  it('non-JSON → null', () => {
    expect(parseDockLayout('{nope')).toBeNull();
  });
  it("'null' → null", () => {
    expect(parseDockLayout('null')).toBeNull();
  });
  it('JSON string → null', () => {
    expect(parseDockLayout('"hello"')).toBeNull();
  });
  it('JSON number / boolean → null', () => {
    expect(parseDockLayout('42')).toBeNull();
    expect(parseDockLayout('true')).toBeNull();
  });
  it('array → null', () => {
    expect(parseDockLayout('[1,2,3]')).toBeNull();
  });
  it('missing field → null', () => {
    expect(parseDockLayout('{"x":1,"y":2}')).toBeNull();
    expect(parseDockLayout('{}')).toBeNull();
  });
  it('wrong type → null', () => {
    expect(parseDockLayout('{"x":"1","y":2,"w":3}')).toBeNull();
    expect(parseDockLayout('{"x":1,"y":null,"w":3}')).toBeNull();
    expect(parseDockLayout('{"x":1,"y":2,"w":[3]}')).toBeNull();
  });
  it('1e999 (parses to Infinity) → null', () => {
    expect(parseDockLayout('{"x":1e999,"y":2,"w":3}')).toBeNull();
    expect(parseDockLayout('{"x":1,"y":2,"w":-1e999}')).toBeNull();
  });
  it('negatives are accepted (no range checks)', () => {
    expect(parseDockLayout('{"x":-10,"y":-20,"w":-5}')).toStrictEqual({ x: -10, y: -20, w: -5 });
  });
  it('extra fields are dropped', () => {
    expect(parseDockLayout('{"x":1,"y":2,"w":3,"h":4,"foo":"bar"}')).toStrictEqual({ x: 1, y: 2, w: 3 });
  });
  it('fractional values are kept', () => {
    expect(parseDockLayout('{"x":1.5,"y":2.25,"w":300.75}')).toStrictEqual({ x: 1.5, y: 2.25, w: 300.75 });
  });
  it('valid round-trip through JSON.stringify', () => {
    const l: DockLayout = { x: 12, y: 34, w: 300 };
    expect(JSON.stringify(l)).toBe('{"x":12,"y":34,"w":300}');
    expect(parseDockLayout(JSON.stringify(l))).toStrictEqual(l);
  });
});
