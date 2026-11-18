// Draws the FaiBots app icon (the tray's bot face, scaled up) and writes build/icon.png and
// build/icon.ico for the installer. Original art, drawn here from shapes; no dependencies.
// Run: node scripts/make-icon.mjs

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')

// Colours of the tray mark (src/main/platform/tray.ts).
const FACE = [0x18, 0x18, 0x1c]
const RIM = [0x3a, 0x3a, 0x44]
const EYE = [0xff, 0xff, 0xff]
const SMILE = [0x56, 0x9c, 0xff]

// Shapes in a 0..1 square; each returns a signed distance (negative inside).
const roundedSquare = (x, y, inset, radius) => {
  const half = 0.5 - inset - radius
  const qx = Math.abs(x - 0.5) - half
  const qy = Math.abs(y - 0.5) - half
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
}
// A four-point sparkle: |dx|^p + |dy|^p = r^p with p < 1 pinches the sides in.
const sparkle = (x, y, cx, cy, r) => {
  const p = 0.62
  const dx = Math.abs(x - cx) / r
  const dy = Math.abs(y - cy) / r
  return (Math.pow(Math.pow(dx, p) + Math.pow(dy, p), 1 / p) - 1) * r * 0.5
}
// A smile: a stroked arc below (cx, cy) with round ends.
const smile = (x, y) => {
  const cx = 0.5, cy = 0.5, r = 0.235, w = 0.042, from = (35 * Math.PI) / 180, to = (145 * Math.PI) / 180
  const a = Math.atan2(y - cy, x - cx)
  if (a >= from && a <= to) return Math.abs(Math.hypot(x - cx, y - cy) - r) - w
  const end = (t) => Math.hypot(x - (cx + r * Math.cos(t)), y - (cy + r * Math.sin(t))) - w
  return Math.min(end(from), end(to))
}

/** The shapes at (x, y) with their colours, back to front: rim, face, eyes, smile. */
function layers(x, y) {
  return [
    [roundedSquare(x, y, 0.035, 0.2), RIM],
    [roundedSquare(x, y, 0.05, 0.185), FACE],
    [Math.min(sparkle(x, y, 0.345, 0.42, 0.12), sparkle(x, y, 0.655, 0.42, 0.12)), EYE],
    [smile(x, y), SMILE]
  ]
}

function render(size) {
  const ss = size <= 32 ? 8 : 4 // supersampling for smooth edges
  const px = Buffer.alloc(size * size * 4)
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (pxl + (sx + 0.5) / ss) / size
          const y = (py + (sy + 0.5) / ss) / size
          // Composite the layers for this sample (premultiplied).
          let cr = 0, cg = 0, cb = 0, ca = 0
          for (const [d, colour] of layers(x, y)) {
            if (d > 0) continue
            cr = colour[0]; cg = colour[1]; cb = colour[2]; ca = 1
          }
          r += cr * ca; g += cg * ca; b += cb * ca; a += ca
        }
      }
      const i = (py * size + pxl) * 4
      const n = ss * ss
      px[i + 3] = Math.round((a / n) * 255)
      if (a > 0) {
        px[i] = Math.round(r / a); px[i + 1] = Math.round(g / a); px[i + 2] = Math.round(b / a)
      }
    }
  }
  return px
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function png(size) {
  const rgba = render(size)
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** A Windows .ico holding PNG images (supported since Windows Vista). */
function ico(sizes) {
  const images = sizes.map(png)
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(sizes.length, 4)
  let offset = 6 + 16 * sizes.length
  const entries = sizes.map((size, i) => {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size
    e[1] = size >= 256 ? 0 : size
    e.writeUInt16LE(1, 4) // colour planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(images[i].length, 8)
    e.writeUInt32LE(offset, 12)
    offset += images[i].length
    return e
  })
  return Buffer.concat([header, ...entries, ...images])
}

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'icon.png'), png(512))
writeFileSync(join(outDir, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256]))
console.log(`Wrote ${join(outDir, 'icon.png')} and icon.ico`)
