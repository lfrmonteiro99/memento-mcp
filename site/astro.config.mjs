// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://lfrmonteiro99.github.io',
  base: '/memento-mcp',
  trailingSlash: 'never',
  vite: {
    plugins: [tailwindcss()],
  },
});
