// The Settings module (ADR 0004). One resolution chain for every entry point — editor,
// CI action, CLI, tests:
//
//     requireonrails.json  >  .vscode/settings.json (or the live editor config)  >  defaults
//
// merged per key. A source is just a partial map of plain values; where the values come
// from is the caller's adapter concern (the extension passes the live configuration as
// `overlay`, headless callers let this module read the workspace file). Pure Node — no
// vscode, no dependencies (the CI action runs this from a bare checkout).
//
// Resolution returns { settings, findings }: a malformed project file or a wrong-typed
// value is an error finding and the offending value is not used; operations that need
// settings must refuse to run while error findings exist. No silent fallback (ADR 0003's
// loud-failure philosophy applied to configuration).

const fs = require('fs');
const path = require('path');
const { SCHEMA, PROJECT_SCHEMA_URL, isProjectKey } = require('./settingsSchema');

const PROJECT_SETTINGS_FILE = 'requireonrails.json';
const VSCODE_SETTINGS_FILE = '.vscode/settings.json';

/**
 * One problem found while resolving settings. Same anchor shape as the checker's findings,
 * plus a severity: 'error' findings must stop operations, 'warning' findings must not.
 * @typedef {object} SettingsFinding
 * @property {string} file - Workspace-relative
 * @property {number} line - 0-based
 * @property {number} column
 * @property {number} endColumn
 * @property {string} code
 * @property {string} message
 * @property {'error'|'warning'} severity
 */

/** @typedef {Record<string, any>} SettingsMap - Flat, dotted keys (e.g. 'buildConversion.enabled') */

/**
 * Parses JSON with comments and trailing commas, the dialect VS Code writes settings.json in
 * and Luau accepts for .luaurc. Hand-rolled to keep this package dependency-free.
 * @param {string} text
 * @returns {any} Whatever the document contained
 */
function parseJsonc(text) {
    const source = text.replace(/^﻿/, '');
    let out = '';
    let inString = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < source.length; i++) {
        const char = source[i];
        const next = source[i + 1];

        if (inLineComment) {
            if (char === '\n') { inLineComment = false; out += char; }
            continue;
        }
        if (inBlockComment) {
            if (char === '*' && next === '/') { inBlockComment = false; i++; }
            continue;
        }
        if (inString) {
            out += char;
            // A backslash escapes the next character, so a \" does not end the string.
            if (char === '\\') { out += next; i++; continue; }
            if (char === '"') inString = false;
            continue;
        }
        if (char === '"') { inString = true; out += char; continue; }
        if (char === '/' && next === '/') { inLineComment = true; i++; continue; }
        if (char === '/' && next === '*') { inBlockComment = true; i++; continue; }
        out += char;
    }

    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** @param {unknown} value @returns {string} */
function typeOf(value) {
    if (Array.isArray(value)) return 'array';
    if (value === null) return 'null';
    return typeof value;
}

// Positions a finding at a key's occurrence in the raw text, the same indexOf approach the
// ignored-setting diagnostics already use. Good enough for a settings-sized file; a full
// position-tracking JSONC parser is not worth carrying for squiggle anchors.
/**
 * @param {string} text
 * @param {string} keySegment - The last segment of the dotted key, as written in the file
 * @returns {{line: number, column: number, endColumn: number}}
 */
function locateKey(text, keySegment) {
    const needle = `"${keySegment}"`;
    const index = text.indexOf(needle);
    if (index === -1) return { line: 0, column: 0, endColumn: 0 };
    const before = text.slice(0, index);
    const line = (before.match(/\n/g) || []).length;
    const column = index - (before.lastIndexOf('\n') + 1);
    return { line, column, endColumn: column + needle.length };
}

/**
 * @param {string} file
 * @param {{line: number, column: number, endColumn: number}} at
 * @param {string} code
 * @param {string} message
 * @param {'error'|'warning'} severity
 * @returns {SettingsFinding}
 */
function makeFinding(file, at, code, message, severity) {
    return { file, ...at, code, message, severity };
}

// A value that fails these checks is rejected (falls through to the next source) alongside an
// error finding — using a wrong-typed value silently is the ghost-debug scenario.
/**
 * @param {string} key
 * @param {unknown} value
 * @returns {string | null} Problem description, or null when the value fits the schema
 */
function validateValue(key, value) {
    const spec = SCHEMA[key];
    if (!spec) return null;
    const actual = typeOf(value);
    if (actual !== spec.type) return `expected ${spec.type}, got ${actual}`;
    if (spec.enum && !spec.enum.includes(/** @type {string} */(value))) {
        return `must be one of ${spec.enum.map(v => `"${v}"`).join(', ')}`;
    }
    if (spec.type === 'array' && /** @type {unknown[]} */(value).some(item => typeof item !== 'string')) {
        return 'every entry must be a string';
    }
    if (spec.type === 'object' && Object.values(/** @type {Record<string, unknown>} */(value)).some(v => typeof v !== 'string')) {
        return 'every value must be a string';
    }
    return null;
}

// Flattens the nested project-file shape ({"buildConversion": {"enabled": true}}) into dotted
// keys, walking only branches the schema knows about so anything else surfaces as unknown.
/**
 * @param {Record<string, any>} parsed
 * @param {string} prefix
 * @param {{key: string, value: any}[]} entries
 * @param {string[]} unknown
 */
function flattenInto(parsed, prefix, entries, unknown) {
    for (const [segment, value] of Object.entries(parsed)) {
        if (prefix === '' && segment === '$schema') continue;
        const key = prefix === '' ? segment : `${prefix}.${segment}`;
        if (SCHEMA[key] !== undefined) {
            entries.push({ key, value });
        } else if (typeOf(value) === 'object' && Object.keys(SCHEMA).some(k => k.startsWith(`${key}.`))) {
            flattenInto(value, key, entries, unknown);
        } else {
            unknown.push(key);
        }
    }
}

/**
 * Reads and validates the Project settings file. An absent file is not a finding — the file
 * is optional and the chain simply has one fewer source.
 * @param {string} workspaceRoot
 * @returns {{exists: boolean, values: SettingsMap, findings: SettingsFinding[]}}
 */
function readProjectFile(workspaceRoot) {
    const filePath = path.join(workspaceRoot, PROJECT_SETTINGS_FILE);
    if (!fs.existsSync(filePath)) return { exists: false, values: {}, findings: [] };

    /** @type {SettingsFinding[]} */
    const findings = [];
    /** @type {SettingsMap} */
    const values = {};

    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        findings.push(makeFinding(PROJECT_SETTINGS_FILE, { line: 0, column: 0, endColumn: 0 },
            'settings-parse-error',
            `RequireOnRails: could not read ${PROJECT_SETTINGS_FILE}: ${e instanceof Error ? e.message : String(e)}`,
            'error'));
        return { exists: true, values, findings };
    }

    let parsed;
    try {
        parsed = raw.trim() ? parseJsonc(raw) : {};
    } catch (e) {
        findings.push(makeFinding(PROJECT_SETTINGS_FILE, { line: 0, column: 0, endColumn: 0 },
            'settings-parse-error',
            `RequireOnRails: ${PROJECT_SETTINGS_FILE} is not valid JSONC — ${e instanceof Error ? e.message : String(e)}. ` +
            'Settings from this file are not applied until it parses.',
            'error'));
        return { exists: true, values, findings };
    }

    if (typeOf(parsed) !== 'object') {
        findings.push(makeFinding(PROJECT_SETTINGS_FILE, { line: 0, column: 0, endColumn: 0 },
            'settings-parse-error',
            `RequireOnRails: ${PROJECT_SETTINGS_FILE} must contain a JSON object.`,
            'error'));
        return { exists: true, values, findings };
    }

    /** @type {{key: string, value: any}[]} */
    const entries = [];
    /** @type {string[]} */
    const unknown = [];
    flattenInto(parsed, '', entries, unknown);

    for (const key of unknown) {
        const segment = key.split('.').pop() || key;
        findings.push(makeFinding(PROJECT_SETTINGS_FILE, locateKey(raw, segment),
            'unknown-setting',
            `RequireOnRails: "${key}" is not a RequireOnRails setting. Check for a typo — unknown keys do nothing.`,
            'warning'));
    }

    for (const { key, value } of entries) {
        const segment = key.split('.').pop() || key;
        if (!isProjectKey(key)) {
            findings.push(makeFinding(PROJECT_SETTINGS_FILE, locateKey(raw, segment),
                'editor-setting-in-project-file',
                `RequireOnRails: "${key}" is an editor preference and is ignored here — set it in VS Code settings instead.`,
                'warning'));
            continue;
        }
        const problem = validateValue(key, value);
        if (problem) {
            findings.push(makeFinding(PROJECT_SETTINGS_FILE, locateKey(raw, segment),
                'invalid-setting-value',
                `RequireOnRails: "${key}" ${problem}. The value is not applied.`,
                'error'));
            continue;
        }
        values[key] = value;
    }

    return { exists: true, values, findings };
}

/**
 * Reads the require-on-rails.* keys out of the workspace's .vscode/settings.json — the
 * headless stand-in for the live editor configuration. User-scope overrides are invisible
 * here by nature; that asymmetry is accepted (ADR 0004).
 * @param {string} workspaceRoot
 * @returns {{values: SettingsMap, findings: SettingsFinding[]}}
 */
function readVscodeSettingsValues(workspaceRoot) {
    const filePath = path.join(workspaceRoot, '.vscode', 'settings.json');
    /** @type {SettingsMap} */
    const values = {};
    if (!fs.existsSync(filePath)) return { values, findings: [] };

    let parsed;
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        parsed = raw.trim() ? parseJsonc(raw) : {};
    } catch (e) {
        return {
            values,
            findings: [makeFinding(VSCODE_SETTINGS_FILE, { line: 0, column: 0, endColumn: 0 },
                'settings-parse-error',
                `RequireOnRails: could not parse ${VSCODE_SETTINGS_FILE}: ${e instanceof Error ? e.message : String(e)}`,
                'error')]
        };
    }

    for (const key of Object.keys(SCHEMA)) {
        const value = parsed[`require-on-rails.${key}`];
        if (value !== undefined) values[key] = value;
    }
    return { values, findings: [] };
}

/**
 * Resolves the full settings chain. Pass `overlay` from the editor (the live configuration,
 * which already merges user and workspace scope); omit it headless and the workspace
 * settings file is read instead. Every schema key is present in the result.
 * @param {string | null} workspaceRoot - null resolves overlay + defaults only
 * @param {{overlay?: SettingsMap}} [options]
 * @returns {{settings: SettingsMap, findings: SettingsFinding[], projectValues: SettingsMap}}
 */
function resolveSettings(workspaceRoot, { overlay } = {}) {
    /** @type {SettingsFinding[]} */
    const findings = [];

    /** @type {SettingsMap} */
    let middle = {};
    if (overlay !== undefined) {
        middle = overlay;
    } else if (workspaceRoot) {
        const fromFile = readVscodeSettingsValues(workspaceRoot);
        middle = fromFile.values;
        findings.push(...fromFile.findings);
    }

    /** @type {SettingsMap} */
    let projectValues = {};
    if (workspaceRoot) {
        const project = readProjectFile(workspaceRoot);
        projectValues = project.values;
        findings.push(...project.findings);
    }

    /** @type {SettingsMap} */
    const settings = {};
    for (const [key, spec] of Object.entries(SCHEMA)) {
        if (projectValues[key] !== undefined) settings[key] = projectValues[key];
        else if (middle[key] !== undefined) settings[key] = middle[key];
        // Defaults are deep-copied so a consumer mutating an array cannot poison later reads.
        else settings[key] = spec.default === null || typeof spec.default !== 'object'
            ? spec.default
            : JSON.parse(JSON.stringify(spec.default));
    }

    return { settings, findings, projectValues };
}

/** @param {SettingsFinding[]} findings */
function hasErrorFindings(findings) {
    return findings.some(f => f.severity === 'error');
}

// The one-method slice of vscode.WorkspaceConfiguration the resolver helpers consume
// (pathResolver.ConfigLike), backed by resolved settings so every reader sees the full chain.
/**
 * @param {SettingsMap} settings
 * @returns {{get: (key: string, fallback?: any) => any}}
 */
function asConfigLike(settings) {
    return { get: (key, fallback) => (settings[key] === undefined ? fallback : settings[key]) };
}

// The settings bundle the resolver needs, in one place instead of assembled at each call
// site. createContext applies its own defaults, but every key here is always present.
/**
 * @param {SettingsMap} settings
 * @returns {{directoriesToScan: string[], ignoreDirectories: string[], pathPriority: string[], sourcemapPath: string, rojoProjectPath: string}}
 */
function resolverOptions(settings) {
    return {
        directoriesToScan: settings['directoriesToScan'] || [],
        ignoreDirectories: settings['ignoreDirectories'] || [],
        pathPriority: settings['pathPriority'] || [],
        sourcemapPath: settings['sourcemapPath'],
        rojoProjectPath: settings['rojoProjectPath']
    };
}

// The resolver bundle plus everything runBuild needs. `overrides` carries the caller's
// intent (dryRun for a Check, an output directory the command chose).
/**
 * @param {SettingsMap} settings
 * @param {{outputDirectory?: string, outputRequireStyle?: string, dryRun?: boolean}} [overrides]
 * @returns {import('../features/buildProject').BuildOptions}
 */
function buildOptions(settings, overrides = {}) {
    return {
        ...resolverOptions(settings),
        importModulePaths: settings['importModulePaths'] || [],
        outputDirectory: settings['buildConversion.outputDirectory'],
        outputRequireStyle: settings['buildConversion.outputRequireStyle'],
        ...overrides
    };
}

/** @param {string} workspaceRoot */
function projectFileExists(workspaceRoot) {
    return fs.existsSync(path.join(workspaceRoot, PROJECT_SETTINGS_FILE));
}

/**
 * Writes one project-scope setting into requireonrails.json, creating the file (with its
 * $schema line) when absent. Used by the first-run mode prompt and the Menu's mode switch,
 * which make the project file the canonical home of the choice (ADR 0004).
 * ponytail: re-serializes the file, so hand-written comments are dropped on programmatic
 * writes. Confine a comment-preserving edit here if that ever matters.
 * @param {string} workspaceRoot
 * @param {string} key - Dotted project-scope key
 * @param {any} value
 */
function writeProjectSetting(workspaceRoot, key, value) {
    if (!isProjectKey(key)) throw new Error(`"${key}" is not a project-scope setting`);

    const filePath = path.join(workspaceRoot, PROJECT_SETTINGS_FILE);
    /** @type {Record<string, any>} */
    let parsed = { $schema: PROJECT_SCHEMA_URL };
    if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf8');
        parsed = raw.trim() ? parseJsonc(raw) : parsed;
        if (typeOf(parsed) !== 'object') throw new Error(`${PROJECT_SETTINGS_FILE} must contain a JSON object`);
    }

    const segments = key.split('.');
    let node = parsed;
    for (const segment of segments.slice(0, -1)) {
        if (typeOf(node[segment]) !== 'object') node[segment] = {};
        node = node[segment];
    }
    node[segments[segments.length - 1]] = value;

    fs.writeFileSync(filePath, `${JSON.stringify(parsed, null, 4)}\n`);
}

module.exports = {
    PROJECT_SETTINGS_FILE,
    parseJsonc,
    readProjectFile,
    resolveSettings,
    hasErrorFindings,
    asConfigLike,
    resolverOptions,
    buildOptions,
    projectFileExists,
    writeProjectSetting
};
