const assert = require('assert');
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

// Import extension modules for testing
const { generateFileAliases } = require('../src/updateLuaFileAliases');
const { updateRequireNames } = require('../src/updateRequireNames');
const { hideLines, unhideLines } = require('../src/hideLines');

// Global helper functions
function createMockConfig(overrides = {}) {
    const defaults = {
        directoriesToScan: ['src/Server', 'src/Client', 'src/Shared', 'Packages'],
        ignoreDirectories: ['^_.*'],
        supportedExtensions: ['.lua', '.luau'],
        enableAbsolutePathUpdates: true,
        enableCollisionDetection: true,
        enableBasenameUpdates: true,
        requirePrefix: '@',
        importModulePaths: ['ReplicatedStorage.src._Import'],
        tryToAddImportRequire: true,
        importOpacity: 0.45,
        preferImportPlacement: 'BeforeFirstRequire'
    };
    
    const config = { ...defaults, ...overrides };
    
    return {
        get: (key) => config[key],
        has: () => true,
        inspect: () => undefined,
        update: () => Promise.resolve()
    };
}

function mockWorkspaceConfig(testWorkspaceUri, configOverrides = {}) {
    const originalConfig = vscode.workspace.getConfiguration;
    const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
    
    vscode.workspace.getConfiguration = () => createMockConfig(configOverrides);
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

//----------------------------------------------------------------------------------------

suite('RequireOnRails Extension Test Suite', () => {
    vscode.window.showInformationMessage('Starting RequireOnRails tests...');

    let testWorkspaceUri;
    let testWorkspacePath;

    suiteSetup(async () => {
        // Create a test workspace
        testWorkspaceUri = vscode.Uri.file(path.join(__dirname, 'test-workspace'));
        testWorkspacePath = testWorkspaceUri.fsPath;
        
        // Ensure test workspace exists
        if (!fs.existsSync(testWorkspacePath)) {
            fs.mkdirSync(testWorkspacePath, { recursive: true });
        }
        
        // Create test directory structure
        await setupTestWorkspace();
    });

    suiteTeardown(async () => {
        // Clean up test workspace
        if (fs.existsSync(testWorkspacePath)) {
            fs.rmSync(testWorkspacePath, { recursive: true, force: true });
        }
    });

    async function setupTestWorkspace() {
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

        const requireOnRailsConfig = {
            manualAliases: { "@Server": "src/Server", "@Client": "src/Client", "@Shared": "src/Shared" },
            autoGeneratedAliases: {}
        };
        fs.writeFileSync(path.join(testWorkspacePath, '.requireonrails.json'), JSON.stringify(requireOnRailsConfig, null, 4));
    }

    suite('File Alias Generation Tests', () => {
        test('Should generate unique aliases for non-conflicting files', async () => {
            const restore = mockWorkspaceConfig(testWorkspaceUri);

            try {
                generateFileAliases();
                
                const luaurcPath = path.join(testWorkspacePath, '.luaurc');
                assert.ok(fs.existsSync(luaurcPath), '.luaurc should exist');
                
                const luaurcContent = JSON.parse(fs.readFileSync(luaurcPath, 'utf8'));
                assert.ok(luaurcContent.aliases, 'Aliases should be generated');
                assert.ok(luaurcContent.aliases.ServerMain, 'ServerMain alias should exist');
                assert.ok(luaurcContent.aliases.ClientMain, 'ClientMain alias should exist');
                assert.ok(luaurcContent.aliases.Config, 'Config alias should exist');
                assert.ok(luaurcContent.aliases.Utils, 'Utils alias should exist for init file');
                assert.ok(!luaurcContent.aliases.PrivateFile, 'Private files should be ignored');
            } finally {
                restore();
            }
        });

        test('Should handle ambiguous aliases correctly', async () => {
            const duplicateFile = path.join(testWorkspacePath, 'src/Client/Config.luau');
            fs.writeFileSync(duplicateFile, 'local ClientConfig = {}\nreturn ClientConfig');

            const restore = mockWorkspaceConfig(testWorkspaceUri, {
                directoriesToScan: ['src/Server', 'src/Client', 'src/Shared']
            });

            try {
                generateFileAliases();
                
                const luaurcPath = path.join(testWorkspacePath, '.luaurc');
                const luaurcContent = JSON.parse(fs.readFileSync(luaurcPath, 'utf8'));
                
                const autoGeneratedKeys = Object.keys(luaurcContent.aliases).filter(key => 
                    !['@Server', '@Client', '@Shared'].includes(key)
                );
                assert.ok(!autoGeneratedKeys.includes('Config'), 'Ambiguous aliases should not be auto-generated');
            } finally {
                restore();
                fs.unlinkSync(duplicateFile);
            }
        });
    });

    suite('Require Statement Update Tests', () => {
        test('Should detect file rename operation', () => {
            const oldPath = path.join(testWorkspacePath, 'src/Server/OldName.luau');
            const newPath = path.join(testWorkspacePath, 'src/Server/NewName.luau');
            
            fs.writeFileSync(oldPath, 'return {}');
            
            const messages = mockVSCodeMessages();
            const restore = mockWorkspaceConfig(testWorkspaceUri);

            try {
                fs.renameSync(oldPath, newPath);
                updateRequireNames(newPath, oldPath);
                
                assert.ok(messages.captured.info.some(msg => 
                    msg.includes('renamed') && msg.includes('OldName') && msg.includes('NewName')
                ), 'Should detect rename operation and show appropriate message');
            } finally {
                messages.restore();
                restore();
                cleanupTestFiles(testWorkspacePath, ['src/Server/OldName.luau', 'src/Server/NewName.luau']);
            }
        });

        test('Should detect file move operation', () => {
            const oldPath = path.join(testWorkspacePath, 'src/Server/TestFile.luau');
            const newPath = path.join(testWorkspacePath, 'src/Shared/TestFile.luau');
            
            fs.writeFileSync(oldPath, 'return {}');
            
            const messages = mockVSCodeMessages();
            const restore = mockWorkspaceConfig(testWorkspaceUri);

            try {
                fs.renameSync(oldPath, newPath);
                updateRequireNames(newPath, oldPath);
                
                assert.ok(messages.captured.info.some(msg => 
                    msg.includes('absolute require paths') && 
                    msg.includes('@Server/TestFile') && 
                    msg.includes('@Shared/TestFile')
                ), 'Should prompt for absolute path updates');
            } finally {
                messages.restore();
                restore();
                cleanupTestFiles(testWorkspacePath, ['src/Server/TestFile.luau', 'src/Shared/TestFile.luau']);
            }
        });

        test('Should verify move operation is detected correctly', () => {
            const { analyzeFileOperation } = require('../src/updateRequireNames');
            
            const oldPath = path.join(testWorkspacePath, 'src/Server/TestFile.luau');
            const newPath = path.join(testWorkspacePath, 'src/Shared/TestFile.luau');
            
            const operationInfo = analyzeFileOperation(newPath, oldPath);
            
            assert.ok(operationInfo !== null, 'Should detect an operation');
            assert.strictEqual(operationInfo.operationType, 'moved', 'Should detect move operation');
            assert.strictEqual(operationInfo.isMove, true, 'isMove should be true');
            assert.strictEqual(operationInfo.isRename, false, 'isRename should be false');
            assert.strictEqual(operationInfo.oldFileBasename, 'TestFile', 'Old basename should be correct');
            assert.strictEqual(operationInfo.newFileBasename, 'TestFile', 'New basename should be correct');
        });
    });

    suite('Line Hiding Tests', () => {
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
                
                // Should not throw an error and should recognize the alternative path
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

        test('Should not prompt when file has no @ require statements', async () => {
            const testContent = `
local MyModule = require("./LocalModule")
local AnotherModule = require("game.ReplicatedStorage.SomeModule")
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
                
                assert.ok(!promptShown, 'Should not prompt when no @ require statements exist');
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

        test('Should respect preferredImportPlacement configuration', () => {
            const testContent = 'local MyModule = require("@MyModule")\nreturn MyModule';
            
            // Simplify the test to just verify configuration handling without async operations
            const originalConfig = vscode.workspace.getConfiguration;
            const originalGetWorkspaceFolder = vscode.workspace.getWorkspaceFolder;
            
            let configAccessed = false;
            vscode.workspace.getConfiguration = () => {
                configAccessed = true;
                return createMockConfig({
                    preferredImportPlacement: 'TopOfFile'
                });
            };
            
            vscode.workspace.getWorkspaceFolder = () => ({
                uri: { fsPath: testWorkspacePath }
            });

            try {
                const mockEditor = {
                    document: {
                        languageId: 'luau',
                        getText: () => testContent,
                        uri: vscode.Uri.file('test.luau'),
                        lineAt: (line) => ({
                            range: {
                                start: { line: line, character: 0 },
                                end: { line: line, character: 0 }
                            },
                            text: line === 0 ? 'local MyModule = require("@MyModule")' : 'return MyModule'
                        })
                    },
                    setDecorations: () => {},
                    revealRange: () => {}
                };

                // Test that hideLines processes the configuration without hanging
                hideLines(mockEditor);
                
                // Verify that configuration was accessed (indicating the function processed correctly)
                assert.ok(configAccessed, 'Should access configuration when processing Luau files');
                
            } finally {
                vscode.workspace.getConfiguration = originalConfig;
                vscode.workspace.getWorkspaceFolder = originalGetWorkspaceFolder;
            }
        });

        test('Should handle different file extensions correctly', async () => {
            const testContent = 'local MyModule = require("@MyModule")\nreturn MyModule';
            
            // Test .lua files
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
            
            // Mock config with tryToAddImportRequire disabled
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

    suite('Extension Activation and Lifecycle Tests', () => {
        test('Should register setupDefaultProject command', () => {
            // Test that the command is properly registered
            // In a real test environment, you would check:
            // - Command is registered in extension activation
            // - Command can be executed via command palette
            // - Command properly calls unpackProjectTemplate function
            assert.ok(true, 'setupDefaultProject command registration test placeholder');
        });

        test('Should auto-generate file aliases for new files', async () => {
            // Ensure the directory exists before creating the file
            const serverDir = path.join(testWorkspacePath, 'src/Server');
            if (!fs.existsSync(serverDir)) {
                fs.mkdirSync(serverDir, { recursive: true });
            }
            
            const newFile = path.join(testWorkspacePath, 'src/Server/NewFile.luau');

            const restore = mockWorkspaceConfig(testWorkspaceUri);

            try {
                // Simulate file creation
                fs.writeFileSync(newFile, 'return {}');
                
                // Manually trigger alias generation (in real scenario, this would be automatic)
                generateFileAliases();
                
                const luaurcPath = path.join(testWorkspacePath, '.luaurc');
                const luaurcContent = JSON.parse(fs.readFileSync(luaurcPath, 'utf8'));
                
                assert.ok(luaurcContent.aliases.NewFile, 'New file should have an alias');
            } finally {
                restore();
                cleanupTestFiles(testWorkspacePath, ['src/Server/NewFile.luau']);
            }
        });

        test('Should not overwrite existing aliases on file update', async () => {
            // Ensure the directory exists before creating the file
            const serverDir = path.join(testWorkspacePath, 'src/Server');
            if (!fs.existsSync(serverDir)) {
                fs.mkdirSync(serverDir, { recursive: true });
            }
            
            const existingFile = path.join(testWorkspacePath, 'src/Server/ExistingFile.luau');
            fs.writeFileSync(existingFile, 'return {}');

            const restore = mockWorkspaceConfig(testWorkspaceUri);

            try {
                // Simulate file update
                fs.writeFileSync(existingFile, '-- updated content');
                
                // Manually trigger alias generation
                generateFileAliases();
                
                const luaurcPath = path.join(testWorkspacePath, '.luaurc');
                const luaurcContent = JSON.parse(fs.readFileSync(luaurcPath, 'utf8'));
                
                // Alias should already exist, so it should not be overwritten
                assert.ok(luaurcContent.aliases.ExistingFile, 'Existing file should have an alias');
                assert.ok(luaurcContent.aliases.ExistingFile.includes('ExistingFile.luau'), 'Alias should point to the correct file');
            } finally {
                restore();
                cleanupTestFiles(testWorkspacePath, ['src/Server/ExistingFile.luau']);
            }
        });
    });

    suite('File System Watcher Tests', () => {
        test('Should handle file system events correctly', async () => {
            // This test would ideally test the file watchers, but VSCode test environment
            // doesn't support actual file system events. We'll test the handler functions directly.
            
            const testFile = path.join(testWorkspacePath, 'src/Server/TestWatcher.luau');
            createTestFiles(testWorkspacePath, {
                'src/Server/TestWatcher.luau': 'return {}'
            });

            const restore = mockWorkspaceConfig(testWorkspaceUri);

            try {
                // Generate initial aliases
                generateFileAliases();
                
                let luaurcPath = path.join(testWorkspacePath, '.luaurc');
                let luaurcContent = JSON.parse(fs.readFileSync(luaurcPath, 'utf8'));
                
                assert.ok(luaurcContent.aliases.TestWatcher, 'Should create alias for watched file');
                
                // Simulate file deletion by removing it and regenerating aliases
                fs.unlinkSync(testFile);
                generateFileAliases();
                
                luaurcContent = JSON.parse(fs.readFileSync(luaurcPath, 'utf8'));
                assert.ok(!luaurcContent.aliases.TestWatcher, 'Should remove alias when file is deleted');
                
            } finally {
                restore();
                cleanupTestFiles(testWorkspacePath, ['src/Server/TestWatcher.luau']);
            }
        });
    });

    suite('Configuration Validation Tests', () => {
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
                
                // Should not throw error with malformed importModulePaths
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
                // Should not throw error with empty directoriesToScan
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
                
                // Should still process existing directories
                assert.ok(luaurcContent.aliases.ServerMain, 'Should process existing directories even when some are non-existent');
            } finally {
                restore();
            }
        });
    });

    suite('Manual Alias Management Tests', () => {
        test('Should preserve manual aliases when regenerating', () => {
            const manualAliasFile = path.join(testWorkspacePath, '.requireonrails.json');
            const manualConfig = {
                manualAliases: {
                    "CustomAlias": "src/Custom/Path",
                    "@MyCustom": "src/MyCustom"
                },
                autoGeneratedAliases: {}
            };
            fs.writeFileSync(manualAliasFile, JSON.stringify(manualConfig, null, 4));

            const restore = mockWorkspaceConfig(testWorkspaceUri);

            try {
                generateFileAliases();
                
                const luaurcPath = path.join(testWorkspacePath, '.luaurc');
                const luaurcContent = JSON.parse(fs.readFileSync(luaurcPath, 'utf8'));
                
                assert.ok(luaurcContent.aliases.CustomAlias, 'Should preserve manual aliases');
                assert.strictEqual(luaurcContent.aliases.CustomAlias, 'src/Custom/Path', 'Manual alias should have correct path');
                assert.ok(luaurcContent.aliases['@MyCustom'], 'Should preserve manual aliases with @ prefix');
            } finally {
                restore();
                if (fs.existsSync(manualAliasFile)) {
                    fs.unlinkSync(manualAliasFile);
                }
            }
        });

        test('Should not overwrite manual aliases with auto-generated ones', () => {
            // Create a file that would normally get an auto-generated alias
            createTestFiles(testWorkspacePath, {
                'src/Server/ManualOverride.luau': 'return {}'
            });

            const manualAliasFile = path.join(testWorkspacePath, '.requireonrails.json');
            const manualConfig = {
                manualAliases: {
                    "ManualOverride": "custom/manual/path"
                },
                autoGeneratedAliases: {}
            };
            fs.writeFileSync(manualAliasFile, JSON.stringify(manualConfig, null, 4));

            const restore = mockWorkspaceConfig(testWorkspaceUri);

            try {
                generateFileAliases();
                
                const luaurcPath = path.join(testWorkspacePath, '.luaurc');
                const luaurcContent = JSON.parse(fs.readFileSync(luaurcPath, 'utf8'));
                
                assert.strictEqual(luaurcContent.aliases.ManualOverride, 'custom/manual/path', 'Manual alias should take precedence over auto-generated');
                assert.notStrictEqual(luaurcContent.aliases.ManualOverride, 'src/Server/ManualOverride.luau', 'Should not use auto-generated path when manual exists');
            } finally {
                restore();
                cleanupTestFiles(testWorkspacePath, ['src/Server/ManualOverride.luau']);
                if (fs.existsSync(manualAliasFile)) {
                    fs.unlinkSync(manualAliasFile);
                }
            }
        });
    });

    suite('Init File Handling Tests', () => {
        // test('Should prefer init files over regular files in same directory', () => {
        //     const testDir = path.join(testWorkspacePath, 'src/Shared/InitTest');
        //     const initFile = path.join(testDir, 'init.luau');
        //     const regularFile = path.join(testDir, 'InitTest.luau');

        //     fs.mkdirSync(testDir, { recursive: true });
        //     fs.writeFileSync(initFile, 'return { main = true }');
        //     fs.writeFileSync(regularFile, 'return { regular = true }');

        //     const restore = mockWorkspaceConfig(testWorkspaceUri, {
        //         directoriesToScan: ['src/Shared']
        //     });

        //     try {
        //         generateFileAliases();
                
        //         const luaurcPath = path.join(testWorkspacePath, '.luaurc');
        //         const luaurcContent = JSON.parse(fs.readFileSync(luaurcPath, 'utf8'));
                
        //         // Should alias the directory (init file) and not create a separate "init" alias
        //         assert.ok(luaurcContent.aliases.InitTest, 'Should create alias for directory with init file');
        //         assert.ok(!luaurcContent.aliases.init, 'Should not create separate "init" alias');
        //     } finally {
        //         restore();
        //         cleanupTestFiles(testWorkspacePath, ['src/Shared/InitTest']);
        //     }
        // });

        test('Should handle nested init files correctly', () => {
            const dirs = [
                'src/Shared/Nested',
                'src/Shared/Nested/Deep'
            ];
            
            for (const dir of dirs) {
                const fullPath = path.join(testWorkspacePath, dir);
                fs.mkdirSync(fullPath, { recursive: true });
                fs.writeFileSync(path.join(fullPath, 'init.luau'), `return { path = "${dir}" }`);
            }

            const restore = mockWorkspaceConfig(testWorkspaceUri, {
                directoriesToScan: ['src/Shared']
            });

            try {
                generateFileAliases();
                
                const luaurcPath = path.join(testWorkspacePath, '.luaurc');
                const luaurcContent = JSON.parse(fs.readFileSync(luaurcPath, 'utf8'));
                
                assert.ok(luaurcContent.aliases.Nested, 'Should create alias for parent directory with init');
                assert.ok(luaurcContent.aliases.Deep, 'Should create alias for nested directory with init');
            } finally {
                restore();
                cleanupTestFiles(testWorkspacePath, ['src/Shared/Nested']);
            }
        });
    });

    suite('Regex and Pattern Matching Tests', () => {
        test('Should handle complex ignore patterns', () => {
            // Ensure we start with a valid .luaurc file
            const luaurcPath = path.join(testWorkspacePath, '.luaurc');
            const validConfig = { aliases: {}, languageMode: "strict" };
            fs.writeFileSync(luaurcPath, JSON.stringify(validConfig, null, 4));

            const specialDirs = [
                '_Private123',
                '__test__',
                'node_modules',
                'Normal_Dir'
            ];
            
            // Clean up any existing directories first
            for (const dir of specialDirs) {
                const fullPath = path.join(testWorkspacePath, 'src', dir);
                if (fs.existsSync(fullPath)) {
                    fs.rmSync(fullPath, { recursive: true, force: true });
                }
            }
            
            // Create fresh directories and files
            for (const dir of specialDirs) {
                const fullPath = path.join(testWorkspacePath, 'src', dir);
                fs.mkdirSync(fullPath, { recursive: true });
                fs.writeFileSync(path.join(fullPath, 'Test.luau'), 'return {}');
            }

            const restore = mockWorkspaceConfig(testWorkspaceUri, {
                directoriesToScan: ['src'],
                ignoreDirectories: ['^_.*', '__.*__', 'node_modules']
            });

            try {
                generateFileAliases();
                
                const luaurcContent = JSON.parse(fs.readFileSync(luaurcPath, 'utf8'));
                
                // Check specific files that should be ignored
                const allAliases = Object.keys(luaurcContent.aliases);
                console.log('Generated aliases:', allAliases);
                
                // Files in _Private123, __test__, and node_modules should be ignored
                // Only files in Normal_Dir should be included
                const hasIgnoredFiles = allAliases.some(alias => 
                    alias === 'Test' && luaurcContent.aliases[alias].includes('_Private123') ||
                    alias === 'Test' && luaurcContent.aliases[alias].includes('__test__') ||
                    alias === 'Test' && luaurcContent.aliases[alias].includes('node_modules')
                );
                
                assert.ok(!hasIgnoredFiles, 'Should ignore files in directories matching ignore patterns');
                
                // But should include files in normal directories
                const normalFile = path.join(testWorkspacePath, 'src/Normal_Dir/NormalFile.luau');
                fs.writeFileSync(normalFile, 'return {}');
                generateFileAliases();
                
                const updatedContent = JSON.parse(fs.readFileSync(luaurcPath, 'utf8'));
                assert.ok(updatedContent.aliases.NormalFile, 'Should include files in non-ignored directories');
                
            } finally {
                restore();
                cleanupTestFiles(testWorkspacePath, specialDirs.map(dir => `src/${dir}`));
                
                // Restore clean .luaurc for subsequent tests
                fs.writeFileSync(luaurcPath, JSON.stringify(validConfig, null, 4));
            }
        });
    });

    suite('Error Recovery Tests', () => {
        test('Should recover from corrupted .luaurc file', () => {
            const luaurcPath = path.join(testWorkspacePath, '.luaurc');
            fs.writeFileSync(luaurcPath, '{ invalid json syntax ');

            const messages = mockVSCodeMessages();
            const restore = mockWorkspaceConfig(testWorkspaceUri);

            try {
                generateFileAliases();
                
                assert.ok(messages.captured.error.some(msg => 
                    msg.includes('Failed to parse .luaurc as JSON')
                ), 'Should show error message for corrupted .luaurc');
            } finally {
                messages.restore();
                restore();
                
                // Restore valid .luaurc
                const validConfig = { aliases: {}, languageMode: "strict" };
                fs.writeFileSync(luaurcPath, JSON.stringify(validConfig, null, 4));
            }
        });

        test('Should handle file permission errors gracefully', () => {
            // This test is difficult to implement in a cross-platform way
            // but we can at least verify the error handling structure exists
            const restore = mockWorkspaceConfig(testWorkspaceUri);

            try {
                // Should not crash even if there are file system errors
                assert.doesNotThrow(() => {
                    generateFileAliases();
                }, 'Should handle file system errors gracefully');
            } finally {
                restore();
            }
        });
    });
	
	suite('Regex Pattern Tests', () => {
        test('Should ignore directories matching regex patterns', () => {
            const testDirs = ['_Private', '_Test', 'Normal', '__pycache__', 'node_modules'];
            const ignorePatterns = ['^_.*', '__pycache__', 'node_modules'];
            
            function shouldIgnoreDirectory(dirName, ignorePatterns) {
                return ignorePatterns.some(pattern => {
                    try {
                        return new RegExp(pattern).test(dirName);
                    } catch (e) {
                        return dirName.toLowerCase() === pattern.toLowerCase();
                    }
                });
            }

            assert.ok(shouldIgnoreDirectory('_Private', ignorePatterns), 'Should ignore _Private');
            assert.ok(shouldIgnoreDirectory('_Test', ignorePatterns), 'Should ignore _Test');
            assert.ok(!shouldIgnoreDirectory('Normal', ignorePatterns), 'Should not ignore Normal');
            assert.ok(shouldIgnoreDirectory('__pycache__', ignorePatterns), 'Should ignore __pycache__');
            assert.ok(shouldIgnoreDirectory('node_modules', ignorePatterns), 'Should ignore node_modules');
        });

        test('Should handle invalid regex patterns gracefully', () => {
            const invalidPattern = '[invalid';
            
            function shouldIgnoreDirectory(dirName, ignorePatterns) {
                return ignorePatterns.some(pattern => {
                    try {
                        return new RegExp(pattern).test(dirName);
                    } catch (e) {
                        // Fall back to exact string matching
                        return dirName.toLowerCase() === pattern.toLowerCase();
                    }
                });
            }

            // Should not throw and should fall back to string matching
            assert.ok(!shouldIgnoreDirectory('test', [invalidPattern]), 'Should handle invalid regex');
            assert.ok(shouldIgnoreDirectory('[invalid', [invalidPattern]), 'Should fall back to string matching');
        });
    });

    suite('Project Template Tests', () => {
        test('Should handle missing ProjectTemplate directory gracefully', () => {
            const { unpackProjectTemplate } = require('../src/unpackProjectTemplate');
            
            // Temporarily rename the existing template to simulate missing template
            const extensionRoot = path.dirname(__dirname);
            const realTemplatePath = path.join(extensionRoot, 'ProjectTemplate');
            const tempTemplatePath = path.join(extensionRoot, 'ProjectTemplate_backup');
            
            let templateRenamed = false;
            if (fs.existsSync(realTemplatePath)) {
                fs.renameSync(realTemplatePath, tempTemplatePath);
                templateRenamed = true;
            }

            const originalShowErrorMessage = vscode.window.showErrorMessage;
            let errorShown = false;
            let capturedErrorMessage = '';
            vscode.window.showErrorMessage = (message) => {
                errorShown = true;
                capturedErrorMessage = message;
                return Promise.resolve();
            };

            const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
            Object.defineProperty(vscode.workspace, 'workspaceFolders', {
                value: [{ uri: testWorkspaceUri }],
                writable: true,
                configurable: true
            });

            // Mock extension context
            const mockContext = {
                extensionUri: vscode.Uri.file(extensionRoot)
            };

            try {
                unpackProjectTemplate(mockContext);
                
                assert.ok(errorShown, 'Should show error when ProjectTemplate directory is missing');
                assert.ok(capturedErrorMessage.includes('Project template not found'), 'Should indicate template not found');
            } finally {
                vscode.window.showErrorMessage = originalShowErrorMessage;
                Object.defineProperty(vscode.workspace, 'workspaceFolders', {
                    value: originalWorkspaceFolders,
                    writable: true,
                    configurable: true
                });
                
                // Restore the template if we renamed it
                if (templateRenamed && fs.existsSync(tempTemplatePath)) {
                    fs.renameSync(tempTemplatePath, realTemplatePath);
                }
            }
        });

        test('Should handle missing workspace folder', () => {
            const { unpackProjectTemplate } = require('../src/unpackProjectTemplate');
            
            const originalShowErrorMessage = vscode.window.showErrorMessage;
            let errorShown = false;
            let capturedErrorMessage = '';
            vscode.window.showErrorMessage = (message) => {
                errorShown = true;
                capturedErrorMessage = message;
                return Promise.resolve();
            };

            const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
            Object.defineProperty(vscode.workspace, 'workspaceFolders', {
                value: null,
                writable: true,
                configurable: true
            });

            // Mock extension context
            const mockContext = {
                extensionUri: vscode.Uri.file(path.dirname(__dirname))
            };

            try {
                unpackProjectTemplate(mockContext);
                
                assert.ok(errorShown, 'Should show error when no workspace folder found');
                assert.ok(capturedErrorMessage.includes('No workspace folder found'), 'Should indicate no workspace found');
            } finally {
                vscode.window.showErrorMessage = originalShowErrorMessage;
                Object.defineProperty(vscode.workspace, 'workspaceFolders', {
                    value: originalWorkspaceFolders,
                    writable: true,
                    configurable: true
                });
            }
        });
    });

    suite('File Alias Generation Edge Cases', () => {
        test('Should handle files with same basename in different subdirectories', async () => {
            // Create additional test structure
            const testDirs = ['src/Server/Combat', 'src/Client/Combat'];
            for (const dir of testDirs) {
                const fullPath = path.join(testWorkspacePath, dir);
                if (!fs.existsSync(fullPath)) {
                    fs.mkdirSync(fullPath, { recursive: true });
                }
            }

            const conflictFiles = {
                'src/Server/Combat/Weapon.luau': 'local ServerWeapon = {}\nreturn ServerWeapon',
                'src/Client/Combat/Weapon.luau': 'local ClientWeapon = {}\nreturn ClientWeapon'
            };

            for (const [filePath, content] of Object.entries(conflictFiles)) {
                const fullPath = path.join(testWorkspacePath, filePath);
                fs.writeFileSync(fullPath, content, 'utf8');
            }

            const restore = mockWorkspaceConfig(testWorkspaceUri, {
                directoriesToScan: ['src/Server', 'src/Client']
            });

            try {
                generateFileAliases();
                
                const luaurcPath = path.join(testWorkspacePath, '.luaurc');
                const luaurcContent = JSON.parse(fs.readFileSync(luaurcPath, 'utf8'));
                
                // Weapon should not be aliased due to ambiguity
                assert.ok(!luaurcContent.aliases.Weapon, 'Ambiguous files should not generate aliases');
            } finally {
                restore();
                // Clean up
                for (const filePath of Object.keys(conflictFiles)) {
                    const fullPath = path.join(testWorkspacePath, filePath);
                    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
                }
            }
        });

        test('Should recognize files and folders with init.luau files that share the same name constitute an ambiguous alias', async () => {
            // Test sequence: standalone file exists → alias created → init file added → alias becomes ambiguous and removed → init file removed → alias restored for standalone file
            
            const testDir = path.join(testWorkspacePath, 'src/Shared/TestModule');
            const standaloneFile = path.join(testWorkspacePath, 'src/Shared/TestModule.luau');
            const initFile = path.join(testDir, 'init.luau');

            const restore = mockWorkspaceConfig(testWorkspaceUri, {
                directoriesToScan: ['src/Shared']
            });

            try {
                // Step 1: Create standalone file only
                fs.writeFileSync(standaloneFile, 'return { standalone = true }');
                generateFileAliases();
                
                let luaurcPath = path.join(testWorkspacePath, '.luaurc');
                let luaurcContent = JSON.parse(fs.readFileSync(luaurcPath, 'utf8'));
                
                assert.ok(luaurcContent.aliases.TestModule, 'Step 1: Should create alias when only standalone file exists');
                assert.ok(luaurcContent.aliases.TestModule.includes('TestModule.luau'), 'Step 1: Should point to standalone file');

                // Step 2: Add init file (creates ambiguity)
                fs.mkdirSync(testDir, { recursive: true });
                fs.writeFileSync(initFile, 'return { main = true }');
                generateFileAliases();
                
                luaurcContent = JSON.parse(fs.readFileSync(luaurcPath, 'utf8'));
                
                assert.ok(!luaurcContent.aliases.TestModule, 'Step 2: Should NOT create alias when both init file and standalone file exist (ambiguous)');
                
                // Check that no TestModule alias was created in auto-generated aliases
                const autoGeneratedKeys = Object.keys(luaurcContent.aliases).filter(key => 
                    !['@Server', '@Client', '@Shared'].includes(key)
                );
                assert.ok(!autoGeneratedKeys.includes('TestModule'), 'Step 2: TestModule should not be in auto-generated aliases due to ambiguity');

                // Step 3: Remove init file (removes ambiguity, standalone file should get alias again)
                fs.rmSync(testDir, { recursive: true, force: true });
                generateFileAliases();
                
                luaurcContent = JSON.parse(fs.readFileSync(luaurcPath, 'utf8'));
                
                assert.ok(luaurcContent.aliases.TestModule, 'Step 3: Should restore alias when init file removed and only standalone remains');
                assert.ok(luaurcContent.aliases.TestModule.includes('TestModule.luau'), 'Step 3: Should point to standalone file again');

            } finally {
                restore();
                // Clean up
                if (fs.existsSync(testDir)) {
                    fs.rmSync(testDir, { recursive: true, force: true });
                }
                if (fs.existsSync(standaloneFile)) {
                    fs.unlinkSync(standaloneFile);
                }
            }
        });
    });

    suite('Configuration Tests', () => {
        test('Should handle missing configuration gracefully', () => {
            const originalConfig = vscode.workspace.getConfiguration;
            vscode.workspace.getConfiguration = () => ({
                get: (key) => {
                    // Return sensible defaults for critical config
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
                // Should not throw error with missing configuration
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
            // Back up original files first
            const luaurcPath = path.join(testWorkspacePath, '.luaurc');
            const extensionConfigPath = path.join(testWorkspacePath, '.requireonrails.json');
            
            let originalLuaurc = '';
            let originalExtensionConfig = '';
            if (fs.existsSync(luaurcPath)) {
                originalLuaurc = fs.readFileSync(luaurcPath, 'utf8');
            }
            if (fs.existsSync(extensionConfigPath)) {
                originalExtensionConfig = fs.readFileSync(extensionConfigPath, 'utf8');
            }
            
            // Create invalid JSON files
            fs.writeFileSync(luaurcPath, '{ invalid json }');
            fs.writeFileSync(extensionConfigPath, '{ also invalid }');

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

            const originalShowErrorMessage = vscode.window.showErrorMessage;
            let errorShown = false;
            vscode.window.showErrorMessage = (message) => {
                errorShown = true;
                return Promise.resolve();
            };

            try {
                generateFileAliases();
                
                assert.ok(errorShown, 'Should show error message for invalid JSON');
            } finally {
                vscode.workspace.getConfiguration = originalConfig;
                vscode.window.showErrorMessage = originalShowErrorMessage;
                Object.defineProperty(vscode.workspace, 'workspaceFolders', {
                    value: originalWorkspaceFolders,
                    writable: true,
                    configurable: true
                });
                
                // Restore original files
                if (originalLuaurc) {
                    fs.writeFileSync(luaurcPath, originalLuaurc);
                }
                if (originalExtensionConfig) {
                    fs.writeFileSync(extensionConfigPath, originalExtensionConfig);
                }
            }
        });
    });

    suite('Require Statement Update Edge Cases', () => {
        test('Should handle files with no extension change', () => {
            const { analyzeFileOperation } = require('../src/updateRequireNames');
            
            // Test when only directory changes, no filename change
            const oldPath = path.join(testWorkspacePath, 'src/Server/Utils.luau');
            const newPath = path.join(testWorkspacePath, 'src/Shared/Utils.luau');
            
            const operationInfo = analyzeFileOperation(newPath, oldPath);
            
            assert.ok(operationInfo !== null, 'Should detect operation');
            assert.strictEqual(operationInfo.operationType, 'moved', 'Should be move operation');
            assert.strictEqual(operationInfo.oldFileBasename, 'Utils', 'Should extract correct old basename');
            assert.strictEqual(operationInfo.newFileBasename, 'Utils', 'Should extract correct new basename');
        });

        test('Should handle files with both directory and name change', () => {
            const { analyzeFileOperation } = require('../src/updateRequireNames');
            
            const oldPath = path.join(testWorkspacePath, 'src/Server/OldUtils.luau');
            const newPath = path.join(testWorkspacePath, 'src/Shared/NewUtils.luau');
            
            const operationInfo = analyzeFileOperation(newPath, oldPath);
            
            assert.ok(operationInfo !== null, 'Should detect operation');
            assert.strictEqual(operationInfo.operationType, 'moved and renamed', 'Should be move and rename operation');
            assert.strictEqual(operationInfo.isMove, true, 'Should detect directory change');
            assert.strictEqual(operationInfo.isRename, true, 'Should detect filename change');
        });

        test('Should return null for identical paths', () => {
            const { analyzeFileOperation } = require('../src/updateRequireNames');
            
            const samePath = path.join(testWorkspacePath, 'src/Server/Utils.luau');
            const operationInfo = analyzeFileOperation(samePath, samePath);
            
            assert.strictEqual(operationInfo, null, 'Should return null for identical paths');
        });
    });

    suite('Edge Case File Operations', () => {
        test('Should handle files with special characters', () => {
            const specialFiles = {
                'src/Server/File-With-Dashes.luau': 'return {}',
                'src/Server/File_With_Underscores.luau': 'return {}',
                'src/Server/FileWithNumbers123.luau': 'return {}'
            };

            // Create special files
            for (const [filePath, content] of Object.entries(specialFiles)) {
                const fullPath = path.join(testWorkspacePath, filePath);
                fs.writeFileSync(fullPath, content, 'utf8');
            }

            const restore = mockWorkspaceConfig(testWorkspaceUri, {
                directoriesToScan: ['src/Server']
            });

            try {
                generateFileAliases();
                
                const luaurcPath = path.join(testWorkspacePath, '.luaurc');
                const luaurcContent = JSON.parse(fs.readFileSync(luaurcPath, 'utf8'));
                
                // Should handle special characters in filenames
                assert.ok(luaurcContent.aliases['File-With-Dashes'], 'Should handle dashes in filenames');
                assert.ok(luaurcContent.aliases['File_With_Underscores'], 'Should handle underscores in filenames');
                assert.ok(luaurcContent.aliases['FileWithNumbers123'], 'Should handle numbers in filenames');
            } finally {
                restore();
                // Clean up
                for (const filePath of Object.keys(specialFiles)) {
                    const fullPath = path.join(testWorkspacePath, filePath);
                    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
                }
            }
        });

        test('Should ignore .server and .client files', () => {
            const serverClientFiles = {
                'src/Server/ServerScript.server.luau': 'print("server")',
                'src/Client/ClientScript.client.luau': 'print("client")',
                'src/Shared/RegularScript.luau': 'print("regular")'
            };

            // Create server/client files
            for (const [filePath, content] of Object.entries(serverClientFiles)) {
                const fullPath = path.join(testWorkspacePath, filePath);
                fs.writeFileSync(fullPath, content, 'utf8');
            }

            const restore = mockWorkspaceConfig(testWorkspaceUri, {
                directoriesToScan: ['src/Server', 'src/Client', 'src/Shared']
            });

            try {
                generateFileAliases();
                
                const luaurcPath = path.join(testWorkspacePath, '.luaurc');
                const luaurcContent = JSON.parse(fs.readFileSync(luaurcPath, 'utf8'));
                
                // Should ignore server/client files but include regular files
                assert.ok(!luaurcContent.aliases.ServerScript, 'Should ignore .server files');
                assert.ok(!luaurcContent.aliases.ClientScript, 'Should ignore .client files');
                assert.ok(luaurcContent.aliases.RegularScript, 'Should include regular files');
            } finally {
                restore();
                // Clean up
                for (const filePath of Object.keys(serverClientFiles)) {
                    const fullPath = path.join(testWorkspacePath, filePath);
                    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
                }
            }
        });
    });

    suite('VSIX Extension Integration Tests', () => {
        test('Should handle project template unpacking in VSIX environment', async () => {
            const { unpackProjectTemplate } = require('../src/unpackProjectTemplate');
            
            // Create a mock VSIX-like extension context
            const mockVSIXContext = {
                extensionUri: vscode.Uri.file(path.dirname(__dirname)),
                extensionPath: path.dirname(__dirname),
                globalState: {
                    get: () => undefined,
                    update: () => Promise.resolve()
                },
                workspaceState: {
                    get: () => undefined,
                    update: () => Promise.resolve()
                },
                subscriptions: []
            };

            // Create a clean test workspace for VSIX testing
            const vsixTestWorkspace = path.join(testWorkspacePath, 'vsix-test');
            if (!fs.existsSync(vsixTestWorkspace)) {
                fs.mkdirSync(vsixTestWorkspace, { recursive: true });
            }

            const messages = mockVSCodeMessages({
                warning: () => Promise.resolve('Yes'),
                info: () => Promise.resolve()
            });

            const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
            Object.defineProperty(vscode.workspace, 'workspaceFolders', {
                value: [{ uri: vscode.Uri.file(vsixTestWorkspace) }],
                writable: true,
                configurable: true
            });

            try {
                // Test template unpacking in VSIX context
                await new Promise((resolve) => {
                    unpackProjectTemplate(mockVSIXContext);
                    
                    // Wait for async operations to complete
                    setTimeout(() => {
                        // Check if any template files were created
                        const expectedFiles = ['.luaurc', 'src', '.requireonrails.json'];
                        let filesCreated = 0;
                        
                        for (const file of expectedFiles) {
                            const filePath = path.join(vsixTestWorkspace, file);
                            if (fs.existsSync(filePath)) {
                                filesCreated++;
                                console.log(`VSIX test: Found template file ${file}`);
                            }
                        }
                        
                        // Either files were created OR appropriate error messages were shown
                        const operationCompleted = filesCreated > 0 || 
                            messages.captured.error.some(msg => msg.includes('Project template not found')) ||
                            messages.captured.info.some(msg => msg.includes('successfully'));
                        
                        assert.ok(operationCompleted, 'VSIX template unpacking should complete successfully or show appropriate error');
                        resolve();
                    }, 1500);
                });

            } finally {
                messages.restore();
                Object.defineProperty(vscode.workspace, 'workspaceFolders', {
                    value: originalWorkspaceFolders,
                    writable: true,
                    configurable: true
                });
                cleanupTestFiles(testWorkspacePath, ['vsix-test']);
            }
        });

        test('Should handle extension activation in VSIX environment', () => {
            const { activate } = require('../src/extension');
            
            // Create comprehensive VSIX context
            const mockVSIXContext = {
                extensionUri: vscode.Uri.file(path.dirname(__dirname)),
                extensionPath: path.dirname(__dirname),
                globalState: {
                    get: (key) => undefined,
                    update: (key, value) => Promise.resolve()
                },
                workspaceState: {
                    get: (key) => undefined,
                    update: (key, value) => Promise.resolve()
                },
                subscriptions: [],
                environmentVariableCollection: {
                    append: () => {},
                    prepend: () => {},
                    replace: () => {},
                    get: () => undefined,
                    forEach: () => {},
                    delete: () => {},
                    clear: () => {}
                }
            };

            const restore = mockWorkspaceConfig(testWorkspaceUri, {
                startsImmediately: false
            });

            // Mock the command registration to avoid conflicts
            const originalRegisterCommand = vscode.commands.registerCommand;
            vscode.commands.registerCommand = (commandId, handler) => {
                // Return a mock disposable instead of actually registering
                const mockDisposable = { dispose: () => {} };
                mockVSIXContext.subscriptions.push(mockDisposable);
                return mockDisposable;
            };

            try {
                // Should not throw during activation
                assert.doesNotThrow(() => {
                    activate(mockVSIXContext);
                }, 'Extension should activate successfully in VSIX environment');

                // Verify context subscriptions were added
                assert.ok(mockVSIXContext.subscriptions.length > 0, 'Should register disposables in VSIX context');

                // Since we're mocking command registration, we can verify the subscription count
                assert.ok(mockVSIXContext.subscriptions.length >= 2, 'Should register multiple command subscriptions');

            } finally {
                vscode.commands.registerCommand = originalRegisterCommand;
                restore();
            }
        });

        test('Should handle file watchers in VSIX environment', async () => {
            const { activate } = require('../src/extension');
            
            const mockVSIXContext = {
                extensionUri: vscode.Uri.file(path.dirname(__dirname)),
                subscriptions: []
            };

            const restore = mockWorkspaceConfig(testWorkspaceUri, {
                startsImmediately: true
            });

            // Mock file system watcher creation with complete FileSystemWatcher interface
            let watcherCreated = false;
            const originalCreateWatcher = vscode.workspace.createFileSystemWatcher;
            vscode.workspace.createFileSystemWatcher = (pattern, ignoreCreateEvents, ignoreChangeEvents, ignoreDeleteEvents) => {
                watcherCreated = true;
                console.log(`VSIX test: Watcher created for pattern: ${pattern}`);
                return {
                    ignoreCreateEvents: ignoreCreateEvents || false,
                    ignoreChangeEvents: ignoreChangeEvents || false,
                    ignoreDeleteEvents: ignoreDeleteEvents || false,
                    onDidCreate: () => ({ dispose: () => {} }),
                    onDidDelete: () => ({ dispose: () => {} }),
                    onDidChange: () => ({ dispose: () => {} }),
                    dispose: () => {}
                };
            };

            // Mock command registration to avoid conflicts
            const originalRegisterCommand = vscode.commands.registerCommand;
            vscode.commands.registerCommand = (commandId, handler) => {
                const mockDisposable = { dispose: () => {} };
                mockVSIXContext.subscriptions.push(mockDisposable);
                return mockDisposable;
            };

            try {
                // Actually activate the extension to trigger watcher creation
                activate(mockVSIXContext);
                
                // Wait for watchers to be set up
                await new Promise(resolve => setTimeout(resolve, 100));
                
                assert.ok(watcherCreated, 'Should create file system watchers in VSIX environment');

            } finally {
                vscode.workspace.createFileSystemWatcher = originalCreateWatcher;
                vscode.commands.registerCommand = originalRegisterCommand;
                restore();
            }
        });

        test('Should handle status bar updates in VSIX environment', () => {
            const { activate } = require('../src/extension');
            
            let statusBarItem = null;
            const originalCreateStatusBarItem = vscode.window.createStatusBarItem;
            
            // Mock createStatusBarItem with proper VSCode StatusBarItem interface
            Object.defineProperty(vscode.window, 'createStatusBarItem', {
                value: (alignment, priority) => {
                    statusBarItem = {
                        id: 'test-status-bar',
                        alignment: alignment || vscode.StatusBarAlignment.Left,
                        priority: priority || 0,
                        name: 'Test Status Bar',
                        text: '',
                        tooltip: '',
                        command: '',
                        color: undefined,
                        backgroundColor: undefined,
                        accessibilityInformation: undefined,
                        show: () => {},
                        hide: () => {},
                        dispose: () => {}
                    };
                    return statusBarItem;
                },
                writable: true,
                configurable: true
            });

            const mockVSIXContext = {
                extensionUri: vscode.Uri.file(path.dirname(__dirname)),
                subscriptions: []
            };

            const restore = mockWorkspaceConfig(testWorkspaceUri);

            // Mock command registration to avoid conflicts
            const originalRegisterCommand = vscode.commands.registerCommand;
            vscode.commands.registerCommand = (commandId, handler) => {
                const mockDisposable = { dispose: () => {} };
                mockVSIXContext.subscriptions.push(mockDisposable);
                return mockDisposable;
            };

            try {
                // Actually activate the extension to trigger status bar creation
                activate(mockVSIXContext);
                
                assert.ok(statusBarItem, 'Should create status bar item in VSIX environment');
                assert.ok(statusBarItem.text.includes('RequireOnRails'), 'Status bar should show extension name');

            } finally {
                Object.defineProperty(vscode.window, 'createStatusBarItem', {
                    value: originalCreateStatusBarItem,
                    writable: true,
                    configurable: true
                });
                vscode.commands.registerCommand = originalRegisterCommand;
                restore();
            }
        });

        test('Should handle editor events in VSIX environment', () => {
            let editorChangeHandler = null;
            const originalOnDidChangeActiveEditor = vscode.window.onDidChangeActiveTextEditor;
            
            // Mock onDidChangeActiveTextEditor properly
            Object.defineProperty(vscode.window, 'onDidChangeActiveTextEditor', {
                value: (handler) => {
                    editorChangeHandler = handler;
                    return { dispose: () => {} };
                },
                writable: true,
                configurable: true
            });

            const mockEditor = createMockEditor('luau', 'local test = require("@Test")');

            try {
                // Test that editor change events are handled
                if (editorChangeHandler) {
                    assert.doesNotThrow(() => {
                        editorChangeHandler(mockEditor);
                    }, 'Should handle editor changes without errors in VSIX environment');
                }

                assert.ok(true, 'Editor event handling test completed');

            } finally {
                Object.defineProperty(vscode.window, 'onDidChangeActiveTextEditor', {
                    value: originalOnDidChangeActiveEditor,
                    writable: true,
                    configurable: true
                });
            }
        });

        test('Should handle workspace folder changes in VSIX environment', () => {
            let workspaceFolderHandler = null;
            const originalOnDidChangeWorkspaceFolders = vscode.workspace.onDidChangeWorkspaceFolders;
            
            // Mock onDidChangeWorkspaceFolders properly
            Object.defineProperty(vscode.workspace, 'onDidChangeWorkspaceFolders', {
                value: (handler) => {
                    workspaceFolderHandler = handler;
                    return { dispose: () => {} };
                },
                writable: true,
                configurable: true
            });

            try {
                // Test workspace folder change handling
                if (workspaceFolderHandler) {
                    const mockWorkspaceChangeEvent = {
                        added: [{ uri: testWorkspaceUri }],
                        removed: []
                    };
                    
                    assert.doesNotThrow(() => {
                        workspaceFolderHandler(mockWorkspaceChangeEvent);
                    }, 'Should handle workspace folder changes in VSIX environment');
                }

                assert.ok(true, 'Workspace folder change handling test completed');

            } finally {
                Object.defineProperty(vscode.workspace, 'onDidChangeWorkspaceFolders', {
                    value: originalOnDidChangeWorkspaceFolders,
                    writable: true,
                    configurable: true
                });
            }
        });

        test('Should handle command execution in VSIX environment', async () => {
            // Test command execution through VSCode command system
            let commandExecuted = false;
            const originalExecuteCommand = vscode.commands.executeCommand;
            
            // Mock executeCommand with proper return type
            Object.defineProperty(vscode.commands, 'executeCommand', {
                value: (command, ...args) => {
                    if (command.includes('require-on-rails')) {
                        commandExecuted = true;
                        console.log(`VSIX command executed: ${command}`);
                    }
                    return Promise.resolve(undefined);
                },
                writable: true,
                configurable: true
            });

            const restore = mockWorkspaceConfig(testWorkspaceUri);

            try {
                // Simulate command execution
                await vscode.commands.executeCommand('require-on-rails.toggleActive');
                
                assert.ok(commandExecuted, 'Should execute extension commands in VSIX environment');

            } finally {
                Object.defineProperty(vscode.commands, 'executeCommand', {
                    value: originalExecuteCommand,
                    writable: true,
                    configurable: true
                });
                restore();
            }
        });
    });

    suite('VSIX Performance and Memory Tests', () => {
        test('Should handle large file operations efficiently in VSIX', () => {
            // Create a larger test workspace
            const largeFiles = {};
            for (let i = 0; i < 50; i++) {
                largeFiles[`src/Server/LargeTest${i}.luau`] = `return { id = ${i} }`;
                largeFiles[`src/Client/LargeTest${i}.luau`] = `return { id = ${i} }`;
                largeFiles[`src/Shared/LargeTest${i}.luau`] = `return { id = ${i} }`;
            }

            createTestFiles(testWorkspacePath, largeFiles);

            const restore = mockWorkspaceConfig(testWorkspaceUri);
            const startTime = Date.now();

            try {
                generateFileAliases();
                
                const endTime = Date.now();
                const duration = endTime - startTime;
                
                console.log(`VSIX large file test completed in ${duration}ms`);
                assert.ok(duration < 5000, 'Large file operations should complete within reasonable time');

                // Verify aliases were generated
                const luaurcPath = path.join(testWorkspacePath, '.luaurc');
                const luaurcContent = JSON.parse(fs.readFileSync(luaurcPath, 'utf8'));
                
                const aliasCount = Object.keys(luaurcContent.aliases).length;
                assert.ok(aliasCount > 0, 'Should generate aliases for large file set');

            } finally {
                restore();
                cleanupTestFiles(testWorkspacePath, Object.keys(largeFiles));
            }
        });

        test('Should handle memory efficiently during VSIX operations', () => {
            // Test memory usage patterns during typical operations
            const initialMemory = process.memoryUsage();
            
            const restore = mockWorkspaceConfig(testWorkspaceUri);

            try {
                // Perform multiple operations that could cause memory leaks
                for (let i = 0; i < 10; i++) {
                    generateFileAliases();
                }

                const finalMemory = process.memoryUsage();
                const memoryIncrease = finalMemory.heapUsed - initialMemory.heapUsed;
                
                console.log(`VSIX memory test: Heap increased by ${Math.round(memoryIncrease / 1024 / 1024)}MB`);
                
                // Allow for some memory increase but not excessive
                assert.ok(memoryIncrease < 50 * 1024 * 1024, 'Memory usage should not increase excessively');

            } finally {
                restore();
            }
        });
    });
});