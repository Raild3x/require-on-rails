const assert = require('assert');
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const pathResolver = require('../../../src/features/pathResolver');
const { computeReplacement } = require('../../../src/features/explicitMode');

const { mockWorkspaceConfig, createTestFiles } = require('../utils/testUtils');

suite('Explicit Mode Tests', () => {
    let testWorkspaceUri;
    let testWorkspacePath;
    let restoreConfig;
    let ctx;

    const ROJO_PROJECT = {
        name: 'Test',
        tree: {
            $className: 'DataModel',
            ReplicatedStorage: {
                $className: 'ReplicatedStorage',
                src: {
                    $className: 'Folder',
                    Shared: { $className: 'Folder', $path: 'src/Shared' },
                    Client: { $className: 'Folder', $path: 'src/Client' },
                    Import: { $path: 'src/Import.luau' }
                }
            },
            ServerScriptService: {
                $className: 'ServerScriptService',
                src: {
                    $className: 'Folder',
                    Server: { $className: 'Folder', $path: 'src/Server' }
                }
            }
        }
    };

    suiteSetup(async () => {
        testWorkspacePath = path.join(__dirname, 'explicit-mode-test-workspace');
        testWorkspaceUri = vscode.Uri.file(testWorkspacePath);
        fs.mkdirSync(testWorkspacePath, { recursive: true });

        createTestFiles(testWorkspacePath, {
            'src/Shared/Stuff/myModule.luau': 'return {}',
            'src/Client/Utils/myModule.luau': 'return {}',
            'src/Client/UI/Menu.luau': 'return {}',
            'src/Client/UI/helper.luau': 'return {}',
            'src/Client/Other/thing.luau': 'return {}',
            'src/Shared/Data/init.luau': 'return {}',
            'src/Shared/Data/Config.luau': 'return {}',
            'src/Server/Systems/thing.luau': 'return {}',
            'src/Import.luau': 'return {}',
            '.luaurc': JSON.stringify({
                aliases: { Server: 'src/Server', Client: 'src/Client', Shared: 'src/Shared' }
            }),
            'default.project.json': JSON.stringify(ROJO_PROJECT)
        });

        restoreConfig = mockWorkspaceConfig(testWorkspaceUri, {
            directoriesToScan: ['src/Server', 'src/Client', 'src/Shared'],
            ignoreDirectories: ['^_.*'],
            pathPriority: [],
            mode: 'explicit',
            explicitPathStyle: 'alias',
            preferRelativePaths: false,
            rojoProjectPath: 'default.project.json'
        });

        ctx = pathResolver.refreshContext();
    });

    suiteTeardown(() => {
        pathResolver.invalidateContext();
        if (restoreConfig) restoreConfig();
        if (fs.existsSync(testWorkspacePath)) {
            fs.rmSync(testWorkspacePath, { recursive: true, force: true });
        }
    });

    const MENU = 'src/Client/UI/Menu.luau';

    suite('Context', () => {
        test('Module index contains scanned modules and folder-init collapses', () => {
            assert.ok(ctx, 'Context should build');
            assert.deepStrictEqual(ctx.targets['Menu'], ['src/Client/UI/Menu.luau']);
            assert.strictEqual(ctx.targets['myModule'].length, 2, 'Duplicate basenames are allowed in explicit mode');
            assert.deepStrictEqual(ctx.targets['Data'], ['src/Shared/Data/init.luau'], 'Folder with init file is indexed under the folder name');
            assert.strictEqual(ctx.targets['init'], undefined, 'init is never indexed under its own name');
        });

        test('Aliases come from .luaurc', () => {
            assert.strictEqual(ctx.aliases['Shared'], 'src/Shared');
            assert.strictEqual(ctx.aliases['Client'], 'src/Client');
        });

        test('Rojo project parses dir and file $path nodes', () => {
            const byFs = Object.fromEntries(ctx.rojoMap.map(entry => [entry.fsPath, entry.dmPath]));
            assert.strictEqual(byFs['src/Shared'], 'ReplicatedStorage/src/Shared', 'Directory node');
            assert.strictEqual(byFs['src/Import'], 'ReplicatedStorage/src/Import', 'File node, extension stripped');
            assert.strictEqual(byFs['src/Server'], 'ServerScriptService/src/Server');
        });
    });

    suite('Resolution', () => {
        test('Alias-rooted path resolves to the target file', () => {
            const result = pathResolver.resolveRequire('@Shared/Stuff/myModule', MENU, ctx);
            assert.strictEqual(result.status, 'resolved');
            assert.strictEqual(result.target, 'src/Shared/Stuff/myModule.luau');
        });

        test('Relative path resolves against the requiring file', () => {
            const result = pathResolver.resolveRequire('../Utils/myModule', MENU, ctx);
            assert.strictEqual(result.status, 'resolved');
            assert.strictEqual(result.target, 'src/Client/Utils/myModule.luau');
        });

        test('@game path resolves through the Rojo mapping', () => {
            const result = pathResolver.resolveRequire('@game/ReplicatedStorage/src/Shared/Stuff/myModule', MENU, ctx);
            assert.strictEqual(result.status, 'resolved');
            assert.strictEqual(result.target, 'src/Shared/Stuff/myModule.luau');
        });

        test('Alias path to a folder module resolves to its init file', () => {
            const result = pathResolver.resolveRequire('@Shared/Data', MENU, ctx);
            assert.strictEqual(result.status, 'resolved');
            assert.strictEqual(result.target, 'src/Shared/Data/init.luau');
        });

        test('Unknown alias root is unresolved', () => {
            const result = pathResolver.resolveRequire('@Nope/Thing', MENU, ctx);
            assert.strictEqual(result.status, 'unresolved');
            assert.strictEqual(result.reason, 'unknown-alias');
        });

        test('Path to a missing file is unresolved', () => {
            const result = pathResolver.resolveRequire('@Shared/Stuff/missing', MENU, ctx);
            assert.strictEqual(result.status, 'unresolved');
            assert.strictEqual(result.reason, 'file-not-found');
        });

        test('@self from a non-init file is unverifiable, from an init file it resolves', () => {
            assert.strictEqual(pathResolver.resolveRequire('@self/Anything', MENU, ctx).status, 'unverifiable');

            const fromInit = pathResolver.resolveRequire('@self/Config', 'src/Shared/Data/init.luau', ctx);
            assert.strictEqual(fromInit.status, 'resolved');
            assert.strictEqual(fromInit.target, 'src/Shared/Data/Config.luau');
        });
    });

    suite('Rendering', () => {
        test('Alias style uses the longest matching alias prefix', () => {
            const rendered = pathResolver.renderRequire('src/Shared/Stuff/myModule.luau', MENU, 'alias', false, ctx);
            assert.strictEqual(rendered, '@Shared/Stuff/myModule');
        });

        test('Relative style renders ../ and ./ forms', () => {
            assert.strictEqual(
                pathResolver.renderRequire('src/Client/Utils/myModule.luau', MENU, 'relative', false, ctx),
                '../Utils/myModule'
            );
            assert.strictEqual(
                pathResolver.renderRequire('src/Client/UI/helper.luau', MENU, 'relative', false, ctx),
                './helper'
            );
        });

        test('Game style renders the DataModel path', () => {
            assert.strictEqual(
                pathResolver.renderRequire('src/Shared/Stuff/myModule.luau', MENU, 'game', false, ctx),
                '@game/ReplicatedStorage/src/Shared/Stuff/myModule'
            );
        });

        test('Folder-init target renders as the folder in every style', () => {
            const target = 'src/Shared/Data/init.luau';
            assert.strictEqual(pathResolver.renderRequire(target, MENU, 'alias', false, ctx), '@Shared/Data');
            assert.strictEqual(pathResolver.renderRequire(target, 'src/Shared/Data/Config.luau', 'relative', false, ctx), '../Data',
                'A child of the folder requires the folder module via its parent');
            assert.strictEqual(pathResolver.renderRequire(target, MENU, 'game', false, ctx), '@game/ReplicatedStorage/src/Shared/Data');
        });

        test('preferRelativePaths substitutes only a strictly shorter relative form', () => {
            // './helper' (2 segments) beats '@Client/UI/helper' (3 segments)
            assert.strictEqual(
                pathResolver.renderRequire('src/Client/UI/helper.luau', MENU, 'alias', true, ctx),
                './helper'
            );
            // '../Other/thing' (3 segments) does NOT beat '@Client/Other/thing' (3 segments)
            assert.strictEqual(
                pathResolver.renderRequire('src/Client/Other/thing.luau', MENU, 'alias', true, ctx),
                '@Client/Other/thing'
            );
        });

        test('Round-trips: rendered paths resolve back to the same target', () => {
            const targets = ['src/Shared/Stuff/myModule.luau', 'src/Shared/Data/init.luau', 'src/Client/Utils/myModule.luau'];
            for (const target of targets) {
                for (const style of ['alias', 'relative', 'game']) {
                    const rendered = pathResolver.renderRequire(target, MENU, style, false, ctx);
                    const resolved = pathResolver.resolveRequire(rendered, MENU, ctx);
                    assert.strictEqual(resolved.status, 'resolved', `${style} round-trip of ${target} via "${rendered}"`);
                    assert.strictEqual(resolved.target, target, `${style} round-trip of ${target} via "${rendered}"`);
                }
            }
        });
    });

    suite('Ranking', () => {
        test('Closest candidate by tree distance wins', () => {
            const ranked = pathResolver.rankByDistance(ctx.targets['myModule'], MENU, []);
            assert.strictEqual(ranked[0], 'src/Client/Utils/myModule.luau', 'Same-branch module is closer than the Shared one');
        });

        test('pathPriority breaks distance ties', () => {
            const candidates = ['src/Shared/Stuff/myModule.luau', 'src/Client/Utils/myModule.luau'];
            const fromServer = 'src/Server/Systems/thing.luau'; // equidistant from both
            const preferShared = pathResolver.rankByDistance(candidates, fromServer, ['src/Shared']);
            assert.strictEqual(preferShared[0], 'src/Shared/Stuff/myModule.luau');

            const alphabetical = pathResolver.rankByDistance(candidates, fromServer, []);
            assert.strictEqual(alphabetical[0], 'src/Client/Utils/myModule.luau', 'No priority: alphabetical for determinism');
        });
    });

    suite('Auto-replace eligibility', () => {
        test('Bare @name matching a known module renders the closest candidate', () => {
            assert.strictEqual(computeReplacement('@myModule', MENU, ctx), '@Client/Utils/myModule');
        });

        test('Existing alias roots, reserved names, paths, and unknown names are untouched', () => {
            assert.strictEqual(computeReplacement('@Shared', MENU, ctx), null, 'Alias root wins over rewriting');
            assert.strictEqual(computeReplacement('@self', MENU, ctx), null, 'Reserved');
            assert.strictEqual(computeReplacement('@Shared/Stuff/myModule', MENU, ctx), null, 'Already a path');
            assert.strictEqual(computeReplacement('@DoesNotExist', MENU, ctx), null, 'Unknown name');
            assert.strictEqual(computeReplacement('./helper', MENU, ctx), null, 'Relative specs are not short names');
        });
    });

    suite('Require string scanning', () => {
        test('Finds alias and relative require strings with positions, skipping comments', () => {
            const text = [
                'local A = require("@Shared/Stuff/myModule")',
                "local B = require('../Utils/myModule')",
                '-- local C = require("@Commented")',
                'local D = require(script.Parent.Thing)'
            ].join('\n');

            const found = pathResolver.findRequireStrings(text);
            assert.deepStrictEqual(found.map(f => f.spec), ['@Shared/Stuff/myModule', '../Utils/myModule']);
            assert.strictEqual(found[1].line, 1);
            assert.strictEqual(
                text.split('\n')[1].slice(found[1].startColumn, found[1].endColumn),
                '../Utils/myModule',
                'Range covers exactly the require string'
            );
        });
    });

    suite('baseDir semantics', () => {
        test('Init files resolve relative requires from their folder\'s parent', () => {
            assert.strictEqual(pathResolver.baseDir('src/Shared/Data/init.luau'), 'src/Shared');
            assert.strictEqual(pathResolver.baseDir('src/Shared/Data/Config.luau'), 'src/Shared/Data');
        });
    });
});
