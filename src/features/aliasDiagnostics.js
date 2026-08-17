const fs = require('fs');
const path = require('path');
// Optional — see updateLuaFileAliases.js. The finding and message functions are pure; only
// the Diagnostic-building and collection functions touch the editor.
let vscode = null;
try { vscode = require('vscode'); } catch (e) { /* running outside VS Code */ }
const { debug, warn } = require('../core/logger');

const { getMode, getExplicitPathStyle, runtimeModuleRequired } = require('../utils/workspaceUtils');
const pathResolver = require('./pathResolver');

// Matches require("@Alias") / require('@Alias/Sub/Path'). Only @-prefixed strings are alias
// requires; RequireOnRails passes anything else through to Roblox's own require.
const ALIAS_REQUIRE = /require\s*\(\s*(['"])(@[^'"]*)\1\s*\)/g;

// Luau's own built-in aliases ("relative to this file" / the DataModel root), never present in .luaurc.
const RESERVED_ALIASES = new Set(['self', 'game']);

// A single collection, so re-running replaces the previous results instead of stacking them.
let _collection = null;

// Remembered from the last alias generation so a diagnostic can explain *why* an alias is
// missing (ambiguous vs simply not there). Refreshes triggered by a file save reuse it.
let _ambiguousAliases = {};

function getCollection() {
    if (!_collection) {
        _collection = vscode.languages.createDiagnosticCollection('require-on-rails');
    }
    return _collection;
}

function setAmbiguousAliases(ambiguousAliases) {
    _ambiguousAliases = ambiguousAliases || {};
}

function clearAliasDiagnostics() {
    if (_collection) _collection.clear();
}

function disposeAliasDiagnostics() {
    if (!_collection) return;
    _collection.dispose();
    _collection = null;
}

// Alias keys are accepted both bare ("Shared") and @-prefixed ("@Shared"), because Luau
// accepts both in .luaurc and this extension's own defaults have used each form.
function readAliasNames(workspaceRoot) {
    const luaurcPath = path.join(workspaceRoot, '.luaurc');
    if (!fs.existsSync(luaurcPath)) return null;

    let parsed;
    try {
        const raw = fs.readFileSync(luaurcPath, 'utf8');
        parsed = raw ? JSON.parse(raw) : {};
    } catch (e) {
        // generateFileAliases already surfaces a parse failure to the user; stay quiet here.
        debug(`aliasDiagnostics: skipping, .luaurc could not be parsed (${e.message})`);
        return null;
    }

    const aliases = parsed && parsed.aliases ? parsed.aliases : {};
    return new Set(Object.keys(aliases).map(key => key.replace(/^@/, '')));
}

// Finds every unresolvable alias require in one file's text.
// Lines are scanned individually so the line/column for the diagnostic falls out for free,
// and full-line comments are skipped so commented-out code is not reported.
function findUnresolvedAliases(text, aliasNames) {
    const found = [];

    text.split(/\r?\n/).forEach((line, lineIndex) => {
        if (line.trimStart().startsWith('--')) return;

        ALIAS_REQUIRE.lastIndex = 0;
        let match;
        while ((match = ALIAS_REQUIRE.exec(line)) !== null) {
            const aliasPath = match[2];
            // Only the first segment is the alias; the rest is a path inside it.
            const aliasName = aliasPath.slice(1).split('/')[0];
            if (!aliasName || RESERVED_ALIASES.has(aliasName)) continue;
            if (aliasNames.has(aliasName)) continue;

            // Point the squiggle at the alias string itself, not the whole require call.
            const startColumn = match.index + match[0].indexOf(aliasPath);
            found.push({
                aliasName,
                aliasPath,
                line: lineIndex,
                startColumn,
                endColumn: startColumn + aliasPath.length
            });
        }
    });

    return found;
}

// Explains one unresolved alias, distinguishing "dropped because ambiguous" from "no such
// module". Pure, so the CI checker reports these in exactly the words the editor uses.
function unresolvedAliasMessage(unresolved, ambiguousAliases) {
    const ambiguousPaths = ambiguousAliases[unresolved.aliasName];
    return {
        code: ambiguousPaths ? 'ambiguous-alias' : 'unknown-alias',
        message: ambiguousPaths
            ? `RequireOnRails: "${unresolved.aliasPath}" has no alias because "${unresolved.aliasName}" is ambiguous — ` +
              `${ambiguousPaths.length} files share that name (${ambiguousPaths.join(', ')}). ` +
              `Rename one, or add a require-on-rails.pathPriority prefix to pick a winner.`
            : `RequireOnRails: alias "${unresolved.aliasName}" is not defined in .luaurc. ` +
              `Check the file exists under require-on-rails.directoriesToScan and is not excluded by ignoreDirectories.`
    };
}

function buildDiagnostic(unresolved) {
    const { message, code } = unresolvedAliasMessage(unresolved, _ambiguousAliases);

    const diagnostic = new vscode.Diagnostic(
        new vscode.Range(
            new vscode.Position(unresolved.line, unresolved.startColumn),
            new vscode.Position(unresolved.line, unresolved.endColumn)
        ),
        message,
        vscode.DiagnosticSeverity.Warning
    );
    diagnostic.source = 'RequireOnRails';
    diagnostic.code = code;
    return diagnostic;
}

// Dynamic mode: re-reads .luaurc and reports requires whose alias root is missing.
function refreshDynamicDiagnostics(workspaceRoot, config, collection) {
    const aliasNames = readAliasNames(workspaceRoot);
    if (!aliasNames) return;

    collection.clear();

    let totalUnresolved = 0;
    let filesWithIssues = 0;

    for (const [filePath, text] of pathResolver.readSourceTexts(workspaceRoot, config)) {
        const unresolved = findUnresolvedAliases(text, aliasNames);
        if (unresolved.length === 0) continue;

        collection.set(vscode.Uri.file(filePath), unresolved.map(buildDiagnostic));
        totalUnresolved += unresolved.length;
        filesWithIssues++;
    }

    return { totalUnresolved, filesWithIssues };
}

// Finds every require string in one file that explicit mode cannot resolve to a real module
// file (alias root lookup + path walk, ./ ../ resolution, @game via the Rojo mapping). A bare
// "@name" matching a known module basename is skipped: auto-replace will rewrite it, so
// flagging it would just flicker while the user types. 'unverifiable' resolutions stay silent.
//
// Pure, so the CI checker validates explicit-mode requires by the same rules and words.
function findUnresolvedRequires(text, fromFileRel, ctx) {
    const found = [];

    for (const occurrence of pathResolver.findRequireStrings(text)) {
        const spec = occurrence.spec;

        // Bare short name that auto-replace will handle (or that names a real alias).
        if (spec.startsWith('@') && !spec.includes('/')) {
            const name = spec.slice(1);
            if (pathResolver.RESERVED_ALIASES.has(name)) continue;
            if (ctx.aliases[name] !== undefined) continue;
            if (ctx.targets[name] && ctx.targets[name].length > 0) continue;
            found.push({
                ...occurrence,
                message: `RequireOnRails: "${spec}" matches no known module or alias. ` +
                    `Check the file exists under require-on-rails.directoriesToScan and is not excluded by ignoreDirectories.`
            });
            continue;
        }

        const resolution = pathResolver.resolveRequire(spec, fromFileRel, ctx);
        if (resolution.status === 'unresolved') {
            found.push({
                ...occurrence,
                message: `RequireOnRails: "${spec}" does not resolve — ${resolution.message}.`
            });
        }
    }

    return found;
}

// Explicit mode: full-resolution validation of every require string in the workspace.
function refreshExplicitDiagnostics(workspaceRoot, config, collection) {
    const ctx = pathResolver.getContext() || pathResolver.refreshContext();
    if (!ctx) return;

    collection.clear();

    let totalUnresolved = 0;
    let filesWithIssues = 0;

    for (const [filePath, text] of pathResolver.readSourceTexts(workspaceRoot, config)) {
        const fromRel = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
        const unresolved = findUnresolvedRequires(text, fromRel, ctx);
        if (unresolved.length === 0) continue;

        collection.set(vscode.Uri.file(filePath), unresolved.map(u => makeExplicitDiagnostic(u, u.message)));
        totalUnresolved += unresolved.length;
        filesWithIssues++;
    }

    return { totalUnresolved, filesWithIssues };
}

function makeExplicitDiagnostic(found, message) {
    const diagnostic = new vscode.Diagnostic(
        new vscode.Range(
            new vscode.Position(found.line, found.startColumn),
            new vscode.Position(found.line, found.endColumn)
        ),
        message,
        vscode.DiagnosticSeverity.Warning
    );
    diagnostic.source = 'RequireOnRails';
    diagnostic.code = 'unresolved-require';
    return diagnostic;
}

// Settings that are explicitly set in workspace settings but ignored by the current
// mode/style get a Warning on .vscode/settings.json. VS Code has no API to conditionally
// mark a setting invalid, so diagnostics on the settings file are the standard workaround.
function collectIgnoredSettings() {
    const mode = getMode();
    const style = getExplicitPathStyle();
    const ignored = [];

    if (mode === 'explicit') {
        const why = 'ignored in explicit mode';
        ignored.push(
            { key: 'manualAliases', why: `${why} — alias roots are read from .luaurc, which you maintain yourself` },
            { key: 'onAliasesRegenerated', why: `${why} — aliases are never regenerated` },
            { key: 'enableBasenameUpdates', why: `${why} — renames rewrite full paths instead of basenames` },
            { key: 'enableAbsolutePathUpdates', why: `${why} — renames rewrite full paths instead` },
            { key: 'enableFileNameCollisionResolution', why: `${why} — duplicate basenames are allowed in explicit mode` }
        );
    } else {
        const why = 'only used in explicit mode';
        ignored.push(
            { key: 'explicitPathStyle', why },
            { key: 'preferRelativePaths', why },
            { key: 'rojoProjectPath', why }
        );
    }

    if (!runtimeModuleRequired()) {
        const why = `the RequireOnRails Luau module is not used with mode "${mode}" and path style "${style}", so this setting has no effect`;
        ['tryToAddImportRequire', 'importOpacity', 'importModulePaths', 'contextualImportTemplate', 'preferredImportPlacement']
            .forEach(key => ignored.push({ key, why }));
    }

    return ignored;
}

function refreshSettingsDiagnostics(workspaceRoot, collection) {
    const settingsPath = path.join(workspaceRoot, '.vscode', 'settings.json');
    const settingsUri = vscode.Uri.file(settingsPath);

    let text = null;
    const openDoc = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === settingsPath);
    if (openDoc) {
        text = openDoc.getText();
    } else if (fs.existsSync(settingsPath)) {
        try {
            text = fs.readFileSync(settingsPath, 'utf8');
        } catch (e) {
            debug(`aliasDiagnostics: could not read settings.json (${e.message})`);
        }
    }
    if (text === null) {
        collection.set(settingsUri, []);
        return;
    }

    const config = vscode.workspace.getConfiguration('require-on-rails');
    const diagnostics = [];

    for (const { key, why } of collectIgnoredSettings()) {
        const inspected = config.inspect(key);
        // Only workspace-set values can get a squiggle in the workspace settings file.
        if (!inspected || (inspected.workspaceValue === undefined && inspected.workspaceFolderValue === undefined)) continue;

        // Flat dotted key is how VS Code writes settings; bare key covers hand-nested form.
        const needle = `"require-on-rails.${key}"`;
        let index = text.indexOf(needle);
        let length = needle.length;
        if (index === -1) {
            const bare = `"${key}"`;
            index = text.indexOf(bare);
            length = bare.length;
        }
        if (index === -1) continue;

        const before = text.slice(0, index);
        const line = (before.match(/\n/g) || []).length;
        const column = index - (before.lastIndexOf('\n') + 1);

        const diagnostic = new vscode.Diagnostic(
            new vscode.Range(new vscode.Position(line, column), new vscode.Position(line, column + length)),
            `RequireOnRails: "${key}" is ${why}.`,
            vscode.DiagnosticSeverity.Warning
        );
        diagnostic.source = 'RequireOnRails';
        diagnostic.code = 'ignored-setting';
        diagnostics.push(diagnostic);
    }

    collection.set(settingsUri, diagnostics);
}

// Re-reports unresolved requires across the workspace, branching on mode: dynamic checks
// alias roots against .luaurc, explicit fully resolves every require string. Also flags
// workspace settings the current mode ignores.
//
// ponytail: re-reads every source file on each call, which is fine at Roblox project scale
// (hundreds of files) and rides the existing 500ms alias debounce. If this shows up in a
// profile, cache by mtime.
function refreshAliasDiagnostics() {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) return;

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const config = vscode.workspace.getConfiguration('require-on-rails');
    const collection = getCollection();

    const result = getMode() === 'explicit'
        ? refreshExplicitDiagnostics(workspaceRoot, config, collection)
        : refreshDynamicDiagnostics(workspaceRoot, config, collection);

    refreshSettingsDiagnostics(workspaceRoot, collection);

    if (!result) return result;
    if (result.totalUnresolved > 0) {
        warn(`${result.totalUnresolved} unresolved require(s) across ${result.filesWithIssues} file(s). See the Problems panel.`);
    } else {
        debug('aliasDiagnostics: no unresolved requires.');
    }
    return result;
}

module.exports = {
    refreshAliasDiagnostics,
    setAmbiguousAliases,
    clearAliasDiagnostics,
    disposeAliasDiagnostics,
    findUnresolvedAliases,
    // Pure detection/reporting, shared with the CI checker so both speak the same words.
    findUnresolvedRequires,
    unresolvedAliasMessage,
    readAliasNames
};
