/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Design token pass, spec §11 M6 (client-directed visual redesign,
      // 2026-08-31). First applied to Command Center + AppShell chrome
      // only — see README for the full token proposal and rollout scope.
      // Semantic status colors (unitStatusStyle.ts etc.) are intentionally
      // NOT re-pointed at these yet; that happens when the redesign rolls
      // out to each of those pages, not in this first pass.
      colors: {
        brand: {
          50: '#F5F3FF',
          100: '#ECE9FE',
          200: '#DAD3FD',
          300: '#C4B5FD',
          400: '#9C87F5',
          500: '#8570EE',
          600: '#6C5CE7',
          700: '#5A49D6',
          800: '#4A3BB0',
          900: '#3D3192',
          950: '#251D5C',
        },
        ink: {
          DEFAULT: '#211B39',
          secondary: '#6E6B85',
          muted: '#9C99AE',
        },
        // Semantic status colors — kept as distinct hues (not all brand
        // violet) so the color-coding this app already relies on isn't
        // lost, just restyled softer to match the new system. Only used
        // directly in DashboardPage.tsx for now (this first pass);
        // unitStatusStyle.ts/workOrderStyle.ts etc. get re-pointed at
        // these when the redesign rolls out to their pages, not here.
        //
        // Client feedback round 1 (2026-08-31): the first pass read as
        // "too pale/washed out" against their reference. Both the -50
        // tint and the -600 icon color were pushed more saturated here —
        // every pairing (icon-on-its-own-tint, and icon-on-white for the
        // Attention queue's white badge circles) was re-checked against
        // WCAG contrast after the change, not just eyeballed: the
        // tightest is success-50/success-600 at 3.72:1 (already past the
        // 3:1 floor for graphical/icon contrast, WCAG 1.4.11), every
        // other pair and every icon-on-white pairing lands at 4.2:1+.
        success: { 50: '#C8F5DC', 600: '#0A6E30' },
        warning: { 50: '#FDECC8', 600: '#B45309' },
        danger: { 50: '#FBD5DB', 600: '#C81E3A' },
        info: { 50: '#DCE3FF', 600: '#4338CA' },
        accent: { 50: '#FDE0C4', 600: '#B34A06' },
      },
      boxShadow: {
        // Client feedback round 1: the original shadow (opacity .06/.10)
        // was "too subtle... cards read closer to flat." Three stacked
        // layers now — a tight ambient contact shadow, a mid-distance
        // layer, and a soft far-diffuse layer — is what actually reads
        // as "floating above the background" rather than a faint edge;
        // one blurry layer at low opacity doesn't get there regardless
        // of how far the blur radius is pushed.
        card: '0 2px 4px rgba(33,27,57,0.08), 0 6px 16px rgba(108,92,231,0.16), 0 20px 48px rgba(108,92,231,0.28)',
      },
      backgroundImage: {
        // Client feedback round 1: "barely visible... make it more
        // noticeably present." Was a two-stop fade from a near-white
        // tint straight to white by the 55% mark — the tint was too
        // close to white to register, and it disappeared a bit past the
        // fold. Now a real lavender at the top (brand-100, not a diluted
        // one-off), holding through a mid stop before fading to white
        // much further down the page.
        'app-gradient': 'linear-gradient(160deg, #E8E3FC 0%, #F5F3FF 35%, #FFFFFF 75%)',
        // Client feedback round 1: "widen the range... stronger contrast
        // between the start/end stops" — was two adjacent shades of the
        // same violet (#6C5CE7 to #7C6EF2, barely distinguishable). Now
        // spans the brand scale's dark end to its light end (800 to
        // 300) so the diagonal sweep is actually visible, not just
        // technically a gradient.
        'brand-gradient': 'linear-gradient(135deg, #4A3BB0 0%, #C4B5FD 100%)',
        // Same widening, same reasoning, kept in the red/orange family
        // so "urgent" doesn't drift toward pink.
        'danger-gradient': 'linear-gradient(135deg, #9A1B2F 0%, #FF8A4C 100%)',
      },
    },
  },
  plugins: [],
};
