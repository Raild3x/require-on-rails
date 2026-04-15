#!/usr/bin/env node

/**
 * Fast Test Runner
 * 
 * This runner executes the fast test suite, which includes all tests
 * except the slow integration tests. It's the primary test runner used
 * in CI/CD pipelines and the build process for quick validation.
 * 
 * Features:
 * - Runs comprehensive test suite excluding slow integration tests
 * - Optimized for build processes and CI/CD
 * - Uses VS Code extension host for proper API testing
 * - Fast execution suitable for development workflows
 * - Provides good coverage with reasonable execution time
 * 
 * Usage: node ./test/runFastTest.js or npm run test:fast
 */

const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
    try {
        // The folder containing the Extension Manifest package.json
        const extensionDevelopmentPath = path.resolve(__dirname, '../..');

        // The path to test runner (fast tests only)
        const extensionTestsPath = path.resolve(__dirname, '../indexes/fastIndex');

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
