/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#005A9C', // azul UC
          dark: '#003D6B',
          light: '#3D8FC4',
        },
      },
    },
  },
  plugins: [],
};
