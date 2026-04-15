const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

// Global helper functions shared across test files
function createMockConfig(overrides = {}) {
    const defaults = {
        directoriesToScan: ['src/Server', 'src/Client', 'src/Shared', 'Packages'],
        ignoreDirectories: ['^_.*'],
        supportedExtensions: ['.lua', '.luau'],
        enableAbsolutePathUpdates: true,
        enableFileNameCollisionResolution: false,
        enableBasenameUpdates: true,
        requirePrefix: '@',
        importModulePaths: ['ReplicatedStorage.src._Import'],
        tryToAddImportRequire: true,
        importOpacity: 0.45,
        preferImportPlacement: 'BeforeFirstRequire',
        addSeleneCommentToImport: false, // Add the missing configuration property
        manualAliases: {
            '@Server': 'src/Server',
            '@Client': 'src/Client', 
            '@Shared': 'src/Shared'
        }
    };
    
    const config = { ...defaults, ...overrides };
    
    return {
        get: (key, defaultValue) => {
            return config.hasOwnProperty(key) ? config[key] : defaultValue;
        },
        has: (key) => config.hasOwnProperty(key),
        inspect: () => undefined,
        update: () => Promise.resolve()
    };
}

function mockWorkspaceConfig(testWorkspaceUri, configOverrides = {}) {
    const originalConfig = vscode.workspace.getConfiguration;
    const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
    
    vscode.workspace.getConfiguration = (section) => {
        // If a specific section is requested, filter overrides for that section
        let sectionOverrides = {};
        if (section) {
            for (const [key, value] of Object.entries(configOverrides)) {
                if (key.startsWith(`${section}.`)) {
                    const configKey = key.substring(section.length + 1);
                    sectionOverrides[configKey] = value;
                } else if (!key.includes('.')) {
                    // Direct property without section prefix
                    sectionOverrides[key] = value;
                }
            }
        } else {
            // No section specified, use all overrides
            sectionOverrides = configOverrides;
        }
        
        return createMockConfig(sectionOverrides);
    };
    
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
        value: [{ uri: testWorkspaceUri }],
        writable: true,
        configurable: true
    });
    
    return () => {
        vscode.workspace.getConfiguration = originalConfig;
        Object.defineProperty(vscode.workspace, 'workspaceFolders', {
            value: originalWorkspaceFolders,
            writable: true,
            configurable: true
        });
    };
}

function createMockEditor(languageId = 'luau', content = '') {
    return {
        document: {
            languageId,
            getText: () => content
        },
        setDecorations: () => {}
    };
}

function mockVSCodeMessages(handlers = {}) {
    const originals = {
        showInformationMessage: vscode.window.showInformationMessage,
        showWarningMessage: vscode.window.showWarningMessage,
        showErrorMessage: vscode.window.showErrorMessage
    };
    
    const captured = {
        info: [],
        warning: [],
        error: []
    };
    
    vscode.window.showInformationMessage = (message, ...options) => {
        captured.info.push(message);
        return handlers.info ? handlers.info(message, ...options) : Promise.resolve();
    };
    
    vscode.window.showWarningMessage = (message, ...options) => {
        captured.warning.push(message);
        return handlers.warning ? handlers.warning(message, ...options) : Promise.resolve('No');
    };
    
    vscode.window.showErrorMessage = (message, ...options) => {
        captured.error.push(message);
        return handlers.error ? handlers.error(message, ...options) : Promise.resolve();
    };
    
    return {
        captured,
        restore: () => {
            vscode.window.showInformationMessage = originals.showInformationMessage;
            vscode.window.showWarningMessage = originals.showWarningMessage;
            vscode.window.showErrorMessage = originals.showErrorMessage;
        }
    };
}

function createTestFiles(testWorkspacePath, files) {
    for (const [filePath, content] of Object.entries(files)) {
        const fullPath = path.join(testWorkspacePath, filePath);
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(fullPath, content, 'utf8');
    }
}

function cleanupTestFiles(testWorkspacePath, filePaths) {
    for (const filePath of filePaths) {
        const fullPath = path.join(testWorkspacePath, filePath);
        if (fs.existsSync(fullPath)) {
            if (fs.statSync(fullPath).isDirectory()) {
                fs.rmSync(fullPath, { recursive: true, force: true });
            } else {
                fs.unlinkSync(fullPath);
            }
        }
    }
}

async function setupTestWorkspace(testWorkspacePath) {
    const dirs = [
        'src/Server', 'src/Client', 'src/Shared',
        'src/Server/Systems', 'src/Shared/Utils',
        'Packages', '_Private'
    ];

    // Create directories
    for (const dir of dirs) {
        const fullPath = path.join(testWorkspacePath, dir);
        if (!fs.existsSync(fullPath)) {
            fs.mkdirSync(fullPath, { recursive: true });
        }
    }

    // Create test files
    createTestFiles(testWorkspacePath, {
        'src/Server/ServerMain.luau': 'print("Server main")',
        'src/Server/Systems/PlayerManager.luau': 'local PlayerManager = {}\nreturn PlayerManager',
        'src/Client/ClientMain.luau': 'print("Client main")',
        'src/Shared/Config.luau': 'local Config = {}\nreturn Config',
        'src/Shared/Utils/StringUtils.luau': 'local StringUtils = {}\nreturn StringUtils',
        'src/Shared/Utils/init.luau': 'return { StringUtils = require("StringUtils") }',
        'Packages/TestPackage.luau': 'return {}',
        '_Private/PrivateFile.luau': 'return {}'
    });

    // Create configuration files
    const luaurcConfig = { aliases: {}, languageMode: "strict" };
    fs.writeFileSync(path.join(testWorkspacePath, '.luaurc'), JSON.stringify(luaurcConfig, null, 4));
}

module.exports = {
    createMockConfig,
    mockWorkspaceConfig,
    createMockEditor,
    mockVSCodeMessages,
    createTestFiles,
    cleanupTestFiles,
    setupTestWorkspace
};