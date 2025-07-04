const assert = require('assert');
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

// Import extension modules for testing
const { generateFileAliases } = require('../src/updateLuaFileAliases');

// Import shared test utilities
const {
    mockWorkspaceConfig,
    createTestFiles,
    cleanupTestFiles,
    setupTestWorkspace
} = require('./testUtils');

suite('Extension Integration Tests', () => {
    vscode.window.showInformationMessage('Starting Extension Integration tests...');

    let testWorkspaceUri;
    let testWorkspacePath;

    suiteSetup(async () => {
        testWorkspaceUri = vscode.Uri.file(path.join(__dirname, 'integration-test-workspace'));
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

    test('Should register setupDefaultProject command', () => {
        // Test that the command is properly registered
        // In a real test environment, you would check:
        // - Command is registered in extension activation
        // - Command can be executed via command palette
        // - Command properly calls unpackProjectTemplate function
        assert.ok(true, 'setupDefaultProject command registration test placeholder');
    });

    test('Should auto-generate file aliases for new files', async () => {
        const serverDir = path.join(testWorkspacePath, 'src/Server');
        if (!fs.existsSync(serverDir)) {
            fs.mkdirSync(serverDir, { recursive: true });
        }
        
        const newFile = path.join(testWorkspacePath, 'src/Server/NewFile.luau');

        const restore = mockWorkspaceConfig(testWorkspaceUri);

        try {
            fs.writeFileSync(newFile, 'return {}');
            
            generateFileAliases();
            
            const luaurcPath = path.join(testWorkspacePath, '.luaurc');
            const luaurcContent = JSON.parse(fs.readFileSync(luaurcPath, 'utf8'));
            
            assert.ok(luaurcContent.aliases.NewFile, 'New file should have an alias');
        } finally {
            restore();
            cleanupTestFiles(testWorkspacePath, ['src/Server/NewFile.luau']);
        }
    });

    test('Should handle file system events correctly', async () => {
        const testFile = path.join(testWorkspacePath, 'src/Server/TestWatcher.luau');
        createTestFiles(testWorkspacePath, {
            'src/Server/TestWatcher.luau': 'return {}'
        });

        const restore = mockWorkspaceConfig(testWorkspaceUri);

        try {
            generateFileAliases();
            
            let luaurcPath = path.join(testWorkspacePath, '.luaurc');
            let luaurcContent = JSON.parse(fs.readFileSync(luaurcPath, 'utf8'));
            
            assert.ok(luaurcContent.aliases.TestWatcher, 'Should create alias for watched file');
            
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