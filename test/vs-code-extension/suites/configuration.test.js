const assert = require('assert');
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Import extension modules for testing
const { generateFileAliases, setExtensionContext } = require('../../../src/features/updateLuaFileAliases');
const { hideLines } = require('../../../src/features/hideLines');

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

    // onAliasesRegenerated never runs straight from workspace settings: opening a repository
    // must not be enough to make RequireOnRails execute shell commands. These cover the
    // scope split and the per-workspace approval that lets the user opt in.

    // Stands in for ExtensionContext.workspaceState, which is per-workspace by construction.
    function fakeWorkspaceState(initial = {}) {
        const store = { ...initial };
        return {
            get: (key) => store[key],
            update: (key, value) => { store[key] = value; return Promise.resolve(); }
        };
    }

    function mockScopedAliasCommands({ globalValue, workspaceValue, workspaceUri }) {
        const originalConfig = vscode.workspace.getConfiguration;
        const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
        const scoped = { directoriesToScan: ['src/Server'], ignoreDirectories: [], pathPriority: [], manualAliases: {} };

        vscode.workspace.getConfiguration = () => ({
            get: (key, defaultValue) => (key in scoped ? scoped[key] : defaultValue),
            has: (key) => key in scoped,
            inspect: (key) => {
                if (key === 'onAliasesRegenerated') {
                    return { workspaceFolderValue: undefined, workspaceValue, globalValue, defaultValue: [] };
                }
                return { workspaceFolderValue: undefined, workspaceValue: scoped[key], globalValue: undefined, defaultValue: undefined };
            },
            update: () => Promise.resolve()
        });
        Object.defineProperty(vscode.workspace, 'workspaceFolders', {
            value: [{ uri: workspaceUri || testWorkspaceUri }], writable: true, configurable: true
        });

        return () => {
            vscode.workspace.getConfiguration = originalConfig;
            Object.defineProperty(vscode.workspace, 'workspaceFolders', {
                value: originalWorkspaceFolders, writable: true, configurable: true
            });
        };
    }

    test('Should notify the user when the workspace requests onAliasesRegenerated commands', () => {
        // Nothing is in globalValue, so nothing executes and the shared workspace is safe to use.
        const restore = mockScopedAliasCommands({ globalValue: undefined, workspaceValue: ['echo pwned'] });
        const messages = mockVSCodeMessages();

        try {
            generateFileAliases();

            assert.strictEqual(messages.captured.warning.length, 1, 'Should notify exactly once');
            assert.ok(
                /wants to run 1 command\(s\)/.test(messages.captured.warning[0]),
                `Notification should say what the workspace wants, got: ${messages.captured.warning[0]}`
            );
            assert.ok(
                /approve/i.test(messages.captured.warning[0]),
                'Notification should say the commands are withheld pending the user\'s approval'
            );
        } finally {
            messages.restore();
            restore();
        }
    });

    test('Approving workspace commands should record them for that workspace only', async () => {
        const approvingState = fakeWorkspaceState();
        const otherState = fakeWorkspaceState();

        setExtensionContext({ workspaceState: approvingState });
        const restore = mockScopedAliasCommands({ globalValue: undefined, workspaceValue: ['echo approved'] });
        // Click through "Review Commands" and then the confirmation modal.
        const messages = mockVSCodeMessages({
            warning: (message, ...options) => Promise.resolve(
                JSON.stringify(options).includes('Review Commands') ? 'Review Commands' : 'Approve for This Workspace'
            )
        });

        try {
            generateFileAliases();
            // The prompts resolve on the microtask queue, after generateFileAliases returns.
            for (let i = 0; i < 5; i++) await Promise.resolve();

            assert.deepStrictEqual(approvingState.get('approvedAliasCommands'), ['echo approved'],
                'Approval should be recorded in the approving workspace\'s own state');
            assert.strictEqual(otherState.get('approvedAliasCommands'), undefined,
                'Approving here must not approve anything for any other workspace');
        } finally {
            messages.restore();
            restore();
            setExtensionContext(null);
        }
    });

    test('Should not notify when the commands are already in the user\'s own settings', () => {
        // This one has user-scoped commands, so they really do run. They are spawned with the
        // workspace root as cwd, and Windows will not let us delete a directory that a live
        // process is sitting in, so give this test a throwaway workspace of its own.
        const scratchPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ror-cmd-scope-'));
        fs.mkdirSync(path.join(scratchPath, 'src', 'Server'), { recursive: true });
        const restore = mockScopedAliasCommands({
            globalValue: ['echo mine'],
            workspaceValue: ['echo mine'],
            workspaceUri: vscode.Uri.file(scratchPath)
        });
        const messages = mockVSCodeMessages();

        try {
            generateFileAliases();

            assert.strictEqual(messages.captured.warning.length, 0,
                `Should stay silent when nothing is being withheld, got: ${JSON.stringify(messages.captured.warning)}`);
        } finally {
            messages.restore();
            restore();
            try {
                fs.rmSync(scratchPath, { recursive: true, force: true });
            } catch (e) {
                // The echo shell may still hold the cwd; it is a temp dir, so leave it to the OS.
            }
        }
    });
});
