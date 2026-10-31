/** @type {import('tailwindcss').Config} */
export default {
  // Dark mode follows the OS preference (prefers-color-scheme), per spec.
  darkMode: 'media',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {},
  },
  plugins: [],
};
