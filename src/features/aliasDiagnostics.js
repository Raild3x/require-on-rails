const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { debug, warn } = require('../core/logger');
const { compileIgnorePatterns, findIgnoreMatch } = require('./updateLuaFileAliases');

const supportedExtensions = ['.lua', '.luau'];

// Matches require("@Alias") / require('@Alias/Sub/Path'). Only @-prefixed strings are alias
// requires; RequireOnRails passes anything else through to Roblox's own require.
const ALIAS_REQUIRE = /require\s*\(\s*(['"])(@[^'"]*)\1\s*\)/g;

// Luau's own reserved alias for "relative to this file", never present in .luaurc.
const RESERVED_ALIASES = new Set(['self']);

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

function buildDiagnostic(unresolved) {
    const ambiguousPaths = _ambiguousAliases[unresolved.aliasName];
    const message = ambiguousPaths
        ? `RequireOnRails: "${unresolved.aliasPath}" has no alias because "${unresolved.aliasName}" is ambiguous — ` +
          `${ambiguousPaths.length} files share that name (${ambiguousPaths.join(', ')}). ` +
          `Rename one, or add a require-on-rails.pathPriority prefix to pick a winner.`
        : `RequireOnRails: alias "${unresolved.aliasName}" is not defined in .luaurc. ` +
          `Check the file exists under require-on-rails.directoriesToScan and is not excluded by ignoreDirectories.`;

    const diagnostic = new vscode.Diagnostic(
        new vscode.Range(
            new vscode.Position(unresolved.line, unresolved.startColumn),
            new vscode.Position(unresolved.line, unresolved.endColumn)
        ),
        message,
        vscode.DiagnosticSeverity.Warning
    );
    diagnostic.source = 'RequireOnRails';
    diagnostic.code = ambiguousPaths ? 'ambiguous-alias' : 'unknown-alias';
    return diagnostic;
}

// Collects every .lua/.luau file under the configured scan roots, pruning the same
// directories alias generation prunes.
function collectSourceFiles(workspaceRoot, directoriesToScan, ignorePatterns) {
    const files = [];

    function walk(dir, rootDir) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            debug(`aliasDiagnostics: could not read "${dir}" (${e.message})`);
            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const relPath = path.relative(workspaceRoot, fullPath).replace(/\\/g, '/');
                if (findIgnoreMatch(ignorePatterns, entry.name, relPath)) continue;
                walk(fullPath, rootDir);
            } else if (entry.isFile() && supportedExtensions.includes(path.extname(entry.name))) {
                files.push(fullPath);
            }
        }
    }

    for (const dir of directoriesToScan) {
        const absolute = path.join(workspaceRoot, dir);
        if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
            walk(absolute, absolute);
        }
    }

    return files;
}

// Re-reads .luaurc and re-reports unresolved alias requires across the workspace.
// Text for open documents comes from the editor so unsaved edits are reflected.
//
// ponytail: re-reads every source file on each call, which is fine at Roblox project scale
// (hundreds of files) and rides the existing 500ms alias debounce. If this shows up in a
// profile, cache by mtime.
function refreshAliasDiagnostics() {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) return;

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const aliasNames = readAliasNames(workspaceRoot);
    if (!aliasNames) return;

    const config = vscode.workspace.getConfiguration('require-on-rails');
    const directoriesToScan = config.get('directoriesToScan') || [];
    const ignorePatterns = compileIgnorePatterns(config.get('ignoreDirectories') || []);

    const collection = getCollection();
    collection.clear();

    const openTexts = new Map();
    vscode.workspace.textDocuments.forEach(doc => {
        if (doc.uri.scheme === 'file') openTexts.set(doc.uri.fsPath, doc.getText());
    });

    let totalUnresolved = 0;
    let filesWithIssues = 0;

    for (const filePath of collectSourceFiles(workspaceRoot, directoriesToScan, ignorePatterns)) {
        let text = openTexts.get(filePath);
        if (text === undefined) {
            try {
                text = fs.readFileSync(filePath, 'utf8');
            } catch (e) {
                debug(`aliasDiagnostics: could not read "${filePath}" (${e.message})`);
                continue;
            }
        }

        const unresolved = findUnresolvedAliases(text, aliasNames);
        if (unresolved.length === 0) continue;

        collection.set(vscode.Uri.file(filePath), unresolved.map(buildDiagnostic));
        totalUnresolved += unresolved.length;
        filesWithIssues++;
    }

    if (totalUnresolved > 0) {
        warn(`${totalUnresolved} unresolved alias require(s) across ${filesWithIssues} file(s). See the Problems panel.`);
    } else {
        debug('aliasDiagnostics: no unresolved alias requires.');
    }

    return { totalUnresolved, filesWithIssues };
}

module.exports = {
    refreshAliasDiagnostics,
    setAmbiguousAliases,
    clearAliasDiagnostics,
    disposeAliasDiagnostics,
    findUnresolvedAliases
};
