import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [tailwind()],
  // El frontend en Docker se sirve en el puerto 3000
  server: { port: 3000, host: true },
  vite: {
    define: {
      // Variables de entorno accesibles en cliente (PUBLIC_*)
    },
  },
});
