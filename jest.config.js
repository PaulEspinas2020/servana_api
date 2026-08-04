/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/*.test.js', '**/tests/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', 'admin-dedup\\.test\\.ts$', 'catalog-service\\.test\\.ts$'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
};
