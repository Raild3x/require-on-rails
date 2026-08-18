// Watch pipeline tests. The behavior under test is the validity gate: a save streams
// immediately when clean, and is held at its last good output while the Luau language
// server reports errors — with the hold bounded so standing type errors never pin a file
// at stale output. Luau diagnostics are faked by stubbing vscode.languages.getDiagnostics,
// since no language server runs in the test host.
const assert = require('assert');
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const buildWatch = require('../../../src/features/buildWatch');
const pathResolver = require('../../../src/features/pathResolver');

const { mockWorkspaceConfig, createTestFiles } = require('../utils/testUtils');

suite('Build Watch Tests', () => {
    let testWorkspacePath;
    let testWorkspaceUri;
    let restoreConfig;
    const originalGetDiagnostics = vscode.languages.getDiagnostics;

    /** Files reported as having Luau errors, by absolute path. */
    /** @type {Set<string>} */
    let erroring = new Set();

    const CONSUMER = 'src/Server/Consumer.luau';
    const OUT_CONSUMER = 'dist/src/Server/Consumer.luau';

    suiteSetup(() => {
        testWorkspacePath = path.join(__dirname, 'build-watch-test-workspace');
        testWorkspaceUri = vscode.Uri.file(testWorkspacePath);
        fs.mkdirSync(testWorkspacePath, { recursive: true });

        createTestFiles(testWorkspacePath, {
            'src/Shared/Target.luau': 'return { value = 1 }',
            [CONSUMER]: 'local Target = require("@Target")\nreturn Target',
            '.luaurc': JSON.stringify({ aliases: { Target: 'src/Shared/Target', Shared: 'src/Shared' } }),
            'default.project.json': JSON.stringify({
                name: 'Test',
                tree: {
                    $className: 'DataModel',
                    ReplicatedStorage: { Shared: { $path: 'src/Shared' } },
                    ServerScriptService: { Server: { $path: 'src/Server' } }
                }
            })
        });

        restoreConfig = mockWorkspaceConfig(testWorkspaceUri, {
            directoriesToScan: ['src/Server', 'src/Shared'],
            ignoreDirectories: [],
            pathPriority: [],
            mode: 'dynamic',
            rojoProjectPath: 'default.project.json',
            importModulePaths: ['ReplicatedStorage.src.Import'],
            // Dotted keys must carry the section prefix: mockWorkspaceConfig strips
            // "<section>." and drops any other dotted key.
            'require-on-rails.buildConversion.enabled': true,
            'require-on-rails.buildConversion.outputDirectory': 'dist',
            'require-on-rails.buildConversion.outputRequireStyle': 'string',
            'require-on-rails.buildConversion.buildProjectFile': 'build.project.json'
        });

        // Stand in for luau-lsp: only paths in `erroring` carry an Error diagnostic.
        vscode.languages.getDiagnostics = /** @type {any} */ ((uri) => {
            if (!uri) return [];
            if (!erroring.has(uri.fsPath)) return [];
            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(0, 0, 0, 1), 'stub syntax error', vscode.DiagnosticSeverity.Error);
            diagnostic.source = 'Luau';
            return [diagnostic];
        });

        pathResolver.refreshContext();
    });

    suiteTeardown(() => {
        vscode.languages.getDiagnostics = originalGetDiagnostics;
        if (restoreConfig) restoreConfig();
        fs.rmSync(testWorkspacePath, { recursive: true, force: true });
    });

    setup(() => {
        buildWatch._resetForTests();
        erroring.clear();
        fs.rmSync(path.join(testWorkspacePath, 'dist'), { recursive: true, force: true });
        // Reset the source to a known-good state for each case.
        fs.writeFileSync(path.join(testWorkspacePath, CONSUMER),
            'local Target = require("@Target")\nreturn Target', 'utf8');
        pathResolver.refreshContext();
    });

    /** @param {string} rel */
    function outputText(rel) {
        const absolute = path.join(testWorkspacePath, rel);
        return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null;
    }

    test('A clean save writes converted output immediately', () => {
        buildWatch.attemptWrite(CONSUMER);

        const written = outputText(OUT_CONSUMER);
        assert.ok(written, 'expected converted output to be written');
        assert.ok(written.includes('require("../Shared/Target")'), written);
        assert.ok(!written.includes('@Target'), 'alias should have been converted');
    });

    test('A save with Luau errors is held, keeping the previous output', () => {
        buildWatch.attemptWrite(CONSUMER);
        const good = outputText(OUT_CONSUMER);

        // Now "break" the file and save again.
        fs.writeFileSync(path.join(testWorkspacePath, CONSUMER),
            'local Target = require("@Target")\nreturn Target ===', 'utf8');
        erroring.add(path.join(testWorkspacePath, CONSUMER));
        buildWatch.attemptWrite(CONSUMER);

        assert.strictEqual(outputText(OUT_CONSUMER), good, 'held file must keep its last good output');
        assert.ok(buildWatch._isHeld(CONSUMER), 'file should be registered as held');
    });

    test('Clearing the errors releases the hold and writes', () => {
        erroring.add(path.join(testWorkspacePath, CONSUMER));
        buildWatch.attemptWrite(CONSUMER);
        assert.strictEqual(outputText(OUT_CONSUMER), null, 'nothing should be written while held');

        erroring.clear();
        buildWatch.attemptWrite(CONSUMER);

        const written = outputText(OUT_CONSUMER);
        assert.ok(written && written.includes('require("../Shared/Target")'), 'expected write after errors cleared');
        assert.ok(!buildWatch._isHeld(CONSUMER), 'hold should be released');
    });

    test('The hold expires so standing type errors never pin stale output', function (done) {
        this.timeout(buildWatch.HOLD_GRACE_MS + 5000);
        erroring.add(path.join(testWorkspacePath, CONSUMER));
        buildWatch.attemptWrite(CONSUMER);
        assert.strictEqual(outputText(OUT_CONSUMER), null);

        // Errors deliberately stay set: this is the standing-type-error case.
        setTimeout(() => {
            try {
                const written = outputText(OUT_CONSUMER);
                assert.ok(written, 'hold must expire and write even while errors persist');
                assert.ok(written.includes('require("../Shared/Target")'), written);
                done();
            } catch (e) {
                done(e);
            }
        }, buildWatch.HOLD_GRACE_MS + 750);
    });

    test('ignoreDiagnostics writes despite errors (the focus-loss path)', () => {
        erroring.add(path.join(testWorkspacePath, CONSUMER));
        buildWatch.attemptWrite(CONSUMER, { ignoreDiagnostics: true });

        const written = outputText(OUT_CONSUMER);
        assert.ok(written && written.includes('require("../Shared/Target")'),
            'alt-tabbing to Studio should flush held files rather than serve stale output');
    });

    test('An unresolvable require keeps the last good output even with no Luau errors', () => {
        buildWatch.attemptWrite(CONSUMER);
        const good = outputText(OUT_CONSUMER);

        fs.writeFileSync(path.join(testWorkspacePath, CONSUMER),
            'local Ghost = require("@NoSuchModuleAnywhere")\nreturn Ghost', 'utf8');
        buildWatch.attemptWrite(CONSUMER);

        assert.strictEqual(outputText(OUT_CONSUMER), good,
            'a require that cannot be converted must never reach the output');
        assert.ok(!buildWatch._isHeld(CONSUMER), 'conversion failures are not diagnostics holds');
    });

    test('Deleting the source leaves no orphaned hold', () => {
        const scratch = 'src/Server/Temp.luau';
        createTestFiles(testWorkspacePath, { [scratch]: 'return {}' });
        pathResolver.refreshContext();
        buildWatch.attemptWrite(scratch);
        assert.ok(outputText('dist/' + scratch), 'expected the scratch file to convert');

        fs.unlinkSync(path.join(testWorkspacePath, scratch));
        buildWatch.attemptWrite(scratch);
        assert.ok(!buildWatch._isHeld(scratch), 'a missing source must not stay held');
    });

    test('hasLuauErrors only reacts to Luau-sourced Error diagnostics', () => {
        const uri = vscode.Uri.file(path.join(testWorkspacePath, CONSUMER));
        assert.strictEqual(buildWatch.hasLuauErrors(uri), false);

        erroring.add(uri.fsPath);
        assert.strictEqual(buildWatch.hasLuauErrors(uri), true);

        // A non-Luau source (e.g. a spell checker) must not gate our writes.
        erroring.clear();
        const previous = vscode.languages.getDiagnostics;
        vscode.languages.getDiagnostics = /** @type {any} */ (() => {
            const d = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'other', vscode.DiagnosticSeverity.Error);
            d.source = 'cSpell';
            return [d];
        });
        assert.strictEqual(buildWatch.hasLuauErrors(uri), false);
        vscode.languages.getDiagnostics = previous;
    });
});
