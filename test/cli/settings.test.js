// Headless tests for the Settings module: the resolution chain, validation findings, and the
// two invariants that keep the tool, the manifest, and the generated schema in step.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const settings = require('../../src/core/settings');
const { SCHEMA } = require('../../src/core/settingsSchema');
const { render, OUTPUT_PATH } = require('../../scripts/generate-settings-schema');
const manifest = require('../../package.json');

/**
 * Writes a throwaway workspace and returns its root.
 * @param {Record<string, string>} files - Workspace-relative path -> contents
 */
function makeWorkspace(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ror-settings-'));
    for (const [relative, contents] of Object.entries(files)) {
        const full = path.join(root, relative);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, contents);
    }
    return root;
}

suite('Settings: resolution chain', () => {
    test('Defaults apply when nothing is configured', () => {
        const root = makeWorkspace({});
        const { settings: resolved, findings } = settings.resolveSettings(root);
        assert.deepStrictEqual(findings, []);
        assert.strictEqual(resolved['mode'], 'dynamic');
        assert.deepStrictEqual(resolved['directoriesToScan'], ['src/Server', 'src/Client', 'src/Shared']);
    });

    test('.vscode/settings.json overrides defaults', () => {
        const root = makeWorkspace({
            '.vscode/settings.json': '{"require-on-rails.mode": "explicit"}'
        });
        assert.strictEqual(settings.resolveSettings(root).settings['mode'], 'explicit');
    });

    test('The project file wins over .vscode/settings.json, per key', () => {
        const root = makeWorkspace({
            '.vscode/settings.json': '{"require-on-rails.mode": "explicit", "require-on-rails.sourcemapPath": "from-vscode.json"}',
            'requireonrails.json': '{"mode": "dynamic"}'
        });
        const { settings: resolved } = settings.resolveSettings(root);
        assert.strictEqual(resolved['mode'], 'dynamic', 'project file should win');
        assert.strictEqual(resolved['sourcemapPath'], 'from-vscode.json', 'unset keys fall through');
    });

    test('Nested project-file keys flatten to dotted keys', () => {
        const root = makeWorkspace({
            'requireonrails.json': '{"buildConversion": {"enabled": true, "outputDirectory": "out"}}'
        });
        const { settings: resolved, findings } = settings.resolveSettings(root);
        assert.deepStrictEqual(findings, []);
        assert.strictEqual(resolved['buildConversion.enabled'], true);
        assert.strictEqual(resolved['buildConversion.outputDirectory'], 'out');
    });

    test('The project file accepts comments and trailing commas', () => {
        const root = makeWorkspace({
            'requireonrails.json': '{\n  // the mode\n  "mode": "explicit",\n}'
        });
        const { settings: resolved, findings } = settings.resolveSettings(root);
        assert.deepStrictEqual(findings, []);
        assert.strictEqual(resolved['mode'], 'explicit');
    });

    test('An editor overlay stands in for the live configuration', () => {
        const root = makeWorkspace({
            '.vscode/settings.json': '{"require-on-rails.mode": "explicit"}',
            'requireonrails.json': '{"sourcemapPath": "from-project.json"}'
        });
        const { settings: resolved } = settings.resolveSettings(root, { overlay: { mode: 'dynamic' } });
        // The overlay replaces the settings-file source entirely, and the project file still wins.
        assert.strictEqual(resolved['mode'], 'dynamic');
        assert.strictEqual(resolved['sourcemapPath'], 'from-project.json');
    });

    test('Mutating a returned default cannot poison the next resolution', () => {
        const root = makeWorkspace({});
        settings.resolveSettings(root).settings['directoriesToScan'].push('polluted');
        assert.deepStrictEqual(settings.resolveSettings(root).settings['directoriesToScan'],
            ['src/Server', 'src/Client', 'src/Shared']);
    });
});

suite('Settings: validation findings', () => {
    test('A malformed project file is an error finding, and no value is applied', () => {
        const root = makeWorkspace({
            '.vscode/settings.json': '{"require-on-rails.mode": "explicit"}',
            'requireonrails.json': '{"mode": '
        });
        const { settings: resolved, findings } = settings.resolveSettings(root);
        assert.ok(settings.hasErrorFindings(findings), 'should be fatal');
        assert.strictEqual(findings[0].code, 'settings-parse-error');
        assert.strictEqual(resolved['mode'], 'explicit', 'falls back rather than inventing a value');
    });

    test('A wrong-typed value is an error finding and is not applied', () => {
        const root = makeWorkspace({ 'requireonrails.json': '{"directoriesToScan": "src"}' });
        const { settings: resolved, findings } = settings.resolveSettings(root);
        assert.strictEqual(findings.length, 1);
        assert.strictEqual(findings[0].code, 'invalid-setting-value');
        assert.strictEqual(findings[0].severity, 'error');
        assert.ok(/expected array, got string/.test(findings[0].message), findings[0].message);
        assert.deepStrictEqual(resolved['directoriesToScan'], ['src/Server', 'src/Client', 'src/Shared']);
    });

    test("A value outside a setting's vocabulary is rejected", () => {
        const root = makeWorkspace({ 'requireonrails.json': '{"mode": "hybrid"}' });
        const { settings: resolved, findings } = settings.resolveSettings(root);
        assert.strictEqual(findings[0].code, 'invalid-setting-value');
        assert.strictEqual(resolved['mode'], 'dynamic');
    });

    test('An unknown key warns but does not stop the run', () => {
        const root = makeWorkspace({ 'requireonrails.json': '{"directoriesToScann": ["src"]}' });
        const { findings } = settings.resolveSettings(root);
        assert.strictEqual(findings.length, 1);
        assert.strictEqual(findings[0].code, 'unknown-setting');
        assert.strictEqual(findings[0].severity, 'warning');
        assert.ok(!settings.hasErrorFindings(findings), 'a typo must not stop operations');
    });

    test('An editor preference in the project file warns and is ignored', () => {
        const root = makeWorkspace({ 'requireonrails.json': '{"importOpacity": 0.9}' });
        const { settings: resolved, findings } = settings.resolveSettings(root);
        assert.strictEqual(findings[0].code, 'editor-setting-in-project-file');
        assert.strictEqual(resolved['importOpacity'], 0.45);
    });

    test('Findings are anchored to the offending key, not line 0', () => {
        const root = makeWorkspace({ 'requireonrails.json': '{\n    "mode": "dynamic",\n    "pathPriority": "src"\n}' });
        const { findings } = settings.resolveSettings(root);
        assert.strictEqual(findings[0].line, 2, `expected line 2, got ${findings[0].line}`);
        assert.strictEqual(findings[0].column, 4);
    });

    test('The $schema key is not reported as unknown', () => {
        const root = makeWorkspace({ 'requireonrails.json': '{"$schema": "https://example.com/s.json", "mode": "explicit"}' });
        assert.deepStrictEqual(settings.resolveSettings(root).findings, []);
    });
});

suite('Settings: writing the project file', () => {
    test('Creates the file with its $schema line', () => {
        const root = makeWorkspace({});
        settings.writeProjectSetting(root, 'mode', 'explicit');
        const written = JSON.parse(fs.readFileSync(path.join(root, 'requireonrails.json'), 'utf8'));
        assert.strictEqual(written.mode, 'explicit');
        assert.ok(written.$schema, 'should point at the schema for autocomplete');
        assert.strictEqual(settings.resolveSettings(root).settings['mode'], 'explicit');
    });

    test('Preserves other keys, and nests dotted ones', () => {
        const root = makeWorkspace({ 'requireonrails.json': '{"mode": "explicit"}' });
        settings.writeProjectSetting(root, 'buildConversion.enabled', true);
        const { settings: resolved, findings } = settings.resolveSettings(root);
        assert.deepStrictEqual(findings, []);
        assert.strictEqual(resolved['mode'], 'explicit');
        assert.strictEqual(resolved['buildConversion.enabled'], true);
    });

    test('Refuses to write an editor preference', () => {
        const root = makeWorkspace({});
        assert.throws(() => settings.writeProjectSetting(root, 'importOpacity', 0.9));
    });
});

suite('Settings: option bundles', () => {
    test('buildOptions carries the resolver bundle plus build settings', () => {
        const root = makeWorkspace({ 'requireonrails.json': '{"buildConversion": {"outputDirectory": "out"}}' });
        const options = settings.buildOptions(settings.resolveSettings(root).settings, { dryRun: true });
        assert.strictEqual(options.outputDirectory, 'out');
        assert.strictEqual(options.outputRequireStyle, 'string');
        assert.strictEqual(options.dryRun, true);
        assert.deepStrictEqual(options.directoriesToScan, ['src/Server', 'src/Client', 'src/Shared']);
        assert.strictEqual(options.sourcemapPath, 'sourcemap.json');
    });
});

suite('Settings: schema invariants', () => {
    // ADR 0004: the schema module is canonical and the manifest is hand-maintained, so the
    // two must be checked against each other rather than one generated from the other.
    test('The manifest contributes exactly the schema keys, with the same defaults', () => {
        const contributed = Object.keys(manifest.contributes.configuration.properties)
            .map(key => key.replace(/^require-on-rails\./, '')).sort();
        assert.deepStrictEqual(contributed, Object.keys(SCHEMA).sort(),
            'add or remove the key in BOTH src/core/settingsSchema.js and package.json');

        for (const [key, spec] of Object.entries(SCHEMA)) {
            const property = manifest.contributes.configuration.properties[`require-on-rails.${key}`];
            assert.deepStrictEqual(property.default, spec.default, `default for "${key}" differs from the manifest`);
            if (spec.enum) assert.deepStrictEqual(property.enum, spec.enum, `enum for "${key}" differs from the manifest`);
        }
    });

    test('The committed JSON Schema is up to date', () => {
        assert.strictEqual(fs.readFileSync(OUTPUT_PATH, 'utf8'), render(),
            'run "node scripts/generate-settings-schema.js" and commit the result');
    });

    test('Only project-scope keys reach the generated schema', () => {
        const generated = JSON.parse(render());
        assert.ok(generated.properties.mode, 'project keys belong in the schema');
        assert.ok(!generated.properties.importOpacity, 'editor preferences must not');
        assert.ok(generated.properties.buildConversion.properties.enabled, 'dotted keys nest');
    });
});
