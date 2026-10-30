// PIXEL R1.10.4.2 — standalone config for the PERMANENT D1 prepare/terminal
// contract control (R1141-02). Deliberately SEPARATE from the accepted
// vitest.config.ts and from the trace config so NO registered suite count
// (product 1142 / DB 301 / trace 50 / lab 30) changes. This file has its OWN
// count (4 tests) and its OWN run log.
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
  test: {
    include: ['audit-tools/d1-contract/**/*.test.ts'],
  },
});
