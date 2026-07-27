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

const { launch } = require('./launch');

launch('simpleIndex');
