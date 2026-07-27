/**
 * Shared launch logic for the VS Code extension test runners.
 *
 * Each runner differs only in which test index it loads, so everything else lives here.
 */

const path = require('path');
const { runTests } = require('@vscode/test-electron');

// VS Code's own extension host sets ELECTRON_RUN_AS_NODE=1. @vscode/test-electron passes
// the whole environment through to the VS Code it downloads, and that variable makes
// Code.exe start as a plain Node process, which rejects every VS Code CLI flag
// ("bad option: --disable-extensions", exit 9). Stripping it lets `npm test` run from
// VS Code's integrated terminal and not just an external shell.
delete process.env.ELECTRON_RUN_AS_NODE;

// The extension manifest lives at the repo root, three levels up from this directory.
const extensionDevelopmentPath = path.resolve(__dirname, '../../..');

async function launch(indexName) {
    try {
        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath: path.resolve(__dirname, '..', 'indexes', indexName),
            launchArgs: ['--disable-extensions'] // Disable other extensions during testing
        });
    } catch (err) {
        console.error('Failed to run tests:', err);
        process.exit(1);
    }
}

module.exports = { launch };
