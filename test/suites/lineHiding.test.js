const assert = require('assert');
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

// Import extension modules for testing
const { hideLines } = require('../../src/features/hideLines');

// Import shared test utilities
const {
    createMockConfig,
    createMockEditor,
    mockVSCodeMessages,
    setupTestWorkspace
} = require('../utils/testUtils');

suite('Line Hiding Tests', () => {
    vscode.window.showInformationMessage('Starting Line Hiding tests...');

    let testWorkspaceUri;
    let testWorkspacePath;

    suiteSetup(async () => {
        testWorkspaceUri = vscode.Uri.file(path.join(__dirname, 'line-test-workspace'));
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

    test('Should prompt to add missing import require definition', async () => {
        const testContent = 'local MyModule = require("@MyModule")\nreturn MyModule';
        
        const messages = mockVSCodeMessages({
            warning: (message) => {
                return message.includes('missing the import require definition') ? 
                    Promise.resolve('No') : Promise.resolve('No');
            }
        });

        try {
            const mockEditor = createMockEditor('luau', testContent);
            hideLines(mockEditor);
            
            assert.ok(messages.captured.warning.some(msg => 
                msg.includes('missing the import require definition')
            ), 'Should prompt to add missing import require definition');
        } finally {
            messages.restore();
        }
    });

    test('Should not prompt for empty files', async () => {
        const messages = mockVSCodeMessages();

        try {
            const mockEditor = createMockEditor('luau', '');
            hideLines(mockEditor);
            
            assert.strictEqual(messages.captured.warning.length, 0, 'Should not prompt for empty files');
        } finally {
            messages.restore();
        }
    });

    test('Should support multiple import module paths', async () => {
        const testContent = 'require = require(game:GetService("ReplicatedStorage").src._Import)(script) :: typeof(require)\nlocal MyModule = require("@MyModule")';

        try {
            const mockEditor = createMockEditor('luau', testContent);
            
            assert.doesNotThrow(() => hideLines(mockEditor), 'Should handle multiple import module paths');
        } catch (error) {
            assert.fail(`Should not throw error: ${error.message}`);
        }
    });

    test('Should not prompt when file already has import require definition', async () => {
        const testContent = `
require = require(ReplicatedStorage:FindFirstChild("_Import", true))(script) :: typeof(require)
local MyModule = require("@MyModule")
return MyModule
        `.trim();

        const originalShowWarningMessage = vscode.window.showWarningMessage;
        let promptShown = false;
        vscode.window.showWarningMessage = () => {
            promptShown = true;
            return Promise.resolve('No');
        };

        const originalConfig = vscode.workspace.getConfiguration;
        vscode.workspace.getConfiguration = () => ({
            get: (key) => {
                switch (key) {
                    case 'importModulePaths':
                        return ['ReplicatedStorage:FindFirstChild("_Import", true)'];
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
            const mockEditor = {
                document: {
                    languageId: 'luau',
                    getText: () => testContent
                },
                setDecorations: () => {}
            };
            
            hideLines(mockEditor);
            
            assert.ok(!promptShown, 'Should not prompt when import require definition already exists');
        } finally {
            vscode.window.showWarningMessage = originalShowWarningMessage;
            vscode.workspace.getConfiguration = originalConfig;
        }
    });

    test('Should not process non-Luau files', async () => {
        const originalConfig = vscode.workspace.getConfiguration;
        let configRequested = false;
        vscode.workspace.getConfiguration = () => {
            configRequested = true;
            return {
                get: () => undefined,
                has: () => true,
                inspect: () => undefined,
                update: () => Promise.resolve()
            };
        };

        try {
            const mockEditor = {
                document: {
                    languageId: 'javascript',
                    getText: () => 'console.log("test");'
                },
                setDecorations: () => {}
            };
            
            hideLines(mockEditor);
            
            assert.ok(!configRequested, 'Should not process non-Luau files');
        } finally {
            vscode.workspace.getConfiguration = originalConfig;
        }
    });

    test('Should handle different file extensions correctly', async () => {
        const testContent = 'local MyModule = require("@MyModule")\nreturn MyModule';
        
        const luaEditor = createMockEditor('lua', testContent);
        const luauEditor = createMockEditor('luau', testContent);
        const jsEditor = createMockEditor('javascript', testContent);

        const messages = mockVSCodeMessages();

        try {
            hideLines(luaEditor);
            hideLines(luauEditor);
            hideLines(jsEditor);
            
            assert.ok(messages.captured.warning.length >= 2, 'Should prompt for both .lua and .luau files');
        } finally {
            messages.restore();
        }
    });

    test('Should handle tryToAddImportRequire disabled', async () => {
        const testContent = 'local MyModule = require("@MyModule")\nreturn MyModule';
        
        const messages = mockVSCodeMessages();
        
        const originalConfig = vscode.workspace.getConfiguration;
        vscode.workspace.getConfiguration = () => createMockConfig({
            tryToAddImportRequire: false
        });

        try {
            const mockEditor = createMockEditor('luau', testContent);
            hideLines(mockEditor);
            
            assert.strictEqual(messages.captured.warning.length, 0, 'Should not prompt when tryToAddImportRequire is disabled');
        } finally {
            messages.restore();
            vscode.workspace.getConfiguration = originalConfig;
        }
    });
});
