import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// Tests execute inside workerd via the Cloudflare-supported Vitest integration.
// No real Cloudflare account, resources, or network access are required:
// wrangler.jsonc declares no bindings in Phase 0, so tests receive only vars.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
