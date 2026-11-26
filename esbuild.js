// Bundles the extension into dist/extension.js and copies the margin panel's
// webview files next to it.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

function copyWebview() {
  const from = path.join(__dirname, 'src', 'webview');
  const to = path.join(__dirname, 'dist', 'webview');
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    fs.copyFileSync(path.join(from, name), path.join(to, name));
  }
}

/** @type {import('esbuild').Plugin} */
const problemMatcher = {
  name: 'problem-matcher',
  setup(build) {
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      }
      copyWebview();
      console.log('[esbuild] build finished');
    });
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'silent',
    plugins: [problemMatcher],
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
