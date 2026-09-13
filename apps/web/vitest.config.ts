import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
  },
  resolve: {
    // Mirror tsconfig's `@/*` so component tests resolve the kit's imports.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // jsx: the app's tsconfig leaves JSX for Next to compile; component
  // tests need esbuild to emit it.
  esbuild: { target: 'es2022', jsx: 'automatic' },
});
