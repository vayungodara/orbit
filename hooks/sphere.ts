// An orb drawn the way Amp draws its own: a dark globe with thin latitude and meridian lines in
// the thread's colour. The meridians turn and the status ring's gap travels only while the orb
// works. The animation is SMIL inside the SVG, so no timer in the mod ever ticks for it. Ring
// colours are Claude Code's theme values (an SVG cannot read the theme), with a light-mode swap.
import type { OrbSize, OrbState } from '../types'

export const RING: Record<OrbState, { dark: string; light: string }> = {
  working: { dark: '#D97757', light: '#C6613F' },
  waiting: { dark: '#B1B9F9', light: '#5769F7' },
  done: { dark: '#4EBA65', light: '#2C7A39' },
  failed: { dark: '#FF6B80', light: '#AB2B3F' },
  stale: { dark: '#999999', light: '#666666' },
}

export const STATE_KEY: Record<OrbState, string> = { working: 'claude', waiting: 'suggestion', done: 'success', failed: 'error', stale: 'inactive' }

export function radiusOf(size: OrbSize | null): number {
  return size === 'a1.small' ? 28 : size === 'a1.large' ? 40 : 34
}

const f = (n: number) => Number(n.toFixed(1))

export function sphereSvg(o: { tint: string; state: OrbState; radius: number; isSelected: boolean }): string {
  const r = o.radius
  const pad = 6
  const size = (r + pad) * 2
  const c = size / 2
  const ring = RING[o.state]
  const isSpinning = o.state === 'working'
  const ringR = r + 3
  const around = f(2 * Math.PI * ringR)
  // At rest the two meridians stand at different turns, so a still globe shows both.
  const meridian = (begin: string, rx: number) =>
    `<ellipse cx="${c}" cy="${c}" rx="${f(r * rx)}" ry="${r}">${
      isSpinning ? `<animate attributeName="rx" values="${f(r * 0.95)};${f(r * 0.05)};${f(r * 0.95)}" dur="4s" begin="${begin}" repeatCount="indefinite" calcMode="spline" keySplines=".42 0 .58 1;.42 0 .58 1"/>` : ''
    }</ellipse>`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
    `<style>.ring{stroke:${ring.dark}}@media (prefers-color-scheme: light){.ring{stroke:${ring.light}}}</style>` +
    `<defs><radialGradient id="b" cx="42%" cy="38%" r="65%"><stop offset="0" stop-color="#2b3a3c"/><stop offset="1" stop-color="#0c1516"/></radialGradient>` +
    `<clipPath id="k"><circle cx="${c}" cy="${c}" r="${r}"/></clipPath></defs>` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="url(#b)"/>` +
    `<g clip-path="url(#k)" fill="none" stroke="${o.tint}" stroke-width="1" stroke-opacity="0.55">` +
    `<ellipse cx="${c}" cy="${c}" rx="${r}" ry="${f(r * 0.28)}"/>` +
    `<ellipse cx="${c}" cy="${f(c - r * 0.5)}" rx="${f(r * 0.87)}" ry="${f(r * 0.16)}"/>` +
    `<ellipse cx="${c}" cy="${f(c + r * 0.5)}" rx="${f(r * 0.87)}" ry="${f(r * 0.16)}"/>` +
    meridian('0s', 0.45) +
    meridian('-2s', 0.85) +
    `</g>` +
    `<circle class="ring" cx="${c}" cy="${c}" r="${ringR}" fill="none" stroke-width="${o.isSelected ? 2.5 : 1.5}" stroke-linecap="round"${
      isSpinning ? ` stroke-dasharray="${f(around * 0.84)} ${f(around * 0.16)}"` : ''
    }>${isSpinning ? `<animateTransform attributeName="transform" type="rotate" from="0 ${c} ${c}" to="360 ${c} ${c}" dur="2.4s" repeatCount="indefinite"/>` : ''}</circle>` +
    `</svg>`
  )
}

const STROKE = 1.5

// Inset by the stroke width, so the peak, the floor and the ends are drawn whole. One sample is a flat line.
export function sparkSvg(values: readonly number[], width: number, height: number, color: string): string {
  const series = values.length === 1 ? [values[0]!, values[0]!] : values
  const max = Math.max(1, ...series)
  const step = series.length > 1 ? (width - 2 * STROKE) / (series.length - 1) : 0
  const points = series.map((v, i) => `${f(STROKE + i * step)},${f(height - STROKE - (v / max) * (height - 2 * STROKE))}`).join(' ')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${
    series.length ? `<polyline fill="none" stroke="${color}" stroke-width="${STROKE}" stroke-linejoin="round" points="${points}"/>` : ''
  }</svg>`
}

const BARS = '▁▂▃▄▅▆▇█'

/** The terminal's sparkline: the last twelve samples as bars, scaled to their peak. */
export function sparkText(values: readonly number[]): string {
  const last = values.slice(-12)
  const max = Math.max(1, ...last)

  return last.map(v => BARS[Math.round((Math.max(0, v) / max) * 7)]).join('')
}

// SMIL elements, self-closing or with children (an animateMotion's mpath).
const SMIL = /<(animate(?:Transform|Motion)?)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1\s*>)/g

/** The same drawing without its animation: a finished step's icon stands still. */
export function stillSvg(svg: string): string {
  return svg.replace(SMIL, '')
}
