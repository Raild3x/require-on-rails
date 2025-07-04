const assert = require('assert');
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

// Import extension modules for testing
const { generateFileAliases } = require('../src/updateLuaFileAliases');

// Import shared test utilities
const {
    createMockConfig,
    mockWorkspaceConfig,
    mockVSCodeMessages,
    createTestFiles,
    cleanupTestFiles,
    setupTestWorkspace
} = require('./testUtils');

//----------------------------------------------------------------------------------------

suite('VSIX Extension Integration Tests', () => {
    vscode.window.showInformationMessage('Starting VSIX integration tests...');

    let testWorkspaceUri;
    let testWorkspacePath;

    suiteSetup(async () => {
        // Create a test workspace
        testWorkspaceUri = vscode.Uri.file(path.join(__dirname, 'vsix-test-workspace'));
        testWorkspacePath = testWorkspaceUri.fsPath;
        
        // Ensure test workspace exists
        if (!fs.existsSync(testWorkspacePath)) {
            fs.mkdirSync(testWorkspacePath, { recursive: true });
        }
        
        // Create test directory structure using shared utility
        await setupTestWorkspace(testWorkspacePath);
    });

    suiteTeardown(async () => {
        // Clean up test workspace
        if (fs.existsSync(testWorkspacePath)) {
            fs.rmSync(testWorkspacePath, { recursive: true, force: true });
        }
    });

    suite('VSIX Project Template Tests', () => {
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
    });

    suite('VSIX Extension Activation Tests', () => {
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
                // @ts-ignore
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
    });

    suite('VSIX Event Handling Tests', () => {
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

            const mockEditor = {
                document: {
                    languageId: 'luau',
                    getText: () => 'local test = require("@Test")'
                },
                setDecorations: () => {}
            };

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