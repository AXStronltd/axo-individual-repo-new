import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Unit tests (money, ledger) run with no external services.
    // Integration tests that need Postgres/Redis are gated behind
    // DATABASE_URL pointing at a test database; see test/README.md.
  },
});
