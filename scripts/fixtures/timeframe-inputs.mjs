// Deterministic input shapes, independent of the native implementations.
const bar = (o, h, l, c, v = 1000) => ({ o, h, l, c, v })
export function cupBars(dir = 1) {
  const bars = []; let p = dir > 0 ? 50 : 150
  for (let i = 0; i < 185; i++) {
    p += dir * 50 / 185
    bars.push(dir > 0 ? bar(p - 0.1, p + 0.3, p - 0.4, p) : bar(p + 0.1, p + 0.4, p - 0.3, p))
  }
  const move = dir > 0 ? 2 : 2.2
  for (let k = 0; k < 12; k++) {
    p -= dir * move
    bars.push(dir > 0 ? bar(p + 2, p + 2.2, p - 0.3, p, 1600 - k * 60)
      : bar(p - 2.2, p + 0.3, p - 2.4, p, 1600 - k * 60))
  }
  for (let k = 0; k < 8; k++) bars.push(dir > 0 ? bar(p, p + 0.4, p - 0.25, p + 0.1, 500) : bar(p, p + 0.25, p - 0.4, p - 0.1, 500))
  for (let k = 0; k < 12; k++) {
    p += dir * move
    bars.push(dir > 0 ? bar(p - 2, p + 0.4, p - 2.1, p, 1200 + k * 40) : bar(p + 2.2, p + 2.3, p - 0.4, p, 1200 + k * 40))
  }
  for (let k = 0; k < 5; k++) {
    const hp = p - dir * 0.5 * (k + 1) / 2
    bars.push(dir > 0 ? bar(hp + 0.2, hp + 0.5, hp - 0.3, hp, 600) : bar(hp - 0.2, hp + 0.3, hp - 0.5, hp, 600))
  }
  bars.push(dir > 0 ? bar(p - 1, p + 2.2, p - 1.2, p + 2, 1400) : bar(p + 1, p + 1.2, p - 2.2, p - 2, 1400))
  return bars
}
export function rsiBars(down = 6, bounce = 3) {
  const bars = []; let p = 100
  const push = () => bars.push(bar(p, p + 0.4, p - 0.4, p))
  for (let i = 0; i < 30; i++) push()
  for (let i = 0; i < 20; i++) { p += 3.5; push() }
  for (let i = 0; i < 20; i++) push()
  for (let i = 0; i < down; i++) { p -= 3; push() }
  bars.push(bar(p, p + bounce + 0.1, p - 0.5, p + bounce)); return bars
}
export function fvgBars({ price = 10.35, up = true, gapAt = 70, total = 80 } = {}) {
  const bars = []
  for (let i = 0; i < gapAt; i++) bars.push(bar(10, 10.2, 9.8, 10, 100))
  bars.push(bar(10.6, 10.9, 10.5, 10.8, 100))
  for (let i = gapAt + 1; i < total - 1; i++) bars.push(bar(10.8, 10.95, 10.7, 10.85, 100))
  bars.push(bar(up ? price - 0.05 : price + 0.05, price + 0.06, price - 0.06, price, 100)); return bars
}
