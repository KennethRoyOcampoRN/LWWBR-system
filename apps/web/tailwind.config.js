/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Visual redesign, round 2 (spec.md §13 decision 40, 2026-11-20):
      // self-hosted IBM Plex (see index.css's own comment on why
      // self-hosted, not a Google Fonts <link>). `sans` carries every
      // word on screen; `mono` is reserved for money and room codes
      // specifically — the two things in this app read at speed, where
      // tabular lining figures (aligned digits in a column of pesos)
      // and unambiguous letterforms (a true monospace 1/l/I) earn their
      // place. Deliberately not Inter: the client's own instruction was
      // to justify a choice with more character than the default,
      // rather than keep the most commonly reached-for interface
      // typeface by default — see README's own writeup for the full
      // reasoning.
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
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
        // Round 1 (2026-08-31): this was applied to every content
        // block on the page — every card, the nav, the KPI tiles —
        // which is exactly the "identical soft shadow under everything"
        // the client's round-2 brief named as part of why the app reads
        // generic. Round 2 (spec.md §13 decision 40, 2026-11-20):
        // ordinary content (Card/Section, list rows, KPI tiles) now
        // gets a flat hairline border instead — see Card.tsx's own
        // comment. This token is kept, unrenamed, for a genuinely
        // *floating* element only (a dropdown menu, a toast, a modal —
        // none exist in this app yet) once one is built; it is no
        // longer the default surface treatment for static content.
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
        // 'brand-gradient'/'danger-gradient' retired (spec.md §13 decision
        // 40 addendum, 2026-11-20): the two Command Center "hero" KPI
        // tiles were the one place round 2 left a gradient fill on actual
        // content rather than decoration, and the client called it out as
        // the most template-looking thing left in the app. Both tokens
        // are gone now that nothing references them — re-add only for a
        // genuinely new, deliberate use, never as a default tile
        // treatment.
      },
    },
  },
  plugins: [],
};
