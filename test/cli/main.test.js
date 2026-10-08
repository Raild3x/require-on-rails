// Headless tests for the requireonrails command. Each verb runs on a throwaway project, the
// way a script or another editor would drive it.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { run } = require('../../src/cli/main');

const REPO_ROOT = path.join(__dirname, '..', '..');

/** @type {string[]} */
const tempDirs = [];

/**
 * @param {Object<string, string>} files - Relative path -> content
 * @returns {string} Fixture root
 */
function makeFixture(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ror-cli-'));
    tempDirs.push(root);
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), content, 'utf8');
    }
    return root;
}

/**
 * @param {string} root
 * @param {string} rel
 */
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// No shipped default manualAliases, so a fixture's alias set is exactly its own files.
/** @param {Record<string, unknown>} values */
const projectFile = values => JSON.stringify({ directoriesToScan: ['src'], manualAliases: {}, ...values });

/**
 * @param {string} root
 * @param {...string} args
 */
async function runJson(root, ...args) {
    const { code, output } = await run([...args, '-C', root, '--json']);
    return { code, result: JSON.parse(output) };
}

suite('CLI command: usage', () => {
    test('No command is a usage error; --help is not', async () => {
        assert.strictEqual((await run([])).code, 2);
        assert.strictEqual((await run(['--help'])).code, 0);
        assert.strictEqual((await run(['frob'])).code, 2);
    });

    test('--json keeps stdout parseable even though the scan logs progress', () => {
        const result = spawnSync(process.execPath,
            [path.join('src', 'cli', 'main.js'), 'check', '-C', path.join('test', 'ci-fixture'), '--json'],
            { cwd: REPO_ROOT, encoding: 'utf8' });
        assert.strictEqual(result.status, 1, 'the fixture has findings');
        assert.ok(Array.isArray(JSON.parse(result.stdout).findings));
        assert.ok(result.stderr.includes('Scanning directory'), 'progress goes to stderr');
    });

    test('A settings file with errors stops every command', async () => {
        const root = makeFixture({ 'requireonrails.json': '{ "mode": "sideways" }', 'src/A.luau': 'return {}\n' });
        for (const verb of ['build', 'generate-aliases', 'rewrite']) {
            const { code, result } = await runJson(root, verb);
            assert.strictEqual(code, 1, verb);
            assert.ok(result.findings.length > 0, verb);
        }
    });
});

suite('CLI command: generate-aliases (dynamic mode)', () => {
    test('Writes the generated set, keeping other .luaurc keys; a dry run writes nothing', async () => {
        const root = makeFixture({
            'requireonrails.json': projectFile({ mode: 'dynamic' }),
            '.luaurc': '{ // kept\n "languageMode": "strict", }',
            'src/A/Util.luau': 'return {}\n',
            'src/A/Twin.luau': 'return {}\n',
            'src/B/Twin.luau': 'return {}\n'
        });
        const dry = await runJson(root, 'generate-aliases', '--dry-run');
        assert.strictEqual(dry.result.written, false);
        assert.ok(read(root, '.luaurc').includes('// kept'), 'dry run leaves the file alone');

        const { code, result } = await runJson(root, 'generate-aliases');
        assert.strictEqual(code, 0);
        assert.deepStrictEqual(result.aliases, { Util: 'src/A/Util.luau' });
        assert.deepStrictEqual(Object.keys(result.ambiguousAliases), ['Twin']);
        assert.deepStrictEqual(JSON.parse(read(root, '.luaurc')), { aliases: { Util: 'src/A/Util.luau' }, languageMode: 'strict' });
        assert.strictEqual((await runJson(root, 'generate-aliases')).result.changed, false, 'a second run is a no-op');
    });

    test('Explicit mode refuses, since .luaurc is the user\'s', async () => {
        const root = makeFixture({ 'requireonrails.json': projectFile({ mode: 'explicit' }) });
        assert.strictEqual((await runJson(root, 'generate-aliases')).code, 1);
    });
});

suite('CLI command: rewrite (explicit mode)', () => {
    test('Rewrites short names to the configured style, and reports what it cannot resolve', async () => {
        const root = makeFixture({
            'requireonrails.json': projectFile({ mode: 'explicit', explicitPathStyle: 'relative' }),
            'src/Shared/Util.luau': 'return {}\n',
            'src/Server/Main.luau': 'local U = require("@Util")\nlocal G = require("./Ghost")\n'
        });
        const dry = await runJson(root, 'rewrite', '--dry-run');
        assert.deepStrictEqual(dry.result.edits.map((/** @type {any} */ e) => e.newText), ['../Shared/Util']);
        assert.strictEqual(dry.result.findings.length, 1);
        assert.ok(read(root, 'src/Server/Main.luau').includes('"@Util"'), 'dry run writes nothing');

        assert.strictEqual((await runJson(root, 'rewrite')).code, 0);
        assert.strictEqual(read(root, 'src/Server/Main.luau'), 'local U = require("../Shared/Util")\nlocal G = require("./Ghost")\n');
    });
});

suite('CLI command: rename', () => {
    test('Explicit mode moves the file and fixes requires in both directions', async () => {
        const root = makeFixture({
            'requireonrails.json': projectFile({ mode: 'explicit', explicitPathStyle: 'relative' }),
            'src/Shared/Util.luau': 'local S = require("./Sibling")\nreturn {}\n',
            'src/Shared/Sibling.luau': 'return {}\n',
            'src/Server/Main.luau': 'local U = require("../Shared/Util")\n'
        });
        const { code, result } = await runJson(root, 'rename', path.join(root, 'src/Shared/Util.luau'), path.join(root, 'src/Shared/Lib/Util.luau'));
        assert.strictEqual(code, 0);
        assert.deepStrictEqual(result.moved, { from: 'src/Shared/Util.luau', to: 'src/Shared/Lib/Util.luau' });
        assert.strictEqual(read(root, 'src/Shared/Lib/Util.luau'), 'local S = require("../Sibling")\nreturn {}\n');
        assert.strictEqual(read(root, 'src/Server/Main.luau'), 'local U = require("../Shared/Lib/Util")\n');
    });

    test('--skip-inbound leaves requires elsewhere alone', async () => {
        const root = makeFixture({
            'requireonrails.json': projectFile({ mode: 'explicit', explicitPathStyle: 'relative' }),
            'src/Shared/Util.luau': 'return {}\n',
            'src/Server/Main.luau': 'local U = require("../Shared/Util")\n'
        });
        await runJson(root, 'rename', path.join(root, 'src/Shared/Util.luau'), path.join(root, 'src/Shared/Lib/Util.luau'), '--skip-inbound');
        assert.strictEqual(read(root, 'src/Server/Main.luau'), 'local U = require("../Shared/Util")\n');
    });

    test('Dynamic mode applies the enabled updates and regenerates .luaurc', async () => {
        const root = makeFixture({
            'requireonrails.json': projectFile({ mode: 'dynamic' }),
            'src/Server/OldName.luau': 'return {}\n',
            'src/Server/Main.luau': 'local X = require("@OldName")\n'
        });
        await runJson(root, 'generate-aliases');
        const { code, result } = await runJson(root, 'rename', path.join(root, 'src/Server/OldName.luau'), path.join(root, 'src/Server/NewName.luau'));
        assert.strictEqual(code, 0);
        assert.deepStrictEqual(result.filesWritten, ['src/Server/Main.luau']);
        assert.strictEqual(read(root, 'src/Server/Main.luau'), 'local X = require("@NewName")\n');
        assert.deepStrictEqual(Object.keys(JSON.parse(read(root, '.luaurc')).aliases).sort(), ['Main', 'NewName']);
    });

    test('Refuses to overwrite, to move what is not there, or to move a folder into itself', async () => {
        const root = makeFixture({ 'requireonrails.json': projectFile({}), 'src/A.luau': '', 'src/B.luau': '' });
        assert.strictEqual((await runJson(root, 'rename', 'src/A.luau', 'src/B.luau')).code, 2);
        assert.strictEqual((await runJson(root, 'rename', 'src/Nope.luau', 'src/C.luau')).code, 2);
        assert.strictEqual((await runJson(root, 'rename', 'src', 'src/Inner')).code, 2);
        assert.strictEqual((await runJson(root, 'rename', '.', 'elsewhere')).code, 2);
        assert.ok(fs.existsSync(path.join(root, 'src/A.luau')));
        assert.ok(!fs.existsSync(path.join(root, 'src/Inner')), 'nothing created on refusal');
    });

    test('Paths are relative to -C, not to where the command runs', async () => {
        const root = makeFixture({ 'requireonrails.json': projectFile({ mode: 'dynamic' }), 'src/A.luau': 'return {}\n' });
        assert.strictEqual((await runJson(root, 'rename', 'src/A.luau', 'src/B.luau')).code, 0);
        assert.ok(fs.existsSync(path.join(root, 'src/B.luau')));
    });

    test('Dynamic mode leaves requires alone when the moved file is not a module', async () => {
        const root = makeFixture({
            'requireonrails.json': projectFile({ mode: 'dynamic' }),
            'docs/Util.md': '# notes',
            'src/Util.luau': 'return {}\n',
            'src/Main.luau': 'local U = require("@Util")\n'
        });
        const { result } = await runJson(root, 'rename', 'docs/Util.md', 'docs/Helpers.md');
        assert.deepStrictEqual(result.filesWritten, []);
        assert.strictEqual(read(root, 'src/Main.luau'), 'local U = require("@Util")\n');
    });

    test('Dynamic mode leaves @Old alone while another module still owns the name', async () => {
        const root = makeFixture({
            'requireonrails.json': projectFile({ mode: 'dynamic' }),
            'src/A/Util.luau': 'return {}\n',
            'src/Util/Inner.luau': 'return {}\n',
            'docs/Util.luau': 'return {}\n',
            'src/Main.luau': 'local U = require("@Util")\n'
        });
        // A plain folder has no alias, and a file arriving from outside the scan never owned @Util.
        await runJson(root, 'rename', 'src/Util', 'src/Stuff');
        await runJson(root, 'rename', 'docs/Util.luau', 'src/A/Fresh.luau');
        assert.strictEqual(read(root, 'src/Main.luau'), 'local U = require("@Util")\n');
        assert.ok(fs.existsSync(path.join(root, 'src/Stuff/Inner.luau')));
    });

    test('A link is refused rather than moving what it points at', async () => {
        const root = makeFixture({ 'requireonrails.json': projectFile({}), 'src/Plain/A.luau': 'return {}\n' });
        fs.symlinkSync(path.join(root, 'src/Plain'), path.join(root, 'src/Link'), 'junction');
        assert.strictEqual((await runJson(root, 'rename', 'src/Link', 'src/Moved')).code, 2);
        assert.ok(fs.existsSync(path.join(root, 'src/Plain/A.luau')));
    });

    test('Dynamic mode checks .luaurc before moving anything', async () => {
        const root = makeFixture({
            'requireonrails.json': projectFile({ mode: 'dynamic' }),
            '.luaurc': '{ "aliases": ',
            'src/A.luau': 'return {}\n'
        });
        assert.strictEqual((await runJson(root, 'rename', 'src/A.luau', 'src/B.luau')).code, 1);
        assert.ok(fs.existsSync(path.join(root, 'src/A.luau')), 'not moved');
    });

    test('A case-only rename is allowed, and renames the alias', async () => {
        const root = makeFixture({
            'requireonrails.json': projectFile({ mode: 'dynamic' }),
            'src/Util.luau': 'return {}\n',
            'src/Main.luau': 'local U = require("@Util")\n'
        });
        assert.strictEqual((await runJson(root, 'rename', 'src/Util.luau', 'src/UTIL.luau')).code, 0);
        assert.deepStrictEqual(fs.readdirSync(path.join(root, 'src')).sort(), ['Main.luau', 'UTIL.luau']);
        assert.strictEqual(read(root, 'src/Main.luau'), 'local U = require("@UTIL")\n');
    });

    if (process.platform === 'win32' || process.platform === 'darwin') {
        test('A wrongly-cased path names the real file on a case-insensitive filesystem', async () => {
            const root = makeFixture({
                'requireonrails.json': projectFile({ mode: 'dynamic' }),
                'src/Shared/Util.luau': 'return {}\n',
                'src/Main.luau': 'local U = require("@Util")\n'
            });
            const { result } = await runJson(root, 'rename', 'src/shared/util.luau', 'SRC/shared/New/Lib.luau');
            assert.deepStrictEqual(result.moved, { from: 'src/Shared/Util.luau', to: 'src/Shared/New/Lib.luau' });
            assert.strictEqual(read(root, 'src/Main.luau'), 'local U = require("@Lib")\n');
        });
    }
});

suite('CLI command: build', () => {
    test('A dry run lists the files it would write and writes none', async () => {
        const root = makeFixture({
            'requireonrails.json': projectFile({ 'buildConversion.enabled': true }),
            'src/Shared/Util.luau': 'return {}\n',
            'src/Server/Main.luau': 'local U = require("@Util")\n'
        });
        const { code, result } = await runJson(root, 'build', '--dry-run');
        assert.strictEqual(code, 0);
        assert.deepStrictEqual(result.outputs.sort(), ['dist/src/Server/Main.luau', 'dist/src/Shared/Util.luau']);
        assert.strictEqual(fs.existsSync(path.join(root, 'dist')), false);

        assert.strictEqual((await runJson(root, 'build')).result.written, true);
        assert.strictEqual(read(root, 'dist/src/Server/Main.luau'), 'local U = require("../Shared/Util")\n');
    });

    test('Refuses while Build conversion is off', async () => {
        const root = makeFixture({ 'requireonrails.json': projectFile({}) });
        assert.strictEqual((await runJson(root, 'build')).code, 1);
    });
});

suiteTeardown(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});
