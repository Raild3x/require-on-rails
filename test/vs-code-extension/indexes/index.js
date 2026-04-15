/**
 * Main Test Runner Index
 * 
 * This file serves as the main test entry point for VS Code extension testing.
 * It configures Mocha to run all test files (*.test.js) in the VS Code extension
 * environment using the @vscode/test-electron framework.
 * 
 * Features:
 * - Automatically discovers and runs all *.test.js files
 * - Configures Mocha with TDD interface and colored output
 * - Sets reasonable timeout for VS Code extension tests (30 seconds)
 * - Returns proper exit codes for CI/CD integration
 */

const path = require('path');
const Mocha = require('mocha');
const { glob } = require('glob');

function run() {
    // Create the mocha test
    const mocha = new Mocha({
        ui: 'tdd',
        color: true,
        timeout: 30000 // 30 second timeout
    });

    const testsRoot = path.resolve(__dirname);

    return new Promise(async (c, e) => {
        try {
            const files = await glob('**/**.test.js', { cwd: path.resolve(testsRoot, '../suites') });

            // Add files to the test suite
            files.forEach(f => mocha.addFile(path.resolve(testsRoot, '../suites', f)));

            try {
                // Run the mocha test
                mocha.run(failures => {
                    if (failures > 0) {
                        e(new Error(`${failures} tests failed.`));
                    } else {
                        c();
                    }
                });
            } catch (err) {
                console.error(err);
                e(err);
            }
        } catch (err) {
            return e(err);
        }
    });
}

module.exports = {
    run
};
