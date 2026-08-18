#!/usr/bin/env node
//
// RequireOnRails CI checker — the entry point of the GitHub Action declared in action.yml,
// and runnable directly:
//
//   node src/cli/check.js [--working-directory <dir>] [--warn-only]
//
// Reports the problems the extension reports in the editor, for a checkout with no editor:
// ambiguous aliases, requires that do not resolve, and (dynamic mode) a committed .luaurc
// that no longer matches what regeneration would produce.
//
// The alias set is always derived from the file tree and settings, never read from .luaurc —
// projects using dynamic mode routinely gitignore .luaurc because it changes on every file
// move, so it cannot be the source of truth here.

const fs = require('fs');
const path = require('path');

const { buildBasenameMap, classifyBasenames } = require('../features/updateLuaFileAliases');
const pathResolver = require('../features/pathResolver');
const { findUnresolvedAliases, findUnresolvedRequires, unresolvedAliasMessage, findStaleImportLines } = require('../features/aliasDiagnostics');
const { runBuild } = require('../features/buildProject');
const manifest = require('../../package.json');

// Settings the checks depend on. Everything else the extension contributes is editor
// behavior with no bearing on whether the code resolves.
const CONFIG_KEYS = [
    'mode',
    'directoriesToScan',
    'ignoreDirectories',
    'manualAliases',
    'pathPriority',
    'rojoProjectPath',
    'sourcemapPath',
    'importModulePaths',
    'buildConversion.enabled',
    'buildConversion.outputRequireStyle'
];

// Raised for problems with the run itself (unreadable settings, bad .luaurc) as opposed to
// findings about the code. These fail the job even under warn-only: a checker that could not
// read its own configuration has not checked anything.
class ConfigError extends Error {}

/**
 * The settings this checker reads, after per-key fallback to the manifest defaults. Values
 * originate in JSON, so these types are the shape the extension contributes, not a guarantee.
 * @typedef {object} CheckerConfig
 * @property {string} [mode]
 * @property {string[]} [directoriesToScan]
 * @property {string[]} [ignoreDirectories]
 * @property {Object<string, string>} [manualAliases]
 * @property {string[]} [pathPriority]
 * @property {string} [rojoProjectPath]
 * @property {string} [sourcemapPath]
 */

/**
 * One problem to report, positioned 0-based like the extension's finding objects.
 * @typedef {object} Finding
 * @property {string} file
 * @property {number} line
 * @property {number} column
 * @property {number} endColumn
 * @property {string} code
 * @property {string} message
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

// GitHub passes action inputs as INPUT_<NAME> with the name uppercased and dashes kept.
// The argv forms exist so the same checks can be run locally and from tests.
/**
 * @param {string} name
 * @param {string[]} argv
 * @returns {string | undefined}
 */
function getInput(name, argv) {
    const fromEnv = process.env[`INPUT_${name.toUpperCase()}`];
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv;

    const flag = `--${name}`;
    const index = argv.indexOf(flag);
    if (index !== -1) {
        const next = argv[index + 1];
        return next && !next.startsWith('--') ? next : 'true';
    }
    const inline = argv.find(arg => arg.startsWith(`${flag}=`));
    return inline ? inline.slice(flag.length + 1) : undefined;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

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

// Defaults come from the extension manifest rather than a second copy here, so the checker
// cannot disagree with the editor about what an unset setting means.
/**
 * @param {string} key
 * @returns {any} The manifest default, or undefined for a key the manifest does not contribute
 */
function defaultFor(key) {
    const property = /** @type {Record<string, {default?: any}>} */ (
        manifest.contributes.configuration.properties)[`require-on-rails.${key}`];
    return property ? property.default : undefined;
}

/**
 * Reads `<workingDir>/.vscode/settings.json`, falling back per key to the manifest defaults.
 * VS Code writes settings as flat dotted keys, which is the only form read here.
 * @param {string} workingDir
 * @returns {CheckerConfig}
 */
function loadConfig(workingDir) {
    const settingsPath = path.join(workingDir, '.vscode', 'settings.json');
    /** @type {Record<string, any>} */
    let settings = {};

    if (fs.existsSync(settingsPath)) {
        let raw;
        try {
            raw = fs.readFileSync(settingsPath, 'utf8');
        } catch (e) {
            throw new ConfigError(`could not read ${toPosix(settingsPath)}: ${e instanceof Error ? e.message : String(e)}`);
        }
        try {
            settings = raw.trim() ? parseJsonc(raw) : {};
        } catch (e) {
            throw new ConfigError(`could not parse ${toPosix(settingsPath)}: ${e instanceof Error ? e.message : String(e)}`);
        }
    } else {
        console.log(`No ${toPosix(settingsPath)} found — checking with the extension's default settings.`);
    }

    /** @type {Record<string, any>} */
    const config = {};
    for (const key of CONFIG_KEYS) {
        const value = settings[`require-on-rails.${key}`];
        config[key] = value === undefined ? defaultFor(key) : value;
    }
    return config;
}

// The extension's helpers take a VS Code configuration object; in CI the values are already
// plain, so this is all of that interface they use.
/**
 * @param {Record<string, any>} config
 * @returns {import('../features/pathResolver').ConfigLike}
 */
function asConfigObject(config) {
    return { get: (key, fallback) => (config[key] === undefined ? fallback : config[key]) };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** @param {string} p */
function toPosix(p) {
    return p.replace(/\\/g, '/');
}

// Alias values are compared, not just their names, so a moved file is caught as drift.
/**
 * @param {Object<string, unknown> | null | undefined} aliases
 * @returns {Record<string, string>}
 */
function normalizeAliasMap(aliases) {
    /** @type {Record<string, string>} */
    const out = {};
    for (const [key, value] of Object.entries(aliases || {})) {
        if (typeof value !== 'string') continue;
        out[key.replace(/^@/, '')] = toPosix(value).replace(/^\.\//, '').replace(/\/$/, '');
    }
    return out;
}

// Every finding is anchored to a file and position so it can be rendered as an annotation on
// the pull request diff. Positions are 0-based here, matching the extension's finding objects.
/**
 * @param {string} file
 * @param {number} line
 * @param {number} column
 * @param {number} endColumn
 * @param {string} code
 * @param {string} message
 * @returns {Finding}
 */
function makeFinding(file, line, column, endColumn, code, message) {
    return { file: toPosix(file), line, column, endColumn, code, message };
}

// An ambiguous basename produces no alias at all, so it is reported against the conflicting
// files themselves — those are what a reviewer has to change.
/**
 * @param {Object<string, string[]>} ambiguousAliases
 * @returns {Finding[]}
 */
function checkAmbiguous(ambiguousAliases) {
    return Object.keys(ambiguousAliases).sort().map(name => {
        const paths = ambiguousAliases[name];
        return makeFinding(paths[0], 0, 0, 0, 'ambiguous-alias',
            `RequireOnRails: alias "${name}" is ambiguous — ${paths.length} files share that name ` +
            `(${paths.join(', ')}), so no alias is generated and every require("@${name}") fails to resolve. ` +
            `Rename one, or add a require-on-rails.pathPriority prefix to pick a winner.`);
    });
}

// Dynamic mode: an alias require is valid when its root is in the generated alias set.
/**
 * @param {string} workingDir
 * @param {CheckerConfig} config
 * @param {Object<string, string>} aliases
 * @param {Object<string, string[]>} ambiguousAliases
 * @returns {Finding[]}
 */
function checkDynamicRequires(workingDir, config, aliases, ambiguousAliases) {
    const aliasNames = new Set(Object.keys(aliases).map(key => key.replace(/^@/, '')));
    /** @type {Finding[]} */
    const findings = [];

    for (const [filePath, text] of pathResolver.readSourceTexts(workingDir, asConfigObject(config))) {
        const relative = path.relative(workingDir, filePath);
        for (const unresolved of findUnresolvedAliases(text, aliasNames)) {
            const { message, code } = unresolvedAliasMessage(unresolved, ambiguousAliases);
            findings.push(makeFinding(relative, unresolved.line, unresolved.startColumn, unresolved.endColumn, code, message));
        }
    }
    return findings;
}

// Only meaningful when .luaurc is committed. Dynamic-mode projects often gitignore it, and an
// absent file is not a problem to report — there is simply no cached copy to verify.
/**
 * @param {string} workingDir
 * @param {Object<string, string>} aliases
 * @returns {Finding[]}
 */
function checkLuaurcDrift(workingDir, aliases) {
    const luaurcPath = path.join(workingDir, '.luaurc');
    if (!fs.existsSync(luaurcPath)) return [];

    let parsed;
    try {
        const raw = fs.readFileSync(luaurcPath, 'utf8');
        parsed = raw.trim() ? parseJsonc(raw) : {};
    } catch (e) {
        throw new ConfigError(`could not parse ${toPosix(path.join(workingDir, '.luaurc'))}: ${e instanceof Error ? e.message : String(e)}`);
    }

    const committed = normalizeAliasMap(parsed.aliases);
    const generated = normalizeAliasMap(aliases);

    const missing = Object.keys(generated).filter(name => committed[name] === undefined).sort();
    const extra = Object.keys(committed).filter(name => generated[name] === undefined).sort();
    const changed = Object.keys(generated)
        .filter(name => committed[name] !== undefined && committed[name] !== generated[name])
        .sort();

    if (missing.length === 0 && extra.length === 0 && changed.length === 0) return [];

    const parts = [];
    if (missing.length) parts.push(`missing ${missing.length} (${missing.join(', ')})`);
    if (extra.length) parts.push(`${extra.length} no longer generated (${extra.join(', ')})`);
    if (changed.length) parts.push(`${changed.length} pointing elsewhere (${changed.map(n => `${n}: ${committed[n]} → ${generated[n]}`).join('; ')})`);

    return [makeFinding('.luaurc', 0, 0, 0, 'luaurc-drift',
        `RequireOnRails: the committed .luaurc aliases no longer match this file tree — ${parts.join(', ')}. ` +
        `Run "RequireOnRails: Regenerate Aliases" and commit the result, or gitignore .luaurc.`)];
}

// Build conversion checks: leftover Import boilerplate (a half-migrated project would ship
// the Wally module anyway), and — only when asked, since it converts every file — a dry-run
// of the actual build, so a require the build cannot convert fails in CI instead of at
// runtime. The dry run writes nothing.
/**
 * @param {string} workingDir
 * @param {CheckerConfig} config
 * @param {boolean} verifyBuild
 * @returns {Finding[]}
 */
function checkBuildConversion(workingDir, config, verifyBuild) {
    const raw = /** @type {Record<string, any>} */ (config);
    if (!raw['buildConversion.enabled']) return [];

    /** @type {Finding[]} */
    const findings = [];
    const importModulePaths = raw['importModulePaths'] || [];

    for (const [filePath, text] of pathResolver.readSourceTexts(workingDir, asConfigObject(raw))) {
        const relative = toPosix(path.relative(workingDir, filePath));
        for (const stale of findStaleImportLines(text, importModulePaths)) {
            findings.push(makeFinding(relative, stale.line, stale.startColumn, stale.endColumn,
                'stale-boilerplate', stale.message));
        }
    }

    if (verifyBuild) {
        const result = runBuild(workingDir, {
            directoriesToScan: raw['directoriesToScan'] || [],
            ignoreDirectories: raw['ignoreDirectories'] || [],
            pathPriority: raw['pathPriority'] || [],
            rojoProjectPath: raw['rojoProjectPath'],
            sourcemapPath: raw['sourcemapPath'],
            importModulePaths,
            outputDirectory: 'dist',
            outputRequireStyle: raw['buildConversion.outputRequireStyle'] || 'string',
            dryRun: true
        });
        for (const finding of result.findings) {
            findings.push(makeFinding(finding.file, finding.line, finding.column, finding.endColumn,
                finding.code, finding.message));
        }
    }

    return findings;
}

/**
 * Runs every check appropriate to the project's mode.
 * @param {string} workingDir - Project root containing .vscode/settings.json
 * @param {{verifyBuild?: boolean}} [options]
 * @returns {Finding[]} Findings, empty when the project is clean
 */
function runChecks(workingDir, { verifyBuild = false } = {}) {
    const config = loadConfig(workingDir);

    // Explicit mode writes full paths into source and never generates aliases, so duplicate
    // basenames are legal and there is no .luaurc of ours to have drifted. Resolution is the
    // only thing to verify — and it verifies far more than dynamic mode can.
    if (config.mode === 'explicit') {
        const ctx = pathResolver.createContext(workingDir, config);
        /** @type {Finding[]} */
        const findings = [];
        for (const [filePath, text] of pathResolver.readSourceTexts(workingDir, asConfigObject(config))) {
            const fromRel = toPosix(path.relative(workingDir, filePath));
            for (const unresolved of findUnresolvedRequires(text, fromRel, ctx)) {
                findings.push(makeFinding(fromRel, unresolved.line, unresolved.startColumn,
                    unresolved.endColumn, 'unresolved-require', unresolved.message));
            }
        }
        return [...findings, ...checkBuildConversion(workingDir, config, verifyBuild)];
    }

    const { basenameMap } = buildBasenameMap(workingDir, config);
    const { aliases, ambiguousAliases } = classifyBasenames(basenameMap, config);

    return [
        ...checkAmbiguous(ambiguousAliases),
        ...checkDynamicRequires(workingDir, config, aliases, ambiguousAliases),
        ...checkLuaurcDrift(workingDir, aliases),
        ...checkBuildConversion(workingDir, config, verifyBuild)
    ];
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** @param {unknown} value */
function escapeData(value) {
    return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** @param {unknown} value */
function escapeProperty(value) {
    return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

// GitHub turns these lines into annotations on the pull request diff. Paths must be relative
// to the repository root, and positions are 1-based.
/**
 * @param {'error' | 'warning'} level
 * @param {Finding} finding
 * @param {string} pathPrefix
 * @returns {string}
 */
function annotation(level, finding, pathPrefix) {
    const file = toPosix(path.join(pathPrefix, finding.file));
    const properties = [
        `file=${escapeProperty(file)}`,
        `line=${finding.line + 1}`,
        `col=${finding.column + 1}`,
        `endColumn=${finding.endColumn + 1}`,
        `title=${escapeProperty(`RequireOnRails (${finding.code})`)}`
    ].join(',');
    return `::${level} ${properties}::${escapeData(finding.message)}`;
}

/** @param {Finding[]} findings */
function summarize(findings) {
    const counts = findings.reduce((acc, f) => {
        acc[f.code] = (acc[f.code] || 0) + 1;
        return acc;
    }, /** @type {Record<string, number>} */ ({}));
    return Object.keys(counts).sort().map(code => `${counts[code]} ${code}`).join(', ');
}

/**
 * @param {Finding[]} findings
 * @param {string} workingDirArg - Path prefix for reported files, '' when the run is rooted here
 * @param {boolean} warnOnly
 */
function report(findings, workingDirArg, warnOnly) {
    const level = warnOnly ? 'warning' : 'error';

    for (const finding of findings) {
        console.log(annotation(level, finding, workingDirArg));
    }

    if (findings.length === 0) {
        console.log('RequireOnRails: no issues found.');
        return;
    }

    console.log('');
    console.log(`RequireOnRails: ${findings.length} finding(s) — ${summarize(findings)}.`);
    for (const finding of findings) {
        console.log(`  ${toPosix(path.join(workingDirArg, finding.file))}:${finding.line + 1}  ${finding.message}`);
    }
}

/**
 * @param {string[]} [argv]
 * @returns {0 | 1} Process exit code
 */
function main(argv = process.argv.slice(2)) {
    const workingDirArg = getInput('working-directory', argv) || '.';
    const warnOnly = getInput('warn-only', argv) === 'true';
    const verifyBuild = getInput('verify-build', argv) === 'true';
    const workingDir = path.resolve(process.cwd(), workingDirArg);

    if (!fs.existsSync(workingDir)) {
        console.log(`::error::RequireOnRails: working-directory "${workingDirArg}" does not exist.`);
        return 1;
    }

    let findings;
    try {
        findings = runChecks(workingDir, { verifyBuild });
    } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        console.log(`::error::RequireOnRails: ${escapeData(e.message)}`);
        return 1;
    }

    report(findings, workingDirArg === '.' ? '' : workingDirArg, warnOnly);
    return findings.length > 0 && !warnOnly ? 1 : 0;
}

if (require.main === module) {
    process.exitCode = main();
}

// Exported for the tests in test/cli; everything else is reached through the command line.
module.exports = { loadConfig, parseJsonc };
