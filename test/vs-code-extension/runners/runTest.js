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

const { launch } = require('./launch');

launch('index');
