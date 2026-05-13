module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/tests/**/*.test.js', '**/*.test.js'],
    collectCoverageFrom: ['src/**/*.js', '!src/seeders/**', '!src/scripts/**'],
    coverageDirectory: 'coverage',
    verbose: true,
    testTimeout: 15000,
};
