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

const { launch } = require('./launch');

launch('fastIndex');
