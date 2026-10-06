// Copy of skyline/hooks/icons.ts, so orbit's step icons match the bar. Keep it in sync by copying again.
// The activity line's pictures: a small animated SVG per category for the desktop app, a static
// trail of the turn's steps, and a one-cell glyph per category for the terminal. Strings only,
// built from module-level tables, so drawing an icon costs a template fill.

import type { CategoryId } from './activities'

// Claude Code's own theme values for each category, dark theme. An SVG drawn as a picture
// cannot read the theme, so each icon strokes in the dark value and a media query swaps in the
// light partner from LIGHT.
export const STROKE: Record<CategoryId, string> = {
  think: '#B1B9F9',
  read: '#B1B9F9',
  search: '#B1B9F9',
  edit: '#D97757',
  test: '#4EBA65',
  build: '#D97757',
  git: '#FFC107',
  github: '#FFC107',
  packages: '#D97757',
  shell: '#999999',
  web: '#B1B9F9',
  browser: '#B1B9F9',
  x: '#D97757',
  computer: '#B1B9F9',
  image: '#FFC107',
  oracle: '#B1B9F9',
  agents: '#B1B9F9',
  plan: '#999999',
  ask: '#FF6B80',
  data: '#B1B9F9',
  deploy: '#FFC107',
}

const LIGHT: Record<string, string> = {
  '#D97757': '#C6613F',
  '#B1B9F9': '#5769F7',
  '#4EBA65': '#2C7A39',
  '#FFC107': '#966C1E',
  '#999999': '#666666',
  '#FF6B80': '#AB2B3F',
}

export const GLYPH: Record<CategoryId, string> = {
  think: '✻',
  read: '▤',
  search: '⌕',
  edit: '✎',
  test: '⚗',
  build: '⚒',
  git: '⑂',
  github: '⇄',
  packages: '▣',
  shell: '›',
  web: '◍',
  browser: '▭',
  x: '𝕏',
  computer: '◈',
  image: '◆',
  oracle: '⟡',
  agents: '⁂',
  plan: '☰',
  ask: '?',
  data: '⛁',
  deploy: '⇪',
}

const EASE = '.42 0 .58 1'

// One looping SMIL animation, eased in and out between each pair of values (the app's pulse
// curve) unless `more` brings its own calcMode. translate, rotate and scale animate the
// transform; anything else is an attribute.
function anim(attr: string, values: string, dur: number, more = ''): string {
  const tag = /^(translate|rotate|scale)$/.test(attr) ? `animateTransform attributeName="transform" type="${attr}"` : `animate attributeName="${attr}"`
  const ease = more.includes('calcMode') ? '' : ` calcMode="spline" keySplines="${values.split(';').slice(1).map(() => EASE).join(';')}"`

  return `<${tag} values="${values}" dur="${dur}s"${ease}${more ? ` ${more}` : ''} repeatCount="indefinite"/>`
}

// A hop of one unit running `lag` seconds behind the first, so a row of them reads as a wave; the
// begin is negative so every one is already moving on the first frame. Nothing fades: every icon
// keeps its brightness, and moves by transform, position or a stroke drawing on.
const bob = (dur: number, lag = 0) => anim('translate', '0 0;0 -1;0 0', dur, `begin="${lag - dur}s"`)

// A stroke that draws on between keyTimes `from` and `to` of a 3 s loop, holds, then wipes off
// forward in the last fifth. Offsets of ±1.05 (past the path's length of 1) keep the round caps
// hidden while it is off. The loop starts in its hold, so the icon arrives whole.
const draw = (d: string, from: number, to: number) =>
  `<path d="${d}" pathLength="1" stroke-dasharray="1 1.1">${anim('stroke-dashoffset', '1.05;1.05;0;0;-1.05', 3, `keyTimes="0;${from};${to};.8;1" begin="-1.8s"`)}</path>`

const EYE = 'M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z'
const SHUT = 'M1.5 8s2.4 1.5 6.5 1.5S14.5 8 14.5 8s-2.4 1.5-6.5 1.5S1.5 8 1.5 8z'

// Each motif drawn on a 16 px grid, with its motion. Dots are zero-length round-capped strokes,
// so they take the stroke colour and its light-theme swap without a fill.
const PATHS: Record<CategoryId, string> = {
  // A four-point spark (not Anthropic's) turning slowly and swelling in ten 120 ms steps.
  think: `<g transform="translate(8 8)"><g>${anim('rotate', '0;90', 3, 'calcMode="linear"')}<path d="M0-6.75Q1.9-1.9 6.75 0Q1.9 1.9 0 6.75Q-1.9 1.9-6.75 0Q-1.9-1.9 0-6.75z">${anim('scale', '.86;.9;.95;1;1;1;.95;.9;.86;.86', 1.2, 'calcMode="discrete"')}</path></g></g>`,
  // A page whose lines write themselves in.
  read: `<path d="M9.5 1.75h-5A1.5 1.5 0 0 0 3 3.25v9.5a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5v-7.5zM9.5 1.75v3.5H13"/>${draw('M5.5 5.5H7', .05, .2)}${draw('M5.5 8.5h5', .2, .4)}${draw('M5.5 11.5h5', .4, .6)}`,
  // A magnifier circling a little, looking around.
  search: `<g><animateMotion path="M-.9 0a.9.9 0 1 0 1.8 0a.9.9 0 1 0-1.8 0" dur="2.4s" repeatCount="indefinite"/><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></g>`,
  // A pencil pivoting on its end so the nib scribbles.
  edit: `<g>${anim('rotate', '0 12 4;4 12 4;-3 12 4;3 12 4;0 12 4', 1.2)}<path d="M2.25 13.75l.9-3.4 7.6-7.6a1.75 1.75 0 0 1 2.5 2.5l-7.6 7.6zM3.15 10.35l2.5 2.5M9.35 4.15l2.5 2.5"/></g>`,
  // A flask with bubbles rising through the liquid and shrinking away toward the neck.
  test: `<path d="M5.5 1.75h5M6.5 1.75V6l-3.6 6.6a1 1 0 0 0 .9 1.4h8.4a1 1 0 0 0 .9-1.4L9.5 6V1.75M4.5 10h7"/><g stroke-width="1.75">${[0, .9].map((lag, i) => `<path d="M${7.25 + 1.5 * i} 13h0">${anim('translate', '0 0;0 -6', 1.8, `calcMode="linear" begin="${lag - 1.8}s"`)}${anim('stroke-width', '0;1.75;1.75;0', 1.8, `keyTimes="0;.1;.7;1" begin="${lag - 1.8}s"`)}</path>`).join('')}</g>`,
  // A hammer winding back and tapping down.
  build: `<g transform="rotate(45 8 8)"><g>${anim('rotate', '0 8 15.5;-14 8 15.5;0 8 15.5;0 8 15.5', 1.2, 'keyTimes="0;.35;.5;1"')}<rect x="4" y="4" width="8" height="3.75" rx="1"/><path d="M8 7.75V16"/></g></g>`,
  // A branch with a commit travelling from the trunk to the tip, growing out of one and shrinking
  // into the other (none at rest, where nothing moves it off the corner).
  git: `<path d="M4.5 2v8.25M11.5 6.25c0 3.2-2.2 5.75-5.25 5.75"/><circle cx="4.5" cy="12" r="1.75"/><circle cx="11.5" cy="4.5" r="1.75"/><path d="M0 0h0" stroke-width="0"><animateMotion path="M4.5 12h1.75c3.05 0 5.25-2.55 5.25-5.75V4.5" dur="1.8s" calcMode="spline" keyPoints="0;1" keyTimes="0;1" keySplines="${EASE}" repeatCount="indefinite"/>${anim('stroke-width', '0;2.5;2.5;0', 1.8, 'keyTimes="0;.15;.85;1"')}</path>`,
  // A pull request whose arrow nudges toward the base.
  github: `<circle cx="4" cy="4" r="1.75"/><circle cx="12" cy="12" r="1.75"/><path d="M4 5.75V14M9 4h1.5A1.5 1.5 0 0 1 12 5.5v4.75"/><g>${anim('translate', '0 0;-1.25 0;0 0;0 0', 1.8, 'keyTimes="0;.2;.45;1"')}<path d="M9.75 2 7.75 4l2 2M7.75 4h2.5"/></g>`,
  // A box whose lid hops and settles.
  packages: `<g>${anim('translate', '0 0;0 -1.25;0 0;0 -.4;0 0;0 0', 1.8, 'keyTimes="0;.12;.26;.34;.42;1"')}<rect x="2" y="2.25" width="12" height="3.25" rx="1"/></g><path d="M3 5.5v6.75a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V5.5M6.5 8.75h3"/>`,
  // A prompt with a command typing itself out.
  shell: `<path d="m2.75 3.5 4 4-4 4"/>${draw('M8 12.5h5.25', .05, .45)}`,
  // A turning globe: three meridians, a third of a turn apart, sweep from limb to limb
  // (sine-eased, as the projection moves); at either limb a meridian lies on the outline, so its
  // jump back is hidden.
  web: `<circle cx="8" cy="8" r="6.25"/><path d="M1.75 8h12.5"/>${[0, -1, -2].map((begin) => `<path d="M8 1.75v12.5">${anim('d', 'M8 1.75c-8.33 0-8.33 12.5 0 12.5;M8 1.75c8.33 0 8.33 12.5 0 12.5', 3, `calcMode="spline" keySplines=".37 0 .63 1" begin="${begin}s"`)}</path>`).join('')}`,
  // A window whose page loads, line by line.
  browser: `<rect x="1.75" y="2" width="12.5" height="12" rx="2"/><path d="M1.75 6.25h12.5M4 4.1h0M6.25 4.1h0"/>${draw('M4.5 9.25h7', .05, .3)}${draw('M4.5 11.5h4.5', .3, .5)}`,
  // An X hopping, whole and at full strength throughout.
  x: `<g>${bob(1.8)}<path d="M3 3l10 10M13 3 3 13"/></g>`,
  // A pointer clicking: rays burst out from its tip, then settle back.
  computer: `<path d="M5.5 5.5l8.5 3.5-3.5 1.5-1.5 3.5z"/><g transform="translate(5.5 5.5)"><g>${anim('scale', '.75;1.15;.75;.75', 1.2, 'keyTimes="0;.15;.5;1"')}<path d="M0-2.25V-4M-2.25 0H-4M-1.6-1.6-2.8-2.8"/></g></g>`,
  // A picture with the sun sweeping across its sky, rising and setting.
  image: `<rect x="2" y="2" width="12" height="12" rx="2"/><path d="m2.5 13 3.75-3.75 2.5 2.5 1.75-1.75 3 3"/><circle cx="5" cy="6.25" r="1"><animateMotion path="M0 0Q3-2.5 6 0" dur="3s" begin="-1.5s" repeatCount="indefinite"/>${anim('r', '0;1;1;0', 3, 'keyTimes="0;.2;.8;1" begin="-1.5s"')}</circle>`,
  // An eye that blinks now and then.
  oracle: `<path d="${EYE}">${anim('d', `${EYE};${EYE};${SHUT};${EYE}`, 3, 'keyTimes="0;.88;.94;1"')}</path><circle cx="8" cy="8" r="1.9">${anim('r', '1.9;1.9;0;1.9', 3, 'keyTimes="0;.88;.94;1"')}</circle>`,
  // Two figures bobbing in turn.
  agents: [4.5, 11.5].map((x, i) => `<g>${anim('translate', '0 0;0 -1;0 0', 1.2, `begin="${-0.6 * i}s"`)}<circle cx="${x}" cy="5" r="1.75"/><path d="M${x - 2.5} 12.5v-.5a2.5 2.5 0 0 1 5 0v.5"/></g>`).join(''),
  // A checklist ticking itself off.
  plan: `<path d="M8.5 3.5h5.25M8.5 8h5.25M8.5 12.5h5.25"/>${draw('m2.25 3.5 1.25 1.25 2.5-2.5', .05, .2)}${draw('m2.25 8 1.25 1.25 2.5-2.5', .25, .4)}${draw('m2.25 12.5 1.25 1.25 2.5-2.5', .45, .6)}`,
  // A speech bubble with someone typing.
  ask: `<path d="M4 2.75h8a1.75 1.75 0 0 1 1.75 1.75v5a1.75 1.75 0 0 1-1.75 1.75H7.5l-2.75 2.25v-2.25H4a1.75 1.75 0 0 1-1.75-1.75v-5A1.75 1.75 0 0 1 4 2.75z"/><g stroke-width="2"><path d="M5.25 7h0">${bob(1.8)}</path><path d="M8 7h0">${bob(1.8, .3)}</path><path d="M10.75 7h0">${bob(1.8, .6)}</path></g>`,
  // A database with a ring sweeping down its drum, from the lid's rim to the base, where it lies
  // on a ring already drawn, so its jump back is hidden.
  data: `<path d="M2.5 3.75v8.5M13.5 3.75v8.5"/><ellipse cx="8" cy="3.75" rx="5.5" ry="2"/><path d="M2.5 12.25a5.5 2 0 0 0 11 0"/><path d="M2.5 8a5.5 2 0 0 0 11 0">${anim('translate', '0 -4.25;0 4.25', 1.8)}</path>`,
  // A rocket lifting on a flickering flame.
  deploy: `<g>${anim('translate', '0 0;0 -1;0 0', 1.2)}<path d="M8 2C9.6 3.25 10.25 5.25 10.25 7.5v3.75h-4.5V7.5C5.75 5.25 6.4 3.25 8 2zM5.75 8.25 4 10v2.25l1.75-1M10.25 8.25 12 10v2.25l-1.75-1"/><circle cx="8" cy="6.25" r="1"/><path d="M8 13v1.25">${anim('d', 'M8 13v1.25;M8 13v.5;M8 13v1;M8 13v.25', 0.48, 'calcMode="discrete"')}</path></g>`,
}

/**
 * The category's animated icon, at full strength throughout. SMIL runs where the surface
 * animates an SVG image; elsewhere the icon stands whole.
 */
// ponytail: SMIL ignores prefers-reduced-motion and CSS cannot pause it, so the icons move even
// for people who asked for less motion; the motion is kept small and slow instead. Honouring it
// needs the caller to pass a static flag and drop the animate elements.
export function iconSvg(category: CategoryId, size = 14): string {
  const stroke = STROKE[category]

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><style>@media (prefers-color-scheme: light){svg{stroke:${LIGHT[stroke]}}}</style>${PATHS[category]}</svg>`
}

// The trail's ticks fill in their dark colours; one rule per colour swaps in the light partner.
const TRAIL_LIGHT = `<style>@media (prefers-color-scheme: light){${Object.entries(LIGHT).map(([dark, light]) => `[fill="${dark}"]{fill:${light}}`).join('')}}</style>`

/**
 * The turn's steps as a static row of ticks, newest on the right: 3 px wide with 2 px gaps,
 * a third of the height when done and full height while running. Done steps are dimmed; a
 * failed one stays bright red, since its clay or amber neighbours are close in hue at .55.
 * Older steps that do not fit the width are left off.
 */
export function trailSvg(ticks: readonly { category: CategoryId; ok: boolean; isRunning: boolean }[], width: number, height: number): string {
  const shown = ticks.slice(Math.max(0, ticks.length - Math.floor((width + 2) / 5)))
  const rects = shown.map((tick, i) => {
    const h = tick.isRunning ? height : height / 3

    return `<rect x="${width - (shown.length - i) * 5 + 2}" y="${(height - h) / 2}" width="3" height="${h}" rx="1.5" fill="${tick.ok ? STROKE[tick.category] : '#FF6B80'}"${tick.isRunning || !tick.ok ? '' : ' opacity=".55"'}/>`
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${TRAIL_LIGHT}${rects.join('')}</svg>`
}
