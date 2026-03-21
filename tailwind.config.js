/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Dark theme colors
        'bg-primary': '#1a1a2e',
        'bg-secondary': '#16213e',
        'bg-tertiary': '#0f3460',
        'accent': '#e94560',
        'accent-hover': '#ff6b6b',
        'text-primary': '#eaeaea',
        'text-secondary': '#a0a0a0',
      },
    },
  },
  plugins: [],
}
