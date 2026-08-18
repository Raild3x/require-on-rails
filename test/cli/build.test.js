// Headless tests for Build conversion (runBuild). The instance-expression expectations mirror
// the darklua convert_require output shapes validated in docs/adr/0003 — same chains, so a
// user switching between the two engines sees equivalent code.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runBuild, convertFileText, clonedContainerOf } = require('../../src/features/buildProject');
const pathResolver = require('../../src/features/pathResolver');

const IMPORT_PATHS = ['game:GetService("ReplicatedStorage").src.Import'];

/** @type {string[]} */
const tempDirs = [];

/**
 * Materializes a fixture tree and returns its root.
 * @param {Object<string, string>} files - Relative path -> content
 */
function makeFixture(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ror-build-'));
    tempDirs.push(root);
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
    }
    return root;
}

const BASE_FILES = {
    '.luaurc': JSON.stringify({
        aliases: { MyModule: 'src/Shared/Stuff/MyModule', Shared: 'src/Shared' }
    }),
    'default.project.json': JSON.stringify({
        name: 'fixture',
        tree: {
            $className: 'DataModel',
            ReplicatedStorage: { Shared: { $path: 'src/Shared' } },
            ServerScriptService: { Server: { $path: 'src/Server' } },
            StarterPlayer: {
                $className: 'StarterPlayer',
                StarterPlayerScripts: { Client: { $path: 'src/Client' } }
            }
        }
    }),
    'src/Shared/Stuff/MyModule.luau': 'return { value = 42 }\n',
    'src/Shared/FolderMod/init.luau': 'local Helper = require("@self/Helper")\nreturn { helper = Helper }\n',
    'src/Shared/FolderMod/Helper.luau': 'return {}\n',
    'src/Server/Main.server.luau': [
        'local Import = require(game:GetService("ReplicatedStorage").src.Import)',
        'require = Import(script)',
        '',
        'local ViaBasename = require("@MyModule")',
        'local ViaAliasRoot = require("@Shared/Stuff/MyModule")',
        'print(ViaBasename, ViaAliasRoot)',
        ''
    ].join('\n'),
    'src/Client/Controller.client.luau': [
        'local Shared = require("@MyModule")',
        'local Sibling = require("./Helper2")',
        'print(Shared, Sibling)',
        ''
    ].join('\n'),
    'src/Client/Helper2.luau': 'return {}\n'
};

/**
 * @param {string} root
 * @param {object} [overrides]
 */
function build(root, overrides = {}) {
    return runBuild(root, {
        directoriesToScan: ['src/Server', 'src/Client', 'src/Shared'],
        ignoreDirectories: [],
        importModulePaths: IMPORT_PATHS,
        outputDirectory: 'dist',
        rojoProjectPath: 'default.project.json',
        sourcemapPath: 'sourcemap.json',
        ...overrides
    });
}

/**
 * @param {string} root
 * @param {string} rel
 */
function readOut(root, rel) {
    return fs.readFileSync(path.join(root, 'dist', rel), 'utf8');
}

suite('Build conversion: string style', () => {
    test('Converts alias requires to relative strings and strips the boilerplate', () => {
        const root = makeFixture(BASE_FILES);
        const result = build(root);

        assert.deepStrictEqual(result.findings, []);
        assert.strictEqual(result.written, true);

        const main = readOut(root, 'src/Server/Main.server.luau');
        assert.ok(main.includes('require("../Shared/Stuff/MyModule")'), main);
        assert.ok(!main.includes('@MyModule'), main);
        assert.ok(!main.includes('Import(script)'), 'boilerplate must be stripped');
    });

    test('Game-roots requires that cross out of a cloned container, keeps within-container relative', () => {
        const root = makeFixture(BASE_FILES);
        build(root);

        const controller = readOut(root, 'src/Client/Controller.client.luau');
        // src/Client mounts under StarterPlayerScripts: the clone runs elsewhere, so the
        // cross-container require must be game-rooted...
        assert.ok(controller.includes('require("@game/ReplicatedStorage/Shared/Stuff/MyModule")'), controller);
        // ...while siblings travel with the clone and stay relative.
        assert.ok(controller.includes('require("./Helper2")'), controller);
    });

    test('Preserves RFC init semantics (@self resolves to the folder child)', () => {
        const root = makeFixture(BASE_FILES);
        build(root);

        const init = readOut(root, 'src/Shared/FolderMod/init.luau');
        // From an init file, "./" is parent-relative per the Luau RFC, so the child renders
        // as ./FolderMod/Helper (resolving via the parent), not ./Helper.
        assert.ok(init.includes('require("./FolderMod/Helper")'), init);
    });
});

suite('Build conversion: instance-expression styles', () => {
    test('wait_for_child emits game-rooted WaitForChild chains (darklua-equivalent shape)', () => {
        const root = makeFixture(BASE_FILES);
        const result = build(root, { outputRequireStyle: 'wait_for_child' });

        assert.deepStrictEqual(result.findings, []);
        const main = readOut(root, 'src/Server/Main.server.luau');
        assert.ok(main.includes(
            'require(game:GetService("ReplicatedStorage"):WaitForChild("Shared"):WaitForChild("Stuff"):WaitForChild("MyModule"))'
        ), main);
    });

    test('property style emits dot chains', () => {
        const root = makeFixture(BASE_FILES);
        build(root, { outputRequireStyle: 'property' });

        const main = readOut(root, 'src/Server/Main.server.luau');
        assert.ok(main.includes('require(game:GetService("ReplicatedStorage").Shared.Stuff.MyModule)'), main);
    });

    test('within a cloned container the chain is script-relative, not game-rooted', () => {
        const root = makeFixture(BASE_FILES);
        build(root, { outputRequireStyle: 'wait_for_child' });

        const controller = readOut(root, 'src/Client/Controller.client.luau');
        assert.ok(controller.includes('require(script.Parent:WaitForChild("Helper2"))'), controller);
    });

    test('fails when no Rojo mapping exists to place instances', () => {
        const files = { ...BASE_FILES };
        delete files['default.project.json'];
        const root = makeFixture(files);
        const result = build(root, { outputRequireStyle: 'wait_for_child' });

        assert.strictEqual(result.written, false);
        assert.strictEqual(result.findings[0].code, 'no-rojo-mapping');
    });
});

suite('Build conversion: failure behavior', () => {
    test('An unresolvable require fails the build and writes nothing', () => {
        const root = makeFixture({
            ...BASE_FILES,
            'src/Server/Broken.luau': 'return require("@Nowhere/Thing")\n'
        });
        const result = build(root);

        assert.strictEqual(result.written, false);
        assert.ok(result.findings.some(f => f.code === 'unresolved-require'), JSON.stringify(result.findings));
        assert.ok(!fs.existsSync(path.join(root, 'dist')), 'no output may be written on a failed build');
    });

    test('A bare ambiguous name is a finding, never a guess', () => {
        const root = makeFixture({
            ...BASE_FILES,
            '.luaurc': JSON.stringify({ aliases: { Shared: 'src/Shared' } }),
            'src/Server/Dup.luau': 'return {}\n',
            'src/Shared/Dup.luau': 'return {}\n',
            'src/Server/User.luau': 'return require("@Dup")\n'
        });
        const result = build(root);

        assert.strictEqual(result.written, false);
        assert.ok(result.findings.some(f => f.code === 'ambiguous-require'), JSON.stringify(result.findings));
    });

    test('Finding positions are source positions, not post-strip positions', () => {
        const root = makeFixture({
            ...BASE_FILES,
            'src/Server/Late.luau': [
                'local Import = require(game:GetService("ReplicatedStorage").src.Import)',
                'require = Import(script)',
                '',
                'return require("@Nowhere/Thing")',
                ''
            ].join('\n')
        });
        const result = build(root);
        const finding = result.findings.find(f => f.file === 'src/Server/Late.luau');
        assert.ok(finding);
        assert.strictEqual(finding.line, 3);
    });
});

suite('Build conversion: helpers', () => {
    test('clonedContainerOf identifies the cloned roots', () => {
        assert.strictEqual(clonedContainerOf('StarterGui/Screen/Button'), 'StarterGui');
        assert.strictEqual(clonedContainerOf('StarterPlayer/StarterPlayerScripts/Client'), 'StarterPlayer/StarterPlayerScripts');
        assert.strictEqual(clonedContainerOf('StarterPlayer/Other'), null);
        assert.strictEqual(clonedContainerOf('ReplicatedStorage/Shared'), null);
        assert.strictEqual(clonedContainerOf(null), null);
    });

    test('convertFileText leaves unconvertible native forms untouched', () => {
        const root = makeFixture(BASE_FILES);
        const ctx = pathResolver.createContext(root, {
            directoriesToScan: ['src/Server', 'src/Client', 'src/Shared'],
            rojoProjectPath: 'default.project.json'
        });
        /** @type {any[]} */
        const findings = [];
        // @self from a non-init file has no filesystem counterpart; the string is already
        // native and must pass through unchanged.
        const result = convertFileText('return require("@self/Child")\n', 'src/Shared/Stuff/MyModule.luau', ctx, 'string', IMPORT_PATHS, findings);
        assert.ok(result.text.includes('require("@self/Child")'));
        assert.deepStrictEqual(findings, []);
    });
});

suiteTeardown(() => {
    for (const dir of tempDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    }
});
