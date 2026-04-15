# Test Directory Organization

This directory contains all test files for the RequireOnRails VS Code extension, organized into a logical structure for better maintainability and clarity.

## Structure

```
test/
├── runners/           # Test runner scripts
├── indexes/           # Test index files for different test suites  
├── suites/            # Actual test files
└── utils/             # Test utilities and helpers
```

## Directories

### `runners/`
Contains the main test runner scripts that use `@vscode/test-electron` to execute tests in a VS Code extension environment:

- **`runTest.js`** - Main test runner for all tests (includes slow integration tests)
- **`runFastTest.js`** - Fast test runner excluding slow integration tests (used in CI/build)
- **`runSimpleTest.js`** - Simple test runner for configuration tests only (development/debugging)

### `indexes/`
Contains test index files that configure Mocha and discover test files:

- **`index.js`** - Main test index that runs all test suites
- **`fastIndex.js`** - Fast test index that excludes `vsix.test.js` for quick CI execution
- **`simpleIndex.js`** - Simple test index that runs only configuration tests

### `suites/`
Contains the actual test files organized by functionality:

- **`configuration.test.js`** - Tests for configuration handling and validation
- **`extension.test.js`** - Tests for core extension functionality
- **`fileAliasGeneration.test.js`** - Tests for file alias generation logic
- **`lineHiding.test.js`** - Tests for import require line hiding features
- **`performance.test.js`** - Performance tests for large codebases
- **`requireStatementUpdates.test.js`** - Tests for require statement updates
- **`vsix.test.js`** - Integration tests for VSIX packaging and project templates

### `utils/`
Contains shared test utilities and helpers:

- **`testUtils.js`** - Common test utilities, mocks, and helper functions

## Usage

### Running Tests

```bash
# Run all tests (including slow integration tests)
npm test

# Run fast tests (excludes slow integration tests - used in CI)
npm run test:fast

# Run simple tests (configuration tests only)
node ./test/runners/runSimpleTest.js
```

### Test Development

1. **Add new test suites**: Create new `.test.js` files in `test/suites/`
2. **Modify test runners**: Update files in `test/runners/` to change test execution behavior
3. **Update test discovery**: Modify files in `test/indexes/` to change which tests are included
4. **Add test utilities**: Add shared helpers to `test/utils/testUtils.js`

## Test Environment

All tests run in a VS Code extension host environment using `@vscode/test-electron`, which:

- Downloads and manages VS Code test instances
- Loads the extension in development mode
- Provides access to the full VS Code API
- Isolates tests by disabling other extensions
- Supports proper error handling and exit codes

## Performance

- **Fast tests**: ~37 tests completing in ~300ms
- **Full tests**: Includes integration tests that may take longer
- **Simple tests**: Only configuration tests for quick validation
