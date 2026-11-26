import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: ['out/test/*.test.js', 'out/test/suite/*.test.js'],
  workspaceFolder: './test-fixtures/workspace',
  launchArgs: ['--disable-extensions'],
  mocha: {
    ui: 'bdd',
    timeout: 20000,
  },
});
