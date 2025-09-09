const assert = require('assert');
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

// Import extension modules for testing
const { updateRequireNames } = require('../../src/features/updateRequireNames');

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
        const { analyzeFileOperation } = require('../../src/features/updateRequireNames');
        
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
        const { analyzeFileOperation } = require('../../src/features/updateRequireNames');
        
        const oldPath = path.join(testWorkspacePath, 'src/Server/Utils.luau');
        const newPath = path.join(testWorkspacePath, 'src/Shared/Utils.luau');
        
        const operationInfo = analyzeFileOperation(newPath, oldPath);
        
        assert.ok(operationInfo !== null, 'Should detect operation');
        assert.strictEqual(operationInfo.operationType, 'moved', 'Should be move operation');
        assert.strictEqual(operationInfo.oldFileBasename, 'Utils', 'Should extract correct old basename');
        assert.strictEqual(operationInfo.newFileBasename, 'Utils', 'Should extract correct new basename');
    });

    test('Should handle files with both directory and name change', () => {
        const { analyzeFileOperation } = require('../../src/features/updateRequireNames');
        
        const oldPath = path.join(testWorkspacePath, 'src/Server/OldUtils.luau');
        const newPath = path.join(testWorkspacePath, 'src/Shared/NewUtils.luau');
        
        const operationInfo = analyzeFileOperation(newPath, oldPath);
        
        assert.ok(operationInfo !== null, 'Should detect operation');
        assert.strictEqual(operationInfo.operationType, 'moved and renamed', 'Should be move and rename operation');
        assert.strictEqual(operationInfo.isMove, true, 'Should detect directory change');
        assert.strictEqual(operationInfo.isRename, true, 'Should detect filename change');
    });

    test('Should return null for identical paths', () => {
        const { analyzeFileOperation } = require('../../src/features/updateRequireNames');
        
        const samePath = path.join(testWorkspacePath, 'src/Server/Utils.luau');
        const operationInfo = analyzeFileOperation(samePath, samePath);
        
        assert.strictEqual(operationInfo, null, 'Should return null for identical paths');
    });
});
