/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': [
      'ts-jest',
      {
        isolatedModules: true,
      },
    ],
  },
  testEnvironment: 'node',
  roots: ['<rootDir>/apps/core/src/modules/admin'],
  moduleNameMapper: {
    '^@app/common(|/.*)$': '<rootDir>/libs/common/src/$1',
  },
  maxWorkers: 1,
};
