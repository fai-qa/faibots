// Our own character bodies, drawn on a 64×64 grid. Each shape says where its eyes sit.
// `round` adds a same-colour stroke that softens the corners of angular shapes.

import type { AvatarShape } from '@shared/domain'

export interface ShapeDef {
  d: string
  /** Eye centre height and the gap between the two eyes. */
  eyeY: number
  eyeGap: number
  eyeX?: number
  /** Stroke width (same colour) used to round sharp corners. */
  round?: number
}

function circle(cx: number, cy: number, r: number): string {
  return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`
}

function polygon(points: [number, number][]): string {
  return `M${points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join('L')}Z`
}

function star(cx: number, cy: number, outer: number, inner: number, n: number, rotate = -90): string {
  const pts: [number, number][] = []
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? outer : inner
    const a = ((rotate + (i * 180) / n) * Math.PI) / 180
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
  }
  return polygon(pts)
}

function petals(cx: number, cy: number, ring: number, r: number, n: number, rotate = -90): string {
  let d = circle(cx, cy, ring + r * 0.35)
  for (let i = 0; i < n; i++) {
    const a = ((rotate + (i * 360) / n) * Math.PI) / 180
    d += circle(cx + ring * Math.cos(a), cy + ring * Math.sin(a), r)
  }
  return d
}

export const SHAPES: Record<AvatarShape, ShapeDef> = {
  blob: {
    d: 'M33 5c13.5 0 25 9.6 25 24.4 0 8.3-2.6 12.4-1.9 18.4.8 7.1-6 11.2-15.1 11.2-5.8 0-8.4-2.1-14.8-2.1C14.5 56.9 6 50.3 6 36.4 6 17.9 18.2 5 33 5Z',
    eyeY: 29,
    eyeGap: 13
  },
  pebble: {
    d: 'M7 37c0-14.6 11.4-25 27-25 13.6 0 23 8.6 23 21.1C57 46.6 45.6 55 30.4 55 16.6 55 7 48.7 7 37Z',
    eyeY: 32,
    eyeGap: 13
  },
  bean: {
    d: 'M19.5 7c9.3 0 11.6 6.7 18.2 7.4C47.6 15.4 57 21.4 57 34.6 57 48.6 45.8 58 31 58 15.6 58 7 47.9 7 32.8 7 17.6 11.5 7 19.5 7Z',
    eyeY: 30,
    eyeGap: 13,
    eyeX: 33
  },
  egg: {
    d: 'M32 5c12.8 0 23 18.4 23 32.6C55 50.6 45 59 32 59S9 50.6 9 37.6C9 23.4 19.2 5 32 5Z',
    eyeY: 33,
    eyeGap: 13
  },
  squircle: {
    d: 'M32 6c20.6 0 26 5.4 26 26s-5.4 26-26 26S6 52.6 6 32 11.4 6 32 6Z',
    eyeY: 29,
    eyeGap: 14
  },
  capsule: {
    d: 'M32 4c10 0 18 8 18 18v20c0 10-8 18-18 18s-18-8-18-18V22c0-10 8-18 18-18Z',
    eyeY: 27,
    eyeGap: 12
  },
  hex: {
    d: polygon([
      [32, 7],
      [54, 19.5],
      [54, 44.5],
      [32, 57],
      [10, 44.5],
      [10, 19.5]
    ]),
    eyeY: 30,
    eyeGap: 14,
    round: 7
  },
  gem: {
    d: polygon([
      [21, 10],
      [43, 10],
      [56, 25],
      [32, 56],
      [8, 25]
    ]),
    eyeY: 26,
    eyeGap: 14,
    round: 6
  },
  shield: {
    d: 'M32 6l21 7.5v16.7C53 45 43.6 53.8 32 58.5 20.4 53.8 11 45 11 30.2V13.5Z',
    eyeY: 28,
    eyeGap: 13,
    round: 5
  },
  dome: {
    d: 'M9 55V34C9 20.2 19.3 9 32 9s23 11.2 23 25v21Z',
    eyeY: 32,
    eyeGap: 14,
    round: 6
  },
  cloud: {
    d: 'M18.5 54C11 54 6 48.9 6 42.2c0-6 4.1-10.6 10-11.6C16.9 21.4 24 14 33.4 14c7.1 0 12.9 4 15.4 10.2C54.6 25.4 58 30.6 58 37.6 58 46.9 51.6 54 43.2 54Z',
    eyeY: 37,
    eyeGap: 13
  },
  teardrop: {
    d: 'M32 4c7.6 11.8 22 23.4 22 36.4C54 52 44.2 60 32 60S10 52 10 40.4C10 27.4 24.4 15.8 32 4Z',
    eyeY: 39,
    eyeGap: 13
  },
  leaf: {
    d: 'M9 55C9 27.4 25.8 9 55 9c0 29.4-17.6 46-46 46Z',
    eyeY: 33,
    eyeGap: 12,
    eyeX: 31,
    round: 4
  },
  square: {
    d: 'M14 8h36a6 6 0 0 1 6 6v36a6 6 0 0 1-6 6H14a6 6 0 0 1-6-6V14a6 6 0 0 1 6-6Z',
    eyeY: 30,
    eyeGap: 14
  },
  sparkle: {
    d: 'M32 3c3.4 13.8 10.2 21.5 27 27.2-16.8 5.8-23.6 13.4-27 27.8-3.4-14.4-10.2-22-27-27.8C21.8 24.5 28.6 16.8 32 3Z',
    eyeY: 30,
    eyeGap: 10,
    round: 3
  },
  clover: {
    d: circle(32, 19, 12.5) + circle(45, 32, 12.5) + circle(32, 45, 12.5) + circle(19, 32, 12.5) + circle(32, 32, 14),
    eyeY: 31,
    eyeGap: 13
  },
  flower: {
    d: petals(32, 32, 15, 11, 6),
    eyeY: 31,
    eyeGap: 12
  },
  heart: {
    d: 'M32 57C18.4 47.6 6 38.4 6 24.4 6 15.2 12.8 8 21.2 8c5.2 0 8.8 2.8 10.8 6.6C34 10.8 37.6 8 42.8 8 51.2 8 58 15.2 58 24.4 58 38.4 45.6 47.6 32 57Z',
    eyeY: 27,
    eyeGap: 14
  },
  star: {
    d: star(32, 34, 28, 15, 5),
    eyeY: 33,
    eyeGap: 11,
    round: 5
  }
}
