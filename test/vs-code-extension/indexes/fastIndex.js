/**
 * Fast Test Runner Index
 * 
 * This test runner executes all tests except the slow integration tests
 * (specifically excludes vsix.test.js). It's designed for CI/CD pipelines
 * and development workflows where quick feedback is important.
 * 
 * Features:
 * - Runs all tests except slow integration tests
 * - Optimized for CI/CD with reasonable timeouts (10 seconds)
 * - Excludes resource-intensive VSIX project template tests
 * - Provides comprehensive coverage while maintaining speed
 * - Used by the build process for validation
 * 
 * Used by: runFastTest.js and npm run test:fast
 */

const path = require('path');
const Mocha = require('mocha');
const { glob } = require('glob');

function run() {
    // Create the mocha test
    const mocha = new Mocha({
        ui: 'tdd',
        color: true,
        timeout: 10000 // 10 second timeout for fast tests
    });

    const testsRoot = path.resolve(__dirname);

    return new Promise(async (c, e) => {
        try {
            // Run all tests except the slow VSIX test
            const files = await glob('**/**.test.js', { 
                cwd: path.resolve(testsRoot, '../suites'),
                ignore: 'vsix.test.js' // Skip the slow integration test
            });

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
