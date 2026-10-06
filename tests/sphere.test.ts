import { expect, test } from 'claude-code/testing'

import { CATEGORIES, type CategoryId } from '../hooks/activities'
import { iconSvg } from '../hooks/icons'
import { radiusOf, RING, sparkSvg, sparkText, sphereSvg, stillSvg } from '../hooks/sphere'

const states = ['working', 'waiting', 'done', 'failed', 'stale'] as const

test('only a working orb animates', async () => {
  for (const state of states) {
    const svg = sphereSvg({ tint: '#7dd3c0', state, radius: 28, isSelected: false })
    expect(svg.includes('<animate')).toBe(state === 'working')
  }
})

test('the ring carries the state colour in both themes', async () => {
  const svg = sphereSvg({ tint: '#7dd3c0', state: 'failed', radius: 28, isSelected: false })
  expect(svg).toContain(RING.failed.dark)
  expect(svg).toContain(RING.failed.light)
  expect(svg).toContain('prefers-color-scheme: light')
})

test('the sphere is safe, small and has no glow', async () => {
  for (const state of states) {
    const svg = sphereSvg({ tint: '#7dd3c0', state, radius: 40, isSelected: true })
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.length).toBeLessThan(4000)
    expect(/<script|\son[a-z]+=|feGaussianBlur|filter=/i.test(svg)).toBe(false)
  }
})

test('sizes map to radii', async () => {
  expect([radiusOf('a1.small'), radiusOf('a1.medium'), radiusOf('a1.large'), radiusOf(null)]).toEqual([28, 34, 40, 34])
})

test('a still globe draws two distinct meridians, and a working one turns both as before', async () => {
  // The meridians are the ellipses as tall as the globe (radius 28, centred in a 68 px box).
  const meridians = (svg: string) => [...svg.matchAll(/<ellipse cx="34" cy="34" rx="([\d.]+)" ry="28"/g)].map(m => Number(m[1]))
  for (const state of ['waiting', 'done', 'failed', 'stale'] as const) {
    expect(meridians(sphereSvg({ tint: '#7dd3c0', state, radius: 28, isSelected: false }))).toEqual([12.6, 23.8])
  }
  const working = sphereSvg({ tint: '#7dd3c0', state: 'working', radius: 28, isSelected: false })
  expect(working.match(/<animate attributeName="rx" values="26.6;1.4;26.6" dur="4s" begin="(0s|-2s)"/g)).toHaveLength(2)
})

test('sparkSvg draws one polyline scaled to its box, inset by the stroke width so no edge clips it', async () => {
  expect(sparkSvg([0, 50, 100], 100, 20, '#D97757')).toContain('points="1.5,18.5 50,10 98.5,1.5"')
  expect(sparkSvg([], 100, 20, '#D97757')).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 20" width="100" height="20"></svg>')
})

test('sparkSvg draws a single sample as a flat line', async () => {
  expect(sparkSvg([40], 100, 20, '#D97757')).toContain('points="1.5,1.5 98.5,1.5"')
})

test('sparkText draws the last twelve samples as bars, scaled to their peak', async () => {
  expect(sparkText([0, 50, 100])).toBe('▁▅█')
  expect(sparkText([7])).toBe('█')
  expect(sparkText([])).toBe('')
  expect([...sparkText(Array.from({ length: 20 }, (_, i) => i))]).toHaveLength(12)
})

test('stillSvg drops every SMIL animation, self-closing or paired, and keeps the drawing', async () => {
  const svg = '<svg><g><animateMotion path="M0 0h1" dur="1s"><mpath href="#p"/></animateMotion><circle r="1"><animate attributeName="r" values="0;1" dur="1s"/></circle>' +
    '<path d="M0 0"><animateTransform attributeName="transform" type="rotate" values="0;90" dur="3s"></animateTransform></path></g></svg>'
  expect(stillSvg(svg)).toBe('<svg><g><circle r="1"></circle><path d="M0 0"></path></g></svg>')
})

test('every step icon has a still form with the same shapes and no motion', async () => {
  const shapes = (svg: string) => svg.match(/<(path|circle|rect|ellipse|g|line|polyline)\b/g) ?? []
  for (const category of Object.keys(CATEGORIES) as CategoryId[]) {
    const moving = iconSvg(category)
    const still = stillSvg(moving)
    expect(/<animate|<set\b/.test(still)).toBe(false)
    expect(still.startsWith('<svg')).toBe(true)
    expect(shapes(still)).toEqual(shapes(moving))
  }
})
