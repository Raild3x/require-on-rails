const assert = require('assert');
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

// Import extension modules for testing
const { handleDynamicRename } = require('../../../src/features/dynamicRename');

// Import shared test utilities
const {
    mockWorkspaceConfig,
    mockVSCodeMessages,
    cleanupTestFiles,
    setupTestWorkspace
} = require('../utils/testUtils');

suite('Require Statement Update Tests', () => {
    vscode.window.showInformationMessage('Starting Require Statement Update tests...');

    let testWorkspaceUri;
    let testWorkspacePath;

    suiteSetup(async () => {
        testWorkspaceUri = vscode.Uri.file(path.join(__dirname, 'require-test-workspace'));
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

    test('Should detect file rename operation', async () => {
        const oldPath = path.join(testWorkspacePath, 'src/Server/OldName.luau');
        const newPath = path.join(testWorkspacePath, 'src/Server/NewName.luau');
        
        fs.writeFileSync(oldPath, 'return {}');
        
        const messages = mockVSCodeMessages();
        const restore = mockWorkspaceConfig(testWorkspaceUri);

        try {
            fs.renameSync(oldPath, newPath);
            await handleDynamicRename(newPath, oldPath);
            
            assert.ok(messages.captured.info.some(msg => 
                msg.includes('renamed') && msg.includes('OldName') && msg.includes('NewName')
            ), 'Should detect rename operation and show appropriate message');
        } finally {
            messages.restore();
            restore();
            cleanupTestFiles(testWorkspacePath, ['src/Server/OldName.luau', 'src/Server/NewName.luau']);
        }
    });

    test('Should detect file move operation', async () => {
        const oldPath = path.join(testWorkspacePath, 'src/Server/TestFile.luau');
        const newPath = path.join(testWorkspacePath, 'src/Shared/TestFile.luau');
        
        fs.writeFileSync(oldPath, 'return {}');
        
        const messages = mockVSCodeMessages();
        const restore = mockWorkspaceConfig(testWorkspaceUri, {
            manualAliases: {
                '@Server': 'src/Server',
                '@Client': 'src/Client',
                '@Shared': 'src/Shared'
            },
            enableAbsolutePathUpdates: true
        });

        try {
            fs.renameSync(oldPath, newPath);
            await handleDynamicRename(newPath, oldPath);
            
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
        const { analyzeFileOperation } = require('../../../src/features/requirePlanner');
        
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

    test('Should handle files with no extension change', () => {
        const { analyzeFileOperation } = require('../../../src/features/requirePlanner');
        
        const oldPath = path.join(testWorkspacePath, 'src/Server/Utils.luau');
        const newPath = path.join(testWorkspacePath, 'src/Shared/Utils.luau');
        
        const operationInfo = analyzeFileOperation(newPath, oldPath);
        
        assert.ok(operationInfo !== null, 'Should detect operation');
        assert.strictEqual(operationInfo.operationType, 'moved', 'Should be move operation');
        assert.strictEqual(operationInfo.oldFileBasename, 'Utils', 'Should extract correct old basename');
        assert.strictEqual(operationInfo.newFileBasename, 'Utils', 'Should extract correct new basename');
    });

    test('Should handle files with both directory and name change', () => {
        const { analyzeFileOperation } = require('../../../src/features/requirePlanner');
        
        const oldPath = path.join(testWorkspacePath, 'src/Server/OldUtils.luau');
        const newPath = path.join(testWorkspacePath, 'src/Shared/NewUtils.luau');
        
        const operationInfo = analyzeFileOperation(newPath, oldPath);
        
        assert.ok(operationInfo !== null, 'Should detect operation');
        assert.strictEqual(operationInfo.operationType, 'moved and renamed', 'Should be move and rename operation');
        assert.strictEqual(operationInfo.isMove, true, 'Should detect directory change');
        assert.strictEqual(operationInfo.isRename, true, 'Should detect filename change');
    });

    test('Should return null for identical paths', () => {
        const { analyzeFileOperation } = require('../../../src/features/requirePlanner');
        
        const samePath = path.join(testWorkspacePath, 'src/Server/Utils.luau');
        const operationInfo = analyzeFileOperation(samePath, samePath);
        
        assert.strictEqual(operationInfo, null, 'Should return null for identical paths');
    });

    test('Accepting the basename prompt rewrites exact requires and keeps their quotes', async () => {
        const files = {
            'src/Server/OldThing.luau': 'return {}',
            'src/Server/UsesThing.luau': 'local A = require("@OldThing")\nlocal B = require(\'@OldThing\')\nlocal C = require("@OldThingy")\n-- require("@OldThing")\n'
        };
        for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(testWorkspacePath, rel), content);
        const oldPath = path.join(testWorkspacePath, 'src/Server/OldThing.luau');
        const newPath = path.join(testWorkspacePath, 'src/Server/NewThing.luau');

        const messages = mockVSCodeMessages({ info: () => Promise.resolve('Yes') });
        const restore = mockWorkspaceConfig(testWorkspaceUri, { enableAbsolutePathUpdates: false });
        try {
            fs.renameSync(oldPath, newPath);
            await handleDynamicRename(newPath, oldPath);
            assert.strictEqual(fs.readFileSync(path.join(testWorkspacePath, 'src/Server/UsesThing.luau'), 'utf8'),
                'local A = require("@NewThing")\nlocal B = require(\'@NewThing\')\nlocal C = require("@OldThingy")\n-- require("@OldThing")\n');
        } finally {
            messages.restore();
            restore();
            cleanupTestFiles(testWorkspacePath, ['src/Server/OldThing.luau', 'src/Server/NewThing.luau', 'src/Server/UsesThing.luau']);
        }
    });

    test('A colliding name is renamed to _Duplicate, and requires follow it', async () => {
        const files = {
            'src/Shared/Taken.luau': 'return {}',
            'src/Server/Mine.luau': 'return {}',
            'src/Server/UsesMine.luau': 'local M = require("@Mine")\n'
        };
        for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(testWorkspacePath, rel), content);
        const oldPath = path.join(testWorkspacePath, 'src/Server/Mine.luau');
        const newPath = path.join(testWorkspacePath, 'src/Server/Taken.luau');

        const messages = mockVSCodeMessages({ info: () => Promise.resolve('Yes') });
        const restore = mockWorkspaceConfig(testWorkspaceUri, { enableFileNameCollisionResolution: true, enableAbsolutePathUpdates: false });
        try {
            fs.renameSync(oldPath, newPath);
            await handleDynamicRename(newPath, oldPath);
            assert.ok(fs.existsSync(path.join(testWorkspacePath, 'src/Server/Taken_Duplicate.luau')), 'renamed on disk');
            assert.ok(messages.captured.warning.some(msg => msg.includes('Taken_Duplicate')));
            assert.strictEqual(fs.readFileSync(path.join(testWorkspacePath, 'src/Server/UsesMine.luau'), 'utf8'),
                'local M = require("@Taken_Duplicate")\n');
        } finally {
            messages.restore();
            restore();
            cleanupTestFiles(testWorkspacePath, ['src/Shared/Taken.luau', 'src/Server/Taken.luau', 'src/Server/Taken_Duplicate.luau', 'src/Server/UsesMine.luau']);
        }
    });

    test('A collision never overwrites an existing _Duplicate file', async () => {
        const files = {
            'src/Shared/Taken.luau': 'return {}',
            'src/Server/Taken_Duplicate.luau': 'return "keep me"',
            'src/Server/Mine.luau': 'return {}'
        };
        for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(testWorkspacePath, rel), content);
        const oldPath = path.join(testWorkspacePath, 'src/Server/Mine.luau');
        const newPath = path.join(testWorkspacePath, 'src/Server/Taken.luau');

        const messages = mockVSCodeMessages();
        const restore = mockWorkspaceConfig(testWorkspaceUri, { enableFileNameCollisionResolution: true, enableAbsolutePathUpdates: false });
        try {
            fs.renameSync(oldPath, newPath);
            await handleDynamicRename(newPath, oldPath);
            assert.strictEqual(fs.readFileSync(path.join(testWorkspacePath, 'src/Server/Taken_Duplicate.luau'), 'utf8'), 'return "keep me"');
            assert.ok(fs.existsSync(newPath), 'the renamed file stays where the user put it');
            assert.ok(messages.captured.warning.some(msg => msg.includes('already exists')));
        } finally {
            messages.restore();
            restore();
            cleanupTestFiles(testWorkspacePath, ['src/Shared/Taken.luau', 'src/Server/Taken.luau', 'src/Server/Taken_Duplicate.luau']);
        }
    });
});
