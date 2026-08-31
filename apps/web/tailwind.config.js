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
        success: { 50: '#E7F9F0', 600: '#16A34A' },
        warning: { 50: '#FEF6E7', 600: '#D97706' },
        danger: { 50: '#FDEDF0', 600: '#DC2626' },
        info: { 50: '#EEF2FF', 600: '#4F46E5' },
        accent: { 50: '#FFF1E6', 600: '#C2570C' },
      },
      boxShadow: {
        card: '0 1px 2px rgba(108,92,231,0.06), 0 8px 24px rgba(108,92,231,0.10)',
      },
      backgroundImage: {
        'app-gradient': 'linear-gradient(160deg, #F7F5FE 0%, #FFFFFF 55%)',
        'brand-gradient': 'linear-gradient(135deg, #6C5CE7 0%, #7C6EF2 100%)',
        'danger-gradient': 'linear-gradient(135deg, #E11D48 0%, #F0653C 100%)',
      },
    },
  },
  plugins: [],
};
