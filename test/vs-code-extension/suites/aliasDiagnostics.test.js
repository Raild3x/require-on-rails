const assert = require('assert');
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

// Import extension modules for testing
const { generateFileAliases, resetAmbiguityNotificationState } = require('../../../src/features/updateLuaFileAliases');
const {
    findUnresolvedAliases,
    refreshAliasDiagnostics,
    setAmbiguousAliases,
    clearAliasDiagnostics
} = require('../../../src/features/aliasDiagnostics');

// Import shared test utilities
const {
    mockWorkspaceConfig,
    mockVSCodeMessages,
    createTestFiles,
    cleanupTestFiles,
    setupTestWorkspace
} = require('../utils/testUtils');

suite('Alias Diagnostics Tests', () => {
    vscode.window.showInformationMessage('Starting Alias Diagnostics tests...');

    let testWorkspaceUri;
    let testWorkspacePath;

    suiteSetup(async () => {
        testWorkspaceUri = vscode.Uri.file(path.join(__dirname, 'diagnostics-test-workspace'));
        testWorkspacePath = testWorkspaceUri.fsPath;

        if (!fs.existsSync(testWorkspacePath)) {
            fs.mkdirSync(testWorkspacePath, { recursive: true });
        }

        await setupTestWorkspace(testWorkspacePath);
    });

    suiteTeardown(async () => {
        clearAliasDiagnostics();
        if (fs.existsSync(testWorkspacePath)) {
            fs.rmSync(testWorkspacePath, { recursive: true, force: true });
        }
    });

    suite('Unresolved alias detection', () => {
        const known = new Set(['Config', 'Shared', 'Server']);

        test('Should flag an alias that is not defined', () => {
            const found = findUnresolvedAliases('local X = require("@Missing")', known);

            assert.strictEqual(found.length, 1, 'Should find one unresolved alias');
            assert.strictEqual(found[0].aliasName, 'Missing', 'Should extract the alias name');
            assert.strictEqual(found[0].line, 0, 'Should report the correct line');
        });

        test('Should not flag an alias that is defined', () => {
            const found = findUnresolvedAliases('local X = require("@Config")', known);
            assert.strictEqual(found.length, 0, 'Defined alias should not be reported');
        });

        test('Should only treat the first path segment as the alias', () => {
            const resolved = findUnresolvedAliases('local X = require("@Shared/Utils/Thing")', known);
            assert.strictEqual(resolved.length, 0, 'Subpath under a known alias should resolve');

            const unresolved = findUnresolvedAliases('local X = require("@Nope/Utils/Thing")', known);
            assert.strictEqual(unresolved.length, 1, 'Subpath under an unknown alias should be flagged');
            assert.strictEqual(unresolved[0].aliasName, 'Nope', 'Should flag only the first segment');
        });

        test('Should ignore non-aliased requires so Roblox fallback paths are not flagged', () => {
            const text = [
                'local A = require(script.Parent.Thing)',
                'local B = require("NotAnAlias")',
                'local C = require(ReplicatedStorage.src.Import)'
            ].join('\n');

            assert.strictEqual(findUnresolvedAliases(text, known).length, 0,
                'Only @-prefixed requires are alias requires');
        });

        test('Should ignore commented-out requires', () => {
            const text = [
                '-- local X = require("@Missing")',
                '    -- require("@AlsoMissing")'
            ].join('\n');

            assert.strictEqual(findUnresolvedAliases(text, known).length, 0,
                'Commented lines should not produce diagnostics');
        });

        test('Should ignore the reserved @self alias', () => {
            const found = findUnresolvedAliases('local X = require("@self/Sibling")', known);
            assert.strictEqual(found.length, 0, '@self is resolved by Luau, not by .luaurc');
        });

        test('Should handle single quotes and multiple requires on one line', () => {
            const found = findUnresolvedAliases(`require('@GoneA') require("@GoneB")`, known);

            assert.strictEqual(found.length, 2, 'Should find both unresolved aliases');
            assert.deepStrictEqual(found.map(f => f.aliasName), ['GoneA', 'GoneB'],
                'Should report both in order');
        });

        test('Should point the range at the alias string, not the whole require call', () => {
            const line = 'local X = require("@Missing")';
            const found = findUnresolvedAliases(line, known);

            assert.strictEqual(
                line.slice(found[0].startColumn, found[0].endColumn),
                '@Missing',
                'Range should cover exactly the alias text'
            );
        });

        test('Should accept @-prefixed keys from .luaurc as defined', () => {
            // .luaurc keys are normalized by readAliasNames; this mirrors that both forms work.
            const found = findUnresolvedAliases('require("@Server")', new Set(['Server']));
            assert.strictEqual(found.length, 0, 'Bare key should satisfy an @-prefixed require');
        });
    });

    suite('Workspace-wide reporting', () => {
        test('Should report unresolved requires across unopened files', () => {
            createTestFiles(testWorkspacePath, {
                'src/Server/UsesMissing.luau': 'local X = require("@DefinitelyMissing")\nreturn X'
            });

            const restore = mockWorkspaceConfig(testWorkspaceUri, {
                directoriesToScan: ['src/Server'],
                manualAliases: {}
            });
            const messages = mockVSCodeMessages();

            try {
                generateFileAliases();
                setAmbiguousAliases({});
                const result = refreshAliasDiagnostics();

                assert.ok(result, 'Should return a summary');
                assert.strictEqual(result.totalUnresolved, 1, 'Should find the one broken require');
                assert.strictEqual(result.filesWithIssues, 1, 'Should attribute it to one file');
            } finally {
                messages.restore();
                restore();
                clearAliasDiagnostics();
                cleanupTestFiles(testWorkspacePath, ['src/Server/UsesMissing.luau']);
            }
        });

        test('Should not report requires that the generated aliases satisfy', () => {
            createTestFiles(testWorkspacePath, {
                'src/Server/Target.luau': 'return {}',
                'src/Server/UsesTarget.luau': 'local X = require("@Target")\nreturn X'
            });

            const restore = mockWorkspaceConfig(testWorkspaceUri, {
                directoriesToScan: ['src/Server'],
                manualAliases: {}
            });
            const messages = mockVSCodeMessages();

            try {
                generateFileAliases();
                setAmbiguousAliases({});
                const result = refreshAliasDiagnostics();

                assert.strictEqual(result.totalUnresolved, 0,
                    'A require matching a generated alias should be clean');
            } finally {
                messages.restore();
                restore();
                clearAliasDiagnostics();
                cleanupTestFiles(testWorkspacePath, ['src/Server/Target.luau', 'src/Server/UsesTarget.luau']);
            }
        });

        // The whole point of tying the two features together: an ambiguous name produces no
        // alias, so its requires must surface as diagnostics rather than failing silently.
        test('Should report requires of an ambiguous alias', () => {
            createTestFiles(testWorkspacePath, {
                'src/Server/Dupe.luau': 'return {}',
                'src/Client/Dupe.luau': 'return {}',
                'src/Server/UsesDupe.luau': 'local X = require("@Dupe")\nreturn X'
            });

            const restore = mockWorkspaceConfig(testWorkspaceUri, {
                directoriesToScan: ['src/Server', 'src/Client'],
                pathPriority: [],
                manualAliases: {}
            });
            const messages = mockVSCodeMessages();

            try {
                resetAmbiguityNotificationState();
                const generation = generateFileAliases();

                assert.ok(generation.ambiguousAliases.Dupe,
                    'Generation should report Dupe as ambiguous');
                assert.strictEqual(generation.ambiguousAliases.Dupe.length, 2,
                    'Should list both conflicting paths');
                assert.ok(!generation.aliases.Dupe, 'No alias should be written for an ambiguous name');

                assert.ok(
                    messages.captured.warning.some(msg => msg.includes('ambiguous')),
                    'User should get an acknowledgeable warning notification about the ambiguity'
                );

                setAmbiguousAliases(generation.ambiguousAliases);
                const result = refreshAliasDiagnostics();

                assert.strictEqual(result.totalUnresolved, 1,
                    'The require of the ambiguous name should be flagged');
            } finally {
                messages.restore();
                restore();
                clearAliasDiagnostics();
                cleanupTestFiles(testWorkspacePath, [
                    'src/Server/Dupe.luau', 'src/Client/Dupe.luau', 'src/Server/UsesDupe.luau'
                ]);
            }
        });

        test('Should not report files inside ignored directories', () => {
            createTestFiles(testWorkspacePath, {
                'src/Server/_Private/UsesMissing.luau': 'local X = require("@AlsoMissing")\nreturn X'
            });

            const restore = mockWorkspaceConfig(testWorkspaceUri, {
                directoriesToScan: ['src/Server'],
                ignoreDirectories: ['^_.*'],
                manualAliases: {}
            });
            const messages = mockVSCodeMessages();

            try {
                generateFileAliases();
                setAmbiguousAliases({});
                const result = refreshAliasDiagnostics();

                assert.strictEqual(result.totalUnresolved, 0,
                    'Ignored directories are excluded from diagnostics, matching alias generation');
            } finally {
                messages.restore();
                restore();
                clearAliasDiagnostics();
                cleanupTestFiles(testWorkspacePath, ['src/Server/_Private']);
            }
        });
    });

    suite('Ambiguity notification throttling', () => {
        // The "already announced" state is module-level and deliberately survives regenerations,
        // so each test starts from a known point rather than inheriting the previous one's.
        setup(() => {
            resetAmbiguityNotificationState();
        });

        test('Should warn once per distinct ambiguous set, not once per regeneration', () => {
            createTestFiles(testWorkspacePath, {
                'src/Server/Twin.luau': 'return {}',
                'src/Client/Twin.luau': 'return {}'
            });

            const restore = mockWorkspaceConfig(testWorkspaceUri, {
                directoriesToScan: ['src/Server', 'src/Client'],
                pathPriority: [],
                manualAliases: {}
            });
            const messages = mockVSCodeMessages();

            try {
                // Alias generation runs on every file change, so an unchanged ambiguity must
                // not re-notify or it would spam continuously while the user works.
                generateFileAliases();
                generateFileAliases();
                generateFileAliases();

                const ambiguityWarnings = messages.captured.warning.filter(msg => msg.includes('ambiguous'));
                assert.strictEqual(ambiguityWarnings.length, 1,
                    'Repeat regenerations with the same ambiguity should notify only once');
            } finally {
                messages.restore();
                restore();
                clearAliasDiagnostics();
                cleanupTestFiles(testWorkspacePath, ['src/Server/Twin.luau', 'src/Client/Twin.luau']);
            }
        });

        test('Should warn again when a new ambiguity appears', () => {
            createTestFiles(testWorkspacePath, {
                'src/Server/First.luau': 'return {}',
                'src/Client/First.luau': 'return {}'
            });

            const restore = mockWorkspaceConfig(testWorkspaceUri, {
                directoriesToScan: ['src/Server', 'src/Client'],
                pathPriority: [],
                manualAliases: {}
            });
            const messages = mockVSCodeMessages();

            try {
                generateFileAliases();

                createTestFiles(testWorkspacePath, {
                    'src/Server/Second.luau': 'return {}',
                    'src/Client/Second.luau': 'return {}'
                });
                generateFileAliases();

                const ambiguityWarnings = messages.captured.warning.filter(msg => msg.includes('ambiguous'));
                assert.strictEqual(ambiguityWarnings.length, 2,
                    'A newly introduced ambiguity should produce a fresh notification');
            } finally {
                messages.restore();
                restore();
                clearAliasDiagnostics();
                cleanupTestFiles(testWorkspacePath, [
                    'src/Server/First.luau', 'src/Client/First.luau',
                    'src/Server/Second.luau', 'src/Client/Second.luau'
                ]);
            }
        });
    });
});
