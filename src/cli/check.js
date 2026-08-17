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
const { findUnresolvedAliases, findUnresolvedRequires, unresolvedAliasMessage } = require('../features/aliasDiagnostics');
const manifest = require('../../package.json');

// Settings the checks depend on. Everything else the extension contributes is editor
// behavior with no bearing on whether the code resolves.
const CONFIG_KEYS = [
    'mode',
    'directoriesToScan',
    'ignoreDirectories',
    'manualAliases',
    'pathPriority',
    'rojoProjectPath'
];

// Raised for problems with the run itself (unreadable settings, bad .luaurc) as opposed to
// findings about the code. These fail the job even under warn-only: a checker that could not
// read its own configuration has not checked anything.
class ConfigError extends Error {}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

// GitHub passes action inputs as INPUT_<NAME> with the name uppercased and dashes kept.
// The argv forms exist so the same checks can be run locally and from tests.
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
function defaultFor(key) {
    const property = manifest.contributes.configuration.properties[`require-on-rails.${key}`];
    return property ? property.default : undefined;
}

/**
 * Reads `<workingDir>/.vscode/settings.json`, falling back per key to the manifest defaults.
 * VS Code writes settings as flat dotted keys, which is the only form read here.
 */
function loadConfig(workingDir) {
    const settingsPath = path.join(workingDir, '.vscode', 'settings.json');
    let settings = {};

    if (fs.existsSync(settingsPath)) {
        let raw;
        try {
            raw = fs.readFileSync(settingsPath, 'utf8');
        } catch (e) {
            throw new ConfigError(`could not read ${toPosix(settingsPath)}: ${e.message}`);
        }
        try {
            settings = raw.trim() ? parseJsonc(raw) : {};
        } catch (e) {
            throw new ConfigError(`could not parse ${toPosix(settingsPath)}: ${e.message}`);
        }
    } else {
        console.log(`No ${toPosix(settingsPath)} found — checking with the extension's default settings.`);
    }

    const config = {};
    for (const key of CONFIG_KEYS) {
        const value = settings[`require-on-rails.${key}`];
        config[key] = value === undefined ? defaultFor(key) : value;
    }
    return config;
}

// The extension's helpers take a VS Code configuration object; in CI the values are already
// plain, so this is all of that interface they use.
function asConfigObject(config) {
    return { get: (key, fallback) => (config[key] === undefined ? fallback : config[key]) };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function toPosix(p) {
    return p.replace(/\\/g, '/');
}

// Alias values are compared, not just their names, so a moved file is caught as drift.
function normalizeAliasMap(aliases) {
    const out = {};
    for (const [key, value] of Object.entries(aliases || {})) {
        if (typeof value !== 'string') continue;
        out[key.replace(/^@/, '')] = toPosix(value).replace(/^\.\//, '').replace(/\/$/, '');
    }
    return out;
}

// Every finding is anchored to a file and position so it can be rendered as an annotation on
// the pull request diff. Positions are 0-based here, matching the extension's finding objects.
function makeFinding(file, line, column, endColumn, code, message) {
    return { file: toPosix(file), line, column, endColumn, code, message };
}

// An ambiguous basename produces no alias at all, so it is reported against the conflicting
// files themselves — those are what a reviewer has to change.
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
function checkDynamicRequires(workingDir, config, aliases, ambiguousAliases) {
    const aliasNames = new Set(Object.keys(aliases).map(key => key.replace(/^@/, '')));
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
function checkLuaurcDrift(workingDir, aliases) {
    const luaurcPath = path.join(workingDir, '.luaurc');
    if (!fs.existsSync(luaurcPath)) return [];

    let parsed;
    try {
        const raw = fs.readFileSync(luaurcPath, 'utf8');
        parsed = raw.trim() ? parseJsonc(raw) : {};
    } catch (e) {
        throw new ConfigError(`could not parse ${toPosix(path.join(workingDir, '.luaurc'))}: ${e.message}`);
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

/**
 * Runs every check appropriate to the project's mode.
 * @param {string} workingDir - Project root containing .vscode/settings.json
 * @returns {object[]} Findings, empty when the project is clean
 */
function runChecks(workingDir) {
    const config = loadConfig(workingDir);

    // Explicit mode writes full paths into source and never generates aliases, so duplicate
    // basenames are legal and there is no .luaurc of ours to have drifted. Resolution is the
    // only thing to verify — and it verifies far more than dynamic mode can.
    if (config.mode === 'explicit') {
        const ctx = pathResolver.createContext(workingDir, config);
        const findings = [];
        for (const [filePath, text] of pathResolver.readSourceTexts(workingDir, asConfigObject(config))) {
            const fromRel = toPosix(path.relative(workingDir, filePath));
            for (const unresolved of findUnresolvedRequires(text, fromRel, ctx)) {
                findings.push(makeFinding(fromRel, unresolved.line, unresolved.startColumn,
                    unresolved.endColumn, 'unresolved-require', unresolved.message));
            }
        }
        return findings;
    }

    const { basenameMap } = buildBasenameMap(workingDir, config);
    const { aliases, ambiguousAliases } = classifyBasenames(basenameMap, config);

    return [
        ...checkAmbiguous(ambiguousAliases),
        ...checkDynamicRequires(workingDir, config, aliases, ambiguousAliases),
        ...checkLuaurcDrift(workingDir, aliases)
    ];
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function escapeData(value) {
    return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProperty(value) {
    return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

// GitHub turns these lines into annotations on the pull request diff. Paths must be relative
// to the repository root, and positions are 1-based.
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

function summarize(findings) {
    const counts = findings.reduce((acc, f) => {
        acc[f.code] = (acc[f.code] || 0) + 1;
        return acc;
    }, {});
    return Object.keys(counts).sort().map(code => `${counts[code]} ${code}`).join(', ');
}

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

function main(argv = process.argv.slice(2)) {
    const workingDirArg = getInput('working-directory', argv) || '.';
    const warnOnly = getInput('warn-only', argv) === 'true';
    const workingDir = path.resolve(process.cwd(), workingDirArg);

    if (!fs.existsSync(workingDir)) {
        console.log(`::error::RequireOnRails: working-directory "${workingDirArg}" does not exist.`);
        return 1;
    }

    let findings;
    try {
        findings = runChecks(workingDir);
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
