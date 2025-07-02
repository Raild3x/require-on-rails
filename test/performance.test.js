const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { generateFileAliases } = require('../src/updateLuaFileAliases');
const { createTestWorkspace, cleanupTestWorkspace, mockVSCodeConfiguration, createMockWorkspace } = require('./testUtils');

suite('Performance Tests', () => {
    let testWorkspacePath;

    suiteSetup(() => {
        testWorkspacePath = path.join(__dirname, 'perf-test-workspace');
    });

    suiteTeardown(() => {
        cleanupTestWorkspace(testWorkspacePath);
    });

    test('Should handle large number of files efficiently', async function() {
        this.timeout(10000); // 10 second timeout
        
        // Create a large test workspace
        const largeStructure = {};
        
        // Create 500 files across multiple directories
        for (let i = 0; i < 100; i++) {
            largeStructure[`src/Server/Module${i}.luau`] = `local Module${i} = {}\nreturn Module${i}`;
            largeStructure[`src/Client/Client${i}.luau`] = `local Client${i} = {}\nreturn Client${i}`;
            largeStructure[`src/Shared/Shared${i}.luau`] = `local Shared${i} = {}\nreturn Shared${i}`;
            largeStructure[`Packages/Package${i}.luau`] = `return {}`;
            largeStructure[`ServerPackages/ServerPackage${i}.luau`] = `return {}`;
        }
        
        // Add some directories to ignore
        for (let i = 0; i < 50; i++) {
            largeStructure[`_Private/Private${i}.luau`] = `return {}`;
            largeStructure[`node_modules/Module${i}.js`] = `module.exports = {}`;
        }
        
        createTestWorkspace(testWorkspacePath, largeStructure);
        
        // Mock VSCode environment
        const vscode = require('vscode');
        const originalConfig = vscode.workspace.getConfiguration;
        const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
        
        vscode.workspace.getConfiguration = mockVSCodeConfiguration({
            directoriesToScan: ['src/Server', 'src/Client', 'src/Shared', 'Packages', 'ServerPackages'],
            ignoreDirectories: ['^_.*', 'node_modules'],
            supportedExtensions: ['.lua', '.luau']
        });
        
        Object.defineProperty(vscode.workspace, 'workspaceFolders', {
            value: createMockWorkspace(testWorkspacePath),
            writable: true,
            configurable: true
        });
        
        try {
            const startTime = Date.now();
            generateFileAliases();
            const endTime = Date.now();
            
            const executionTime = endTime - startTime;
            console.log(`Processed 500 files in ${executionTime}ms`);
            
            // Should complete within 5 seconds for 500 files
            assert.ok(executionTime < 5000, `Performance test failed: took ${executionTime}ms, expected < 5000ms`);
            
            // Verify aliases were generated
            const luaurcPath = path.join(testWorkspacePath, '.luaurc');
            assert.ok(fs.existsSync(luaurcPath), '.luaurc should be created');
            
            const luaurcContent = JSON.parse(fs.readFileSync(luaurcPath, 'utf8'));
            const aliasCount = Object.keys(luaurcContent.aliases || {}).length;
            
            // Should have generated aliases for non-ignored files
            assert.ok(aliasCount > 300, `Should generate substantial number of aliases, got ${aliasCount}`);
            
            // Should not include ignored files
            const aliasNames = Object.keys(luaurcContent.aliases || {});
            const hasPrivateFiles = aliasNames.some(name => name.includes('Private'));
            assert.ok(!hasPrivateFiles, 'Should not include files from ignored directories');
            
        } finally {
            vscode.workspace.getConfiguration = originalConfig;
            Object.defineProperty(vscode.workspace, 'workspaceFolders', {
                value: originalWorkspaceFolders,
                writable: true,
                configurable: true
            });
        }
    });
    
    test('Should handle deep directory structures efficiently', async function() {
        this.timeout(5000);
        
        // Create deep nested structure
        const deepStructure = {};
        let currentPath = 'src';
        
        // Create 20 levels deep
        for (let depth = 0; depth < 20; depth++) {
            currentPath += `/Level${depth}`;
            deepStructure[`${currentPath}/Module${depth}.luau`] = `return {}`;
            deepStructure[`${currentPath}/init.luau`] = `return require("Module${depth}")`;
        }
        
        createTestWorkspace(testWorkspacePath, deepStructure);
        
        const vscode = require('vscode');
        const originalConfig = vscode.workspace.getConfiguration;
        const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
        
        vscode.workspace.getConfiguration = mockVSCodeConfiguration({
            directoriesToScan: ['src'],
            ignoreDirectories: [],
            supportedExtensions: ['.lua', '.luau']
        });
        
        Object.defineProperty(vscode.workspace, 'workspaceFolders', {
            value: createMockWorkspace(testWorkspacePath),
            writable: true,
            configurable: true
        });
        
        try {
            const startTime = Date.now();
            generateFileAliases();
            const endTime = Date.now();
            
            const executionTime = endTime - startTime;
            console.log(`Processed deep structure in ${executionTime}ms`);
            
            // Should complete within 2 seconds for deep structure  
            assert.ok(executionTime < 2000, `Deep structure test failed: took ${executionTime}ms`);
            
        } finally {
            vscode.workspace.getConfiguration = originalConfig;
            Object.defineProperty(vscode.workspace, 'workspaceFolders', {
                value: originalWorkspaceFolders,
                writable: true,
                configurable: true
            });
        }
    });
});
