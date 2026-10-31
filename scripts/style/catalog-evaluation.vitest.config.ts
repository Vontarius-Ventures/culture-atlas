import { defineConfig } from 'vitest/config';

// Pure/local-file tests: intentionally no shared database global setup.
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'scripts/style/visual-catalog.test.ts',
      'scripts/style/commons-visual-catalog.test.ts',
      'packages/domain/src/style/visual-catalog.test.ts',
      'scripts/style/intent-recommendation-audit.test.ts',
    ],
  },
});
