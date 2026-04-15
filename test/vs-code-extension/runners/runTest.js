#!/usr/bin/env node

/**
 * VS Code Extension Test Runner
 * 
 * This is the main test runner for the RequireOnRails VS Code extension.
 * It uses @vscode/test-electron to download VS Code, install the extension,
 * and run all tests in a proper VS Code extension host environment.
 * 
 * Features:
 * - Downloads and manages VS Code test instances
 * - Loads the extension in development mode
 * - Runs tests with access to full VS Code API
 * - Disables other extensions during testing for isolation
 * - Provides proper error handling and exit codes
 * 
 * Usage: node ./test/runTest.js
 */

const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
    try {
        // The folder containing the Extension Manifest package.json
        // Passed to `--extensionDevelopmentPath`
        const extensionDevelopmentPath = path.resolve(__dirname, '../..');

        // The path to test runner
        // Passed to --extensionTestsPath
        const extensionTestsPath = path.resolve(__dirname, '../indexes/index');

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
