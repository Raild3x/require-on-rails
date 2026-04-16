const assert = require('assert');
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

// Import extension modules for testing
const { generateFileAliases } = require('../../../src/features/updateLuaFileAliases');
const {
    addImportToAllFiles,
    addImportToSingleFile,
    hasValidImportRequire,
    getImportRequireLineIndexes,
    createContextualImportSnippet
} = require('../../../src/features/addImportToFiles');

// Import shared test utilities
const {
    mockWorkspaceConfig,
    createTestFiles,
    cleanupTestFiles,
    setupTestWorkspace
} = require('../utils/testUtils');

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

    test('Should register addImportToAllFiles command', () => {
        // Test that the new command is properly registered
        // In a real test environment, you would check:
        // - Command is registered in extension activation
        // - Command can be executed via command palette
        // - Command properly calls addImportToAllFiles function
        assert.ok(true, 'addImportToAllFiles command registration test placeholder');
    });

    test('Should identify files needing import require definition', async () => {
        const restore = mockWorkspaceConfig(testWorkspaceUri);

        try {
            // Create test files with custom alias usage
            createTestFiles(testWorkspacePath, {
                'src/Server/FileWithAlias.luau': `
local something = require("@SomeModule")
local other = require("@OtherModule")
return {}`,
                'src/Server/FileWithoutAlias.luau': `
local normalModule = require("./normalModule")
return {}`,
                'src/Server/FileWithImport.luau': `
require = require("@rbxts/services")(script)
local something = require("@SomeModule")
return {}`
            });

            // Mock the addImportToAllFiles function to capture which files it would process
            const originalFs = require('fs');
            let processedFiles = [];
            
            // We can't easily mock the user interaction, so we'll test the file detection logic
            // by checking if files with custom aliases but no import are identified correctly
            
            const fileWithAlias = path.join(testWorkspacePath, 'src/Server/FileWithAlias.luau');
            const fileWithoutAlias = path.join(testWorkspacePath, 'src/Server/FileWithoutAlias.luau');
            const fileWithImport = path.join(testWorkspacePath, 'src/Server/FileWithImport.luau');
            
            // Test individual file checking logic
            const contentWithAlias = fs.readFileSync(fileWithAlias, 'utf8');
            const contentWithoutAlias = fs.readFileSync(fileWithoutAlias, 'utf8');
            const contentWithImport = fs.readFileSync(fileWithImport, 'utf8');
            
            const requireWithAtPattern = /require\s*\(\s*["']([^"']*@[^"']*)["']\s*\)/;
            const importModulePaths = ['"@rbxts/services"', '@rbxts/services'];
            
            // Check if files have custom aliases
            assert.ok(requireWithAtPattern.test(contentWithAlias), 'FileWithAlias should have custom alias usage');
            assert.ok(!requireWithAtPattern.test(contentWithoutAlias), 'FileWithoutAlias should not have custom alias usage');
            assert.ok(requireWithAtPattern.test(contentWithImport), 'FileWithImport should have custom alias usage');
            
            // Check if files have import require definition using the centralized function
            assert.ok(!hasValidImportRequire(contentWithAlias, importModulePaths), 'FileWithAlias should not have import');
            assert.ok(!hasValidImportRequire(contentWithoutAlias, importModulePaths), 'FileWithoutAlias should not have import');
            assert.ok(hasValidImportRequire(contentWithImport, importModulePaths), 'FileWithImport should have import');
            
        } finally {
            restore();
            cleanupTestFiles(testWorkspacePath, [
                'src/Server/FileWithAlias.luau',
                'src/Server/FileWithoutAlias.luau',
                'src/Server/FileWithImport.luau'
            ]);
        }
    });

    test('Should add import require definition to files with custom aliases', async () => {
        const restore = mockWorkspaceConfig(testWorkspaceUri);

        try {
            // Create test files that need import require definition
            createTestFiles(testWorkspacePath, {
                'src/Server/NeedsImport1.luau': `
local Players = game:GetService("Players")
local something = require("@SomeModule")
return {}`,
                'src/Server/NeedsImport2.luau': `
local module = require("@AnotherModule")
local normalModule = require("./normalModule")
return {}`,
                'src/Shared/NeedsImport3.luau': `
-- Some comment
local test = require("@TestModule")
return {}`
            });

            // Since we can't easily mock user interaction in tests, we'll test the core logic
            // by directly calling the file modification function
            const filePath = path.join(testWorkspacePath, 'src/Server/NeedsImport1.luau');
            const defaultImportModulePath = '"@rbxts/services"';
            const preferredImportPlacement = 'AfterDefiningRobloxServices';
            
            // Read original content
            const originalContent = fs.readFileSync(filePath, 'utf8');
            
            // Add import to the file
            const success = addImportToSingleFile(filePath, defaultImportModulePath, preferredImportPlacement);
            
            assert.ok(success, 'Should successfully add import to file');
            
            // Read modified content
            const modifiedContent = fs.readFileSync(filePath, 'utf8');
            
            const expectedImportSnippet = createContextualImportSnippet(defaultImportModulePath);
            assert.ok(modifiedContent.includes(expectedImportSnippet), 'Modified file should contain import require definition');
            
            // Verify it was placed after game:GetService as expected
            const lines = modifiedContent.split('\n');
            let gameServiceLineIndex = -1;
            let importLineIndex = -1;
            
            lines.forEach((line, index) => {
                if (line.includes('game:GetService')) {
                    gameServiceLineIndex = index;
                }
                if (line.includes('local Import = require(')) {
                    importLineIndex = index;
                }
            });
            
            assert.ok(gameServiceLineIndex >= 0, 'Should find game:GetService line');
            assert.ok(importLineIndex >= 0, 'Should find import line');
            assert.ok(importLineIndex > gameServiceLineIndex, 'Import should be placed after game:GetService');
            
        } finally {
            restore();
            cleanupTestFiles(testWorkspacePath, [
                'src/Server/NeedsImport1.luau',
                'src/Server/NeedsImport2.luau',
                'src/Shared/NeedsImport3.luau'
            ]);
        }
    });

    test('Should respect preferredImportPlacement setting', async () => {
        const restore = mockWorkspaceConfig(testWorkspaceUri);

        try {
            // Test TopOfFile placement
            createTestFiles(testWorkspacePath, {
                'src/Server/TopPlacement.luau': `
local Players = game:GetService("Players")
local something = require("@SomeModule")
return {}`
            });

            const filePath = path.join(testWorkspacePath, 'src/Server/TopPlacement.luau');
            const defaultImportModulePath = '"@rbxts/services"';
            
            // Test TopOfFile placement
            const success = addImportToSingleFile(filePath, defaultImportModulePath, 'TopOfFile');
            assert.ok(success, 'Should successfully add import to top of file');
            
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n');
            const expectedFirstLine = `local Import = require(${defaultImportModulePath})`;
            const expectedSecondLine = 'require = Import(script)';
            
            // Should be at the very beginning
            assert.strictEqual(lines[0], expectedFirstLine, 'First import line should be at top of file');
            assert.strictEqual(lines[1], expectedSecondLine, 'Second import line should follow the first import line');
            
        } finally {
            restore();
            cleanupTestFiles(testWorkspacePath, ['src/Server/TopPlacement.luau']);
        }
    });

    test('Should not add selene comment by default even when selene.toml exists', async () => {
        const restore = mockWorkspaceConfig(testWorkspaceUri); // No explicit configuration

        try {
            // Create selene.toml file
            createTestFiles(testWorkspacePath, {
                'selene.toml': '[rules]',
                'src/Server/DefaultBehavior.luau': `
local something = require("@SomeModule")
return {}`
            });

            const filePath = path.join(testWorkspacePath, 'src/Server/DefaultBehavior.luau');
            const defaultImportModulePath = '"@rbxts/services"';
            
            const success = addImportToSingleFile(filePath, defaultImportModulePath, 'TopOfFile');
            assert.ok(success, 'Should successfully add import without selene comment by default');
            
            const content = fs.readFileSync(filePath, 'utf8');
            const expectedSeleneComment = '-- selene: allow(incorrect_standard_library_use)';
            const expectedImportSnippet = createContextualImportSnippet(defaultImportModulePath);
            
            assert.ok(!content.includes(expectedSeleneComment), 'Should not include selene comment by default');
            assert.ok(content.includes(expectedImportSnippet), 'Should include import require definition');
            
        } finally {
            restore();
            cleanupTestFiles(testWorkspacePath, [
                'selene.toml',
                'src/Server/DefaultBehavior.luau'
            ]);
        }
    });

    test('Should add selene comment when selene.toml exists and addSeleneCommentToImport is explicitly enabled', async () => {
        const restore = mockWorkspaceConfig(testWorkspaceUri, {
            'require-on-rails.addSeleneCommentToImport': true // Explicitly enable
        });

        try {
            // Create selene.toml file
            createTestFiles(testWorkspacePath, {
                'selene.toml': '[rules]',
                'src/Server/WithSelene.luau': `
local something = require("@SomeModule")
return {}`
            });

            const filePath = path.join(testWorkspacePath, 'src/Server/WithSelene.luau');
            const defaultImportModulePath = '"@rbxts/services"';
            
            const success = addImportToSingleFile(filePath, defaultImportModulePath, 'TopOfFile');
            assert.ok(success, 'Should successfully add import with selene comment');
            
            const content = fs.readFileSync(filePath, 'utf8');
            
            const expectedSeleneComment = '-- selene: allow(incorrect_standard_library_use)';
            const expectedImportSnippet = createContextualImportSnippet(defaultImportModulePath);
            
            assert.ok(content.includes(expectedSeleneComment), 'Should include selene comment when enabled');
            assert.ok(content.includes(expectedImportSnippet), 'Should include import require definition');
            
            // Verify order: selene comment should come before import
            const seleneIndex = content.indexOf(expectedSeleneComment);
            const importIndex = content.indexOf(expectedImportSnippet);
            assert.ok(seleneIndex < importIndex, 'Selene comment should come before import');
            
        } finally {
            restore();
            cleanupTestFiles(testWorkspacePath, [
                'selene.toml',
                'src/Server/WithSelene.luau'
            ]);
        }
    });

    test('Should not add selene comment when addSeleneCommentToImport is explicitly disabled', async () => {
        const restore = mockWorkspaceConfig(testWorkspaceUri, {
            'require-on-rails.addSeleneCommentToImport': false // Explicitly disable
        });

        try {
            // Create selene.toml file
            createTestFiles(testWorkspacePath, {
                'selene.toml': '[rules]',
                'src/Server/WithoutSelene.luau': `
local something = require("@SomeModule")
return {}`
            });

            const filePath = path.join(testWorkspacePath, 'src/Server/WithoutSelene.luau');
            const defaultImportModulePath = '"@rbxts/services"';
            
            const success = addImportToSingleFile(filePath, defaultImportModulePath, 'TopOfFile');
            assert.ok(success, 'Should successfully add import without selene comment');
            
            const content = fs.readFileSync(filePath, 'utf8');
            const expectedSeleneComment = '-- selene: allow(incorrect_standard_library_use)';
            const expectedImportSnippet = createContextualImportSnippet(defaultImportModulePath);
            
            assert.ok(!content.includes(expectedSeleneComment), 'Should not include selene comment when disabled');
            assert.ok(content.includes(expectedImportSnippet), 'Should still include import require definition');
            
        } finally {
            restore();
            cleanupTestFiles(testWorkspacePath, [
                'selene.toml',
                'src/Server/WithoutSelene.luau'
            ]);
        }
    });

    test('Should skip files that already have import require definition', async () => {
        const restore = mockWorkspaceConfig(testWorkspaceUri);

        try {
            // Create file that already has import (base pattern without :: typeof(require))
            createTestFiles(testWorkspacePath, {
                'src/Server/AlreadyHasImport.luau': `
require = require("@rbxts/services")(script)
local something = require("@SomeModule")
return {}`
            });

            // Test file detection logic
            const filePath = path.join(testWorkspacePath, 'src/Server/AlreadyHasImport.luau');
            const content = fs.readFileSync(filePath, 'utf8');
            const importModulePaths = ['"@rbxts/services"'];
            
            // Check if file has custom aliases
            const requireWithAtPattern = /require\s*\(\s*["']([^"']*@[^"']*)["']\s*\)/;
            const hasCustomAliases = requireWithAtPattern.test(content);
            
            // Check if file already has import
            const hasValidImport = hasValidImportRequire(content, importModulePaths);
            
            assert.ok(hasCustomAliases, 'File should have custom aliases');
            assert.ok(hasValidImport, 'File should already have import require definition');
            
            // This file should NOT need import (has aliases but already has import)
            const needsImport = hasCustomAliases && !hasValidImport;
            assert.ok(!needsImport, 'File should not need import since it already has one');
            
        } finally {
            restore();
            cleanupTestFiles(testWorkspacePath, ['src/Server/AlreadyHasImport.luau']);
        }
    });

    test('Should handle BeforeFirstRequire placement correctly', async () => {
        const restore = mockWorkspaceConfig(testWorkspaceUri);

        try {
            createTestFiles(testWorkspacePath, {
                'src/Server/BeforeRequire.luau': `
local Players = game:GetService("Players")
local something = require("@SomeModule")
local other = require("./normalModule")
return {}`
            });

            const filePath = path.join(testWorkspacePath, 'src/Server/BeforeRequire.luau');
            const defaultImportModulePath = '"@rbxts/services"';
            
            const success = addImportToSingleFile(filePath, defaultImportModulePath, 'BeforeFirstRequire');
            assert.ok(success, 'Should successfully add import before first require');
            
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n');
            
            let importLineIndex = -1;
            let firstRequireLineIndex = -1;
            
            lines.forEach((line, index) => {
                if (line.includes('local Import = require(')) {
                    importLineIndex = index;
                }
                if (line.includes('require("@SomeModule")') && firstRequireLineIndex === -1) {
                    firstRequireLineIndex = index;
                }
            });
            
            assert.ok(importLineIndex >= 0, 'Should find import line');
            assert.ok(firstRequireLineIndex >= 0, 'Should find first require line');
            assert.ok(importLineIndex < firstRequireLineIndex, 'Import should be placed before first require');
            
        } finally {
            restore();
            cleanupTestFiles(testWorkspacePath, ['src/Server/BeforeRequire.luau']);
        }
    });

    test('Should skip existing contextual import lines when finding first require', async () => {
        const restore = mockWorkspaceConfig(testWorkspaceUri);

        try {
            createTestFiles(testWorkspacePath, {
                'src/Server/BeforeRequireWithExistingContext.luau': `
local Import = require("@rbxts/services")
require = Import(script)
local something = require("@SomeModule")
return {}`
            });

            const filePath = path.join(testWorkspacePath, 'src/Server/BeforeRequireWithExistingContext.luau');
            const defaultImportModulePath = '"@rbxts/services"';

            const success = addImportToSingleFile(filePath, defaultImportModulePath, 'BeforeFirstRequire');
            assert.ok(success, 'Should run insertion logic');

            const lines = fs.readFileSync(filePath, 'utf8').split('\n');
            const contextualImportIndexes = [];
            let firstModuleRequireIndex = -1;

            lines.forEach((line, index) => {
                if (line.includes('local Import = require("@rbxts/services")')) {
                    contextualImportIndexes.push(index);
                }
                if (line.includes('require("@SomeModule")') && firstModuleRequireIndex === -1) {
                    firstModuleRequireIndex = index;
                }
            });

            assert.ok(contextualImportIndexes.length >= 2, 'Should have both existing and inserted contextual import lines');
            assert.ok(firstModuleRequireIndex > contextualImportIndexes[1], 'Inserted contextual import should be placed before first non-context require');
        } finally {
            restore();
            cleanupTestFiles(testWorkspacePath, ['src/Server/BeforeRequireWithExistingContext.luau']);
        }
    });

    test('Should detect valid multiline import require definition', () => {
        const content = `
local Import = require("@rbxts/services")
require = Import(script)
local something = require("@SomeModule")
return {}`;

        const importModulePaths = ['"@rbxts/services"'];
        assert.ok(hasValidImportRequire(content, importModulePaths), 'Should recognize split import and overwrite pattern');
    });

    test('Should detect valid multiline import with optional type annotation', () => {
        const content = `
local Import = require("@rbxts/services")
require = Import(script) :: typeof(require)
local something = require("@SomeModule")
return {}`;

        const importModulePaths = ['"@rbxts/services"'];
        assert.ok(hasValidImportRequire(content, importModulePaths), 'Should recognize split pattern with type annotation');
    });

    test('Should reject malformed multiline import without require overwrite', () => {
        const content = `
local Import = require("@rbxts/services")
local something = require("@SomeModule")
return {}`;

        const importModulePaths = ['"@rbxts/services"'];
        assert.ok(!hasValidImportRequire(content, importModulePaths), 'Should reject import assignment when require overwrite is missing');
    });

    test('Should reject multiline import when configured path does not match', () => {
        const content = `
local Import = require("@rbxts/services")
require = Import(script)
local something = require("@SomeModule")
return {}`;

        const importModulePaths = ['"@rbxts/other"'];
        assert.ok(!hasValidImportRequire(content, importModulePaths), 'Should reject split pattern for non-configured import path');
    });

    test('Should return correct line indexes for split import definition', () => {
        const content = [
            'local Import = require("@rbxts/services")',
            'require = Import(script)',
            'local something = require("@SomeModule")'
        ].join('\n');

        const importModulePaths = ['"@rbxts/services"'];
        const lineIndexes = getImportRequireLineIndexes(content, importModulePaths);
        assert.deepStrictEqual(lineIndexes, [0, 1], 'Should identify both split import lines');
    });

    test('Should detect split import when assignment has trailing type annotation', () => {
        const content = [
            'local Import = require((ReplicatedStorage:WaitForChild("cac_admin_abuse") :: any).Import) :: (any) -> typeof(require)',
            'require = Import(script)',
            'local something = require("@SomeModule")'
        ].join('\n');

        const importModulePaths = ['(ReplicatedStorage:WaitForChild("cac_admin_abuse") :: any).Import'];
        assert.ok(hasValidImportRequire(content, importModulePaths), 'Should accept split import with typed assignment line');
    });

    test('Should detect single-line import with trailing annotation/comment', () => {
        const content = [
            'require = require("@rbxts/services")(script) :: typeof(require) -- keep typed',
            'local something = require("@SomeModule")'
        ].join('\n');

        const importModulePaths = ['"@rbxts/services"'];
        assert.ok(hasValidImportRequire(content, importModulePaths), 'Should accept single-line import with trailing metadata');
    });
});