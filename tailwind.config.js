/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        redstone: {
          400: '#fb7185',
          500: '#ef4444',
        },
        panel: '#0b0f14',
      },
      boxShadow: {
        'panel': '0 10px 30px rgba(0,0,0,.35)',
      },
    },
    fontFamily: {
      sans: ['ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'Inter', 'Helvetica Neue', 'Arial', 'Noto Sans', 'Apple Color Emoji', 'Segoe UI Emoji'],
    },
  },
  plugins: [],
};