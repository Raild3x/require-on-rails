const assert = require('assert');
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

// Import extension modules for testing
const { generateFileAliases } = require('../../src/features/updateLuaFileAliases');
const { hideLines } = require('../../src/features/hideLines');

// Import shared test utilities
const {
    createMockEditor,
    mockWorkspaceConfig,
    mockVSCodeMessages,
    setupTestWorkspace
} = require('../utils/testUtils');

suite('Configuration Tests', () => {
    vscode.window.showInformationMessage('Starting Configuration tests...');

    let testWorkspaceUri;
    let testWorkspacePath;

    suiteSetup(async () => {
        testWorkspaceUri = vscode.Uri.file(path.join(__dirname, 'config-test-workspace'));
        testWorkspacePath = testWorkspaceUri.fsPath;
        
        if (!fs.existsSync(testWorkspacePath)) {
            fs.mkdirSync(testWorkspacePath, { recursive: true });
        }
        
        await setupTestWorkspace(testWorkspacePath);
    });

    suiteTeardown(async () => {
        if (fs.existsSync(testWorkspacePath)) {
            fs.rmSync(testWorkspacePath, { recursive: true, force: true });
        }
    });

    test('Should handle malformed importModulePaths', () => {
        const testContent = 'local MyModule = require("@MyModule")\nreturn MyModule';
        
        const originalConfig = vscode.workspace.getConfiguration;
        vscode.workspace.getConfiguration = () => ({
            get: (key) => {
                switch (key) {
                    case 'importModulePaths':
                        return null; // Malformed config
                    case 'tryToAddImportRequire':
                        return true;
                    case 'importOpacity':
                        return 0.45;
                    default:
                        return undefined;
                }
            },
            has: () => true,
            inspect: () => undefined,
            update: () => Promise.resolve()
        });

        try {
            const mockEditor = createMockEditor('luau', testContent);
            
            assert.doesNotThrow(() => hideLines(mockEditor), 'Should handle malformed importModulePaths gracefully');
        } finally {
            vscode.workspace.getConfiguration = originalConfig;
        }
    });

    test('Should handle empty directoriesToScan configuration', () => {
        const restore = mockWorkspaceConfig(testWorkspaceUri, {
            directoriesToScan: []
        });

        try {
            assert.doesNotThrow(() => {
                generateFileAliases();
            }, 'Should handle empty directoriesToScan gracefully');
        } finally {
            restore();
        }
    });

    test('Should handle non-existent directories in directoriesToScan', () => {
        const restore = mockWorkspaceConfig(testWorkspaceUri, {
            directoriesToScan: ['nonexistent', 'also-fake', 'src/Server']
        });

        try {
            generateFileAliases();
            
            const luaurcPath = path.join(testWorkspacePath, '.luaurc');
            const luaurcContent = JSON.parse(fs.readFileSync(luaurcPath, 'utf8'));
            
            assert.ok(luaurcContent.aliases.ServerMain, 'Should process existing directories even when some are non-existent');
        } finally {
            restore();
        }
    });

    test('Should handle missing configuration gracefully', () => {
        const originalConfig = vscode.workspace.getConfiguration;
        vscode.workspace.getConfiguration = () => ({
            get: (key) => {
                switch (key) {
                    case 'directoriesToScan':
                        return [];
                    case 'ignoreDirectories':
                        return [];
                    case 'supportedExtensions':
                        return ['.lua', '.luau'];
                    default:
                        return undefined;
                }
            },
            has: () => false,
            inspect: () => undefined,
            update: () => Promise.resolve()
        });

        const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
        Object.defineProperty(vscode.workspace, 'workspaceFolders', {
            value: [{ uri: testWorkspaceUri }],
            writable: true,
            configurable: true
        });

        try {
            assert.doesNotThrow(() => {
                generateFileAliases();
            }, 'Should handle missing configuration gracefully');
        } finally {
            vscode.workspace.getConfiguration = originalConfig;
            Object.defineProperty(vscode.workspace, 'workspaceFolders', {
                value: originalWorkspaceFolders,
                writable: true,
                configurable: true
            });
        }
    });

    test('Should handle invalid JSON in config files', () => {
        const luaurcPath = path.join(testWorkspacePath, '.luaurc');
        
        let originalLuaurc = '';
        if (fs.existsSync(luaurcPath)) {
            originalLuaurc = fs.readFileSync(luaurcPath, 'utf8');
        }
        
        fs.writeFileSync(luaurcPath, '{ invalid json }');

        const originalConfig = vscode.workspace.getConfiguration;
        vscode.workspace.getConfiguration = () => ({
            get: (key) => {
                switch (key) {
                    case 'directoriesToScan':
                        return ['src/Server'];
                    case 'ignoreDirectories':
                        return [];
                    case 'supportedExtensions':
                        return ['.luau'];
                    case 'manualAliases':
                        return { 'Server': 'src/Server' };
                    default:
                        return undefined;
                }
            },
            has: () => true,
            inspect: () => undefined,
            update: () => Promise.resolve()
        });

        const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
        Object.defineProperty(vscode.workspace, 'workspaceFolders', {
            value: [{ uri: testWorkspaceUri }],
            writable: true,
            configurable: true
        });

        const messages = mockVSCodeMessages();

        try {
            generateFileAliases();
            
            assert.ok(messages.captured.error.length > 0, 'Should show error message for invalid JSON');
        } finally {
            vscode.workspace.getConfiguration = originalConfig;
            messages.restore();
            Object.defineProperty(vscode.workspace, 'workspaceFolders', {
                value: originalWorkspaceFolders,
                writable: true,
                configurable: true
            });
            
            if (originalLuaurc) {
                fs.writeFileSync(luaurcPath, originalLuaurc);
            }
        }
    });

    test('Should handle manualAliases configuration', () => {
        const restore = mockWorkspaceConfig(testWorkspaceUri, {
            directoriesToScan: ['src/Server'],
            manualAliases: {
                '@CustomServer': 'src/Server',
                '@AnotherAlias': 'some/other/path'
            }
        });

        try {
            generateFileAliases();
            
            const luaurcPath = path.join(testWorkspacePath, '.luaurc');
            const luaurcContent = JSON.parse(fs.readFileSync(luaurcPath, 'utf8'));
            
            assert.ok(luaurcContent.aliases['@CustomServer'], 'Should include custom manual aliases');
            assert.ok(luaurcContent.aliases['@AnotherAlias'], 'Should include multiple manual aliases');
            assert.strictEqual(luaurcContent.aliases['@CustomServer'], 'src/Server', 'Manual alias should have correct path');
        } finally {
            restore();
        }
    });
});
