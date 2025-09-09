/**
 * Simple Test Runner Index
 * 
 * This is a minimal test runner designed to run only the configuration tests
 * for quick validation during development. It's useful for testing specific
 * functionality without running the full test suite.
 * 
 * Features:
 * - Runs only configuration.test.js
 * - Faster execution (5 second timeout)
 * - Minimal setup for quick validation
 * - Good for development and debugging specific tests
 * 
 * Used by: runSimpleTest.js
 */

const path = require('path');
const Mocha = require('mocha');
const { glob } = require('glob');

function run() {
    // Create the mocha test
    const mocha = new Mocha({
        ui: 'tdd',
        color: true,
        timeout: 5000 // 5 second timeout for simpler tests
    });

    const testsRoot = path.resolve(__dirname);

    return new Promise(async (c, e) => {
        try {
            // Only run configuration tests for now
            const files = await glob('configuration.test.js', { cwd: path.resolve(testsRoot, '../suites') });

            if (files.length === 0) {
                return c(); // No tests to run
            }

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
