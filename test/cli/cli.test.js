// Headless tests for the CI checker. Unlike every suite under test/vs-code-extension, these
// run in plain Node — which is the point: the checker must work with no editor present.
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const { parseJsonc, loadConfig } = require('../../src/cli/check');
const { classifyBasenames } = require('../../src/features/updateLuaFileAliases');

const REPO_ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join('test', 'ci-fixture');
const EXPLICIT_FIXTURE = path.join('test', 'ci-fixture-explicit');

function runChecker(args) {
    const result = spawnSync(process.execPath, [path.join('src', 'cli', 'check.js'), ...args], {
        cwd: REPO_ROOT,
        encoding: 'utf8'
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

suite('CLI: JSONC parsing', () => {
    test('Parses plain JSON', () => {
        assert.deepStrictEqual(parseJsonc('{"a": 1}'), { a: 1 });
    });

    test('Strips line comments', () => {
        assert.deepStrictEqual(parseJsonc('{\n  // note\n  "a": 1\n}'), { a: 1 });
    });

    test('Strips block comments, including mid-line', () => {
        assert.deepStrictEqual(parseJsonc('{/* x */ "a": /* y */ 1}'), { a: 1 });
    });

    test('Allows trailing commas in objects and arrays', () => {
        assert.deepStrictEqual(parseJsonc('{"a": [1, 2,], }'), { a: [1, 2] });
    });

    test('Leaves comment-like sequences inside strings alone', () => {
        assert.deepStrictEqual(parseJsonc('{"a": "http://x.com", "b": "/* not a comment */"}'),
            { a: 'http://x.com', b: '/* not a comment */' });
    });

    test('Respects escaped quotes when tracking strings', () => {
        assert.deepStrictEqual(parseJsonc('{"a": "say \\"// hi\\"", "b": 1}'), { a: 'say "// hi"', b: 1 });
    });

    test('Throws on genuinely malformed input', () => {
        assert.throws(() => parseJsonc('{"a": }'));
    });
});

suite('CLI: configuration loading', () => {
    test('Reads the fixture settings, overriding the shipped defaults', () => {
        const { config } = loadConfig(path.join(REPO_ROOT, FIXTURE));
        assert.deepStrictEqual(config.directoriesToScan, ['src']);
        // The shipped default is {Server, Client, Shared}; the fixture clears it.
        assert.deepStrictEqual(config.manualAliases, {});
    });

    test('Falls back to the shipped defaults for unset keys', () => {
        const { config } = loadConfig(path.join(REPO_ROOT, FIXTURE));
        assert.strictEqual(config.mode, 'dynamic');
        assert.deepStrictEqual(config.ignoreDirectories, ['^_.*']);
    });

    test('Uses defaults entirely when there is no settings file', () => {
        const { config, findings } = loadConfig(path.join(REPO_ROOT, 'images'));
        assert.strictEqual(config.mode, 'dynamic');
        assert.deepStrictEqual(config.directoriesToScan, ['src/Server', 'src/Client', 'src/Shared']);
        assert.deepStrictEqual(findings, [], 'an absent settings file is not a problem to report');
    });

    test('The Project settings file wins over .vscode/settings.json', () => {
        // ProjectTemplate ships both: editor preferences in .vscode, project settings here.
        const { config, findings } = loadConfig(path.join(REPO_ROOT, 'ProjectTemplate'));
        assert.deepStrictEqual(findings, [], `template settings should be clean:\n${JSON.stringify(findings, null, 2)}`);
        assert.deepStrictEqual(config.manualAliases,
            { Server: 'src/Server', Client: 'src/Client', Shared: 'src/Shared' });
    });
});

suite('CLI: alias classification', () => {
    const twins = { myModule: [{ path: 'src/A/myModule.luau' }, { path: 'src/B/myModule.luau' }] };

    test('A unique basename becomes an alias', () => {
        const result = classifyBasenames({ Solo: [{ path: 'src/Solo.luau' }] }, {});
        assert.strictEqual(result.aliases.Solo, 'src/Solo.luau');
        assert.deepStrictEqual(result.ambiguousAliases, {});
    });

    test('A shared basename is dropped and reported with its conflicting paths', () => {
        const result = classifyBasenames(twins, {});
        assert.strictEqual(result.aliases.myModule, undefined);
        assert.deepStrictEqual(result.ambiguousAliases.myModule,
            ['src/A/myModule.luau', 'src/B/myModule.luau']);
    });

    test('pathPriority breaks the tie', () => {
        const result = classifyBasenames(twins, { pathPriority: ['src/B'] });
        assert.strictEqual(result.aliases.myModule, 'src/B/myModule.luau');
        assert.deepStrictEqual(result.ambiguousAliases, {});
    });

    test('A prefix matching every candidate leaves it ambiguous', () => {
        const result = classifyBasenames(twins, { pathPriority: ['src'] });
        assert.ok(result.ambiguousAliases.myModule, 'should stay ambiguous');
    });

    test('manualAliases shadow generated ones', () => {
        const result = classifyBasenames({ Solo: [{ path: 'src/Solo.luau' }] },
            { manualAliases: { Solo: 'src/Elsewhere' } });
        assert.strictEqual(result.aliases.Solo, 'src/Elsewhere');
        assert.strictEqual(result.shadowedByManual, 1);
    });
});

suite('CLI: end to end', () => {
    test('Reports the fixture problems and fails the run', () => {
        const { status, output } = runChecker(['--working-directory', FIXTURE]);
        assert.strictEqual(status, 1, 'should exit non-zero when there are findings');
        assert.ok(output.includes('3 finding(s)'), `expected 3 findings, got:\n${output}`);
        assert.ok(output.includes('alias "myModule" is ambiguous'), 'should report the ambiguity');
        assert.ok(output.includes('alias "Nope" is not defined'), 'should report the unknown alias');
    });

    test('Emits GitHub annotations pointing at repository-relative paths', () => {
        const { output } = runChecker(['--working-directory', FIXTURE]);
        assert.ok(output.includes('::error file=test/ci-fixture/src/consumer.luau,line=2,col=28'),
            `annotation missing or mispositioned:\n${output}`);
    });

    test('Ignores requires on commented-out lines', () => {
        const { output } = runChecker(['--working-directory', FIXTURE]);
        assert.ok(!output.includes('AlsoNotReal'), 'commented-out require should not be reported');
    });

    test('warn-only downgrades annotations and exits successfully', () => {
        const { status, output } = runChecker(['--working-directory', FIXTURE, '--warn-only']);
        assert.strictEqual(status, 0, 'warn-only should exit zero');
        assert.ok(output.includes('::warning file='), 'should emit warnings, not errors');
        assert.ok(!output.includes('::error file='), 'should not emit errors under warn-only');
    });

    test('Accepts inputs the way GitHub passes them', () => {
        const result = spawnSync(process.execPath, [path.join('src', 'cli', 'check.js')], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            env: { ...process.env, 'INPUT_WORKING-DIRECTORY': FIXTURE, 'INPUT_WARN-ONLY': 'true' }
        });
        assert.strictEqual(result.status, 0);
        assert.ok(result.stdout.includes('3 finding(s)'), `expected findings, got:\n${result.stdout}`);
    });

    test('ProjectTemplate is clean, so the shipped template passes its own check', () => {
        const { status, output } = runChecker(['--working-directory', 'ProjectTemplate']);
        assert.strictEqual(status, 0, `template should be clean, got:\n${output}`);
        assert.ok(output.includes('no issues found'), output);
    });

    test('Explicit mode reports only requires that fail to resolve', () => {
        const { status, output } = runChecker(['--working-directory', EXPLICIT_FIXTURE]);
        assert.strictEqual(status, 1);
        assert.ok(output.includes('2 finding(s)'), `expected 2 findings, got:\n${output}`);
        assert.ok(output.includes('no module found at "src/Shared/Ghost"'), output);
        assert.ok(output.includes('alias "Nope" is not defined'), output);
        // The valid alias-rooted and relative requires in the same file must stay quiet.
        assert.ok(!output.includes('"@Shared/Real"'), 'a resolvable alias require was reported');
        assert.ok(!output.includes('"./Real"'), 'a resolvable relative require was reported');
    });

    test('Explicit mode runs neither the ambiguity nor the drift check', () => {
        const { output } = runChecker(['--working-directory', EXPLICIT_FIXTURE]);
        assert.ok(!output.includes('ambiguous'), 'duplicate basenames are legal in explicit mode');
        assert.ok(!output.includes('drift'), 'the extension never writes .luaurc in explicit mode');
    });

    test('A missing working-directory is an error, not a silent pass', () => {
        const { status, output } = runChecker(['--working-directory', 'does/not/exist']);
        assert.strictEqual(status, 1);
        assert.ok(output.includes('::error'), output);
    });
});
