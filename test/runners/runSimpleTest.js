#!/usr/bin/env node

/**
 * Simple Test Runner
 * 
 * A lightweight test runner that executes only configuration tests
 * in the VS Code extension environment. This is useful for quick
 * validation during development without running the full test suite.
 * 
 * Features:
 * - Runs minimal test subset (configuration tests only)
 * - Quick execution for development workflow
 * - Uses VS Code extension host for proper API access
 * - Isolated testing environment
 * 
 * Usage: node ./test/runSimpleTest.js
 */

const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
    try {
        // The folder containing the Extension Manifest package.json
        const extensionDevelopmentPath = path.resolve(__dirname, '../..');

        // The path to test runner
        const extensionTestsPath = path.resolve(__dirname, '../indexes/simpleIndex');

        // Download VS Code, unzip it and run the integration test
        await runTests({ 
            extensionDevelopmentPath, 
            extensionTestsPath,
            launchArgs: ['--disable-extensions'] // Disable other extensions during testing
        });
    } catch (err) {
        console.error('Failed to run tests:', err);
        process.exit(1);
    }
}

main();
