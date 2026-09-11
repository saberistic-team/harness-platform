export default {
  root: '/workspace',
  cacheDir: '/tmp/harness-vite',
  test: {
    environment: 'node',
    include: ['apps/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'services/*/test/**/*.test.ts'],
    cache: false,
    reporters: ['default'],
    testTimeout: 5000,
    hookTimeout: 5000,
  },
};
