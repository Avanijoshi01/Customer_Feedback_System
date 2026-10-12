// Jest config for ESM project (type: "module" in package.json)
// Run via: node --experimental-vm-modules node_modules/.bin/jest --runInBand
export default {
  testEnvironment: 'node',
  transform: {},
  testMatch: ['**/tests/**/*.test.js'],
};
