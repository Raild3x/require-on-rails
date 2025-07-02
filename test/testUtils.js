const fs = require('fs');
const path = require('path');

/**
 * Creates a temporary test workspace with specified structure
 * @param {string} basePath - Base path for the test workspace
 * @param {Object} structure - Object describing the directory/file structure
 */
function createTestWorkspace(basePath, structure) {
    function createItem(itemPath, content) {
        const fullPath = path.join(basePath, itemPath);
        const dir = path.dirname(fullPath);
        
        // Ensure directory exists
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        if (typeof content === 'string') {
            // It's a file
            fs.writeFileSync(fullPath, content, 'utf8');
        } else if (content === null) {
            // It's a directory
            if (!fs.existsSync(fullPath)) {
                fs.mkdirSync(fullPath, { recursive: true });
            }
        }
    }
    
    for (const [itemPath, content] of Object.entries(structure)) {
        createItem(itemPath, content);
    }
}

/**
 * Cleans up a test workspace
 * @param {string} basePath - Path to clean up
 */
function cleanupTestWorkspace(basePath) {
    if (fs.existsSync(basePath)) {
        fs.rmSync(basePath, { recursive: true, force: true });
    }
}

/**
 * Mock VSCode configuration for testing
 * @param {Object} configValues - Configuration values to return
 * @returns {Function} Mock configuration function
 */
function mockVSCodeConfiguration(configValues) {
    return (section) => ({
        get: (key, defaultValue) => {
            const fullKey = section ? `${section}.${key}` : key;
            return configValues.hasOwnProperty(key) ? configValues[key] : defaultValue;
        },
        has: (key) => configValues.hasOwnProperty(key),
        inspect: (key) => ({
            key: key,
            defaultValue: undefined,
            globalValue: configValues[key],
            workspaceValue: undefined,
            workspaceFolderValue: undefined
        }),
        update: (key, value, target) => Promise.resolve()
    });
}

/**
 * Creates a mock VSCode workspace
 * @param {string} workspacePath - Path to the workspace
 * @returns {Array} Mock workspace folders array
 */
function createMockWorkspace(workspacePath) {
    return [{
        uri: {
            fsPath: workspacePath,
            scheme: 'file'
        },
        name: path.basename(workspacePath),
        index: 0
    }];
}

/**
 * Waits for a specified amount of time
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise} Promise that resolves after the specified time
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Captures console output during test execution
 * @param {Function} testFunction - Function to execute while capturing output
 * @returns {Promise<any>} Object with captured stdout and stderr, and test result
 */
async function captureConsoleOutput(testFunction) {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    
    const stdout = [];
    const stderr = [];
    
    console.log = (...args) => stdout.push(args.join(' '));
    console.warn = (...args) => stderr.push(args.join(' '));
    console.error = (...args) => stderr.push(args.join(' '));
    
    try {
        const result = await testFunction();
        return { stdout, stderr, result };
    } finally {
        console.log = originalLog;
        console.warn = originalWarn;
        console.error = originalError;
    }
}

module.exports = {
    createTestWorkspace,
    cleanupTestWorkspace,
    mockVSCodeConfiguration,
    createMockWorkspace,
    sleep,
    captureConsoleOutput
};
