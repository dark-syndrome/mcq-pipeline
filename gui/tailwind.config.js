/** @type {import('tailwindcss').Config} */
// Color tokens are the canonical palette from GUI_SPEC.md §8.3 (dark theme).
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0e1a', // app root background (near-black navy)
        surface: '#111827', // card and panel backgrounds
        border: '#1e293b', // subtle dividers, card outlines
        primary: '#3b82f6', // CTA buttons, active states, links
        success: '#10b981', // accepted questions, PASS badges
        warning: '#f59e0b', // duplicates, linter WARNs, modified fields
        danger: '#ef4444', // rejections, errors, linter FAILs
        text: '#f1f5f9', // main body text
        muted: '#64748b', // labels, metadata, secondary info
      },
    },
  },
  plugins: [],
}
