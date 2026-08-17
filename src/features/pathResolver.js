const fs = require('fs');
const path = require('path');
// Optional — see updateLuaFileAliases.js. Resolution and rendering are pure; only
// refreshContext and the open-buffer preference in readSourceTexts touch the editor.
/** @type {typeof import('vscode') | null} */
let vscode = null;
try { vscode = require('vscode'); } catch (e) { /* running outside VS Code */ }
const { debug, warn } = require('../core/logger');
const { buildBasenameMap, compileIgnorePatterns, findIgnoreMatch } = require('./updateLuaFileAliases');

const supportedExtensions = ['.lua', '.luau'];

// Matches every require string form explicit mode can produce or consume: @-prefixed
// (alias, @self, @game) AND ./ ../ relative paths. This is a superset of aliasDiagnostics'
// ALIAS_REQUIRE — explicit-mode consumers must use this one, or relative-style requires
// become invisible to them.
const REQUIRE_STRING = /require\s*\(\s*(['"])((?:@|\.\.?\/)[^'"]*)\1\s*\)/g;

// Luau's built-in aliases, never present in .luaurc.
const RESERVED_ALIASES = new Set(['self', 'game']);

// ---------------------------------------------------------------------------
// Path primitives. Everything below works on workspace-root-relative, forward-slashed
// paths; callers normalize at the boundary.
// ---------------------------------------------------------------------------

function normalizeSlashes(p) {
    return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function stripExt(p) {
    return p.replace(/\.(luau|lua)$/, '');
}

// init.luau / init.server.luau / init.client.luau — the file that *is* its folder.
function isInitFile(fileRel) {
    const stem = stripExt(fileRel.split('/').pop());
    return stem === 'init' || stem === 'init.server' || stem === 'init.client';
}

// The requirable module path for a target file: extension stripped, and an init file
// collapses to its folder ("Dir/init.luau" -> "Dir").
function modulePathOf(targetRel) {
    const noExt = stripExt(targetRel);
    if (isInitFile(targetRel)) {
        return noExt.split('/').slice(0, -1).join('/');
    }
    return noExt;
}

// The directory relative requires resolve from. Per Luau require-by-string semantics an
// init file is identified with its folder, so its requires resolve from the folder's
// PARENT ("Dir/init.luau" writing "./Sibling" means a sibling of Dir, and children are
// reached via @self). Regular files resolve from their containing directory.
function baseDir(fileRel) {
    const parts = fileRel.split('/');
    const dropCount = isInitFile(fileRel) ? 2 : 1;
    return parts.slice(0, Math.max(0, parts.length - dropCount)).join('/');
}

function segments(p) {
    return p === '' ? [] : p.split('/');
}

function commonPrefixLength(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
}

// Resolve "."/".." segments against a base directory. Returns null if the path escapes
// the workspace root.
function resolveDots(baseDirRel, spec) {
    const out = segments(baseDirRel);
    for (const seg of spec.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') {
            if (out.length === 0) return null;
            out.pop();
        } else {
            out.push(seg);
        }
    }
    return out.join('/');
}

// ---------------------------------------------------------------------------
// Context: everything path resolution needs, cached between the debounced refreshes that
// already fire on file/settings/.luaurc/Rojo-project changes.
// ---------------------------------------------------------------------------

let _ctx = null;

function invalidateContext() {
    _ctx = null;
}

function getContext() {
    return _ctx;
}

// Alias keys are accepted bare ("Shared") and @-prefixed ("@Shared"), same as
// aliasDiagnostics.readAliasNames. Values are workspace-root-relative paths.
function readAliasMap(workspaceRoot) {
    const luaurcPath = path.join(workspaceRoot, '.luaurc');
    if (!fs.existsSync(luaurcPath)) return {};
    let parsed;
    try {
        const raw = fs.readFileSync(luaurcPath, 'utf8');
        parsed = raw ? JSON.parse(raw) : {};
    } catch (e) {
        debug(`pathResolver: .luaurc could not be parsed (${e.message}); no alias roots available.`);
        return {};
    }
    const aliases = {};
    for (const [key, value] of Object.entries(parsed && parsed.aliases ? parsed.aliases : {})) {
        if (typeof value !== 'string') continue;
        const name = key.replace(/^@/, '');
        aliases[name] = normalizeSlashes(value).replace(/\/$/, '');
    }
    return aliases;
}

// Walks a Rojo project tree collecting { fsPath, dmPath } at every string-valued $path.
// fsPath is extension-stripped so file nodes ("Import": {"$path": "src/Import.luau"})
// match module paths directly. Glob $path values and globIgnorePaths are not supported.
function parseRojoProject(workspaceRoot, rojoProjectPath) {
    const absolute = path.join(workspaceRoot, rojoProjectPath);
    if (!fs.existsSync(absolute)) return null;

    let project;
    try {
        project = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    } catch (e) {
        warn(`pathResolver: could not parse Rojo project "${rojoProjectPath}" (${e.message}); the 'game' path style will not resolve.`);
        return null;
    }
    if (!project || typeof project.tree !== 'object') return null;

    const map = [];
    function walk(node, dmSegments) {
        if (typeof node !== 'object' || node === null) return;
        const rawPath = node['$path'];
        if (typeof rawPath === 'string') {
            map.push({
                fsPath: stripExt(normalizeSlashes(rawPath).replace(/\/$/, '')),
                dmPath: dmSegments.join('/')
            });
        }
        for (const [key, child] of Object.entries(node)) {
            if (key.startsWith('$')) continue;
            walk(child, [...dmSegments, key]);
        }
    }
    walk(project.tree, []);
    return map;
}

// Builds a resolution context from a workspace root and plain setting values. Reuses
// buildBasenameMap so the module index has exactly the same semantics as dynamic mode's alias
// scan (folder-init collapse, .server/.client skip, ignoreDirectories pruning).
//
// Separate from refreshContext so the CI checker, which has no VS Code to read settings from,
// resolves requires exactly as the editor does.
function createContext(workspaceRoot, {
    directoriesToScan = [],
    ignoreDirectories = [],
    pathPriority = [],
    rojoProjectPath = 'default.project.json'
} = {}) {
    const { basenameMap } = buildBasenameMap(workspaceRoot, { directoriesToScan, ignoreDirectories });
    const targets = {};
    const targetSet = new Set();
    for (const [basename, arr] of Object.entries(basenameMap)) {
        targets[basename] = arr.map(entry => entry.path);
        arr.forEach(entry => targetSet.add(entry.path));
    }

    return {
        workspaceRoot,
        aliases: readAliasMap(workspaceRoot),
        rojoMap: parseRojoProject(workspaceRoot, rojoProjectPath),
        targets,
        targetSet,
        pathPriority: (Array.isArray(pathPriority) ? pathPriority : [])
            .filter(entry => typeof entry === 'string' && entry.length > 0)
            .map(entry => normalizeSlashes(entry))
    };
}

// Rebuilds the cached context from the current workspace and settings.
function refreshContext() {
    if (!vscode || !vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        _ctx = null;
        return null;
    }
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const config = vscode.workspace.getConfiguration('require-on-rails');

    _ctx = createContext(workspaceRoot, {
        directoriesToScan: config.get('directoriesToScan') || [],
        ignoreDirectories: config.get('ignoreDirectories') || [],
        pathPriority: config.get('pathPriority', []),
        rojoProjectPath: config.get('rojoProjectPath', 'default.project.json')
    });
    debug(`pathResolver: context refreshed — ${_ctx.targetSet.size} module(s), ${Object.keys(_ctx.aliases).length} alias root(s), rojo entries: ${_ctx.rojoMap ? _ctx.rojoMap.length : 'none'}`);
    return _ctx;
}

// Collects every .lua/.luau file under the configured scan roots, pruning the same
// directories alias generation prunes. (Moved here from aliasDiagnostics so explicit-mode
// features and diagnostics share one copy.)
function collectSourceFiles(workspaceRoot, directoriesToScan, ignorePatterns) {
    const files = [];

    function walk(dir) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            debug(`pathResolver: could not read "${dir}" (${e.message})`);
            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const relPath = path.relative(workspaceRoot, fullPath).replace(/\\/g, '/');
                if (findIgnoreMatch(ignorePatterns, entry.name, relPath)) continue;
                walk(fullPath);
            } else if (entry.isFile() && supportedExtensions.includes(path.extname(entry.name))) {
                files.push(fullPath);
            }
        }
    }

    for (const dir of directoriesToScan) {
        const absolute = path.join(workspaceRoot, dir);
        if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
            walk(absolute);
        }
    }

    return files;
}

// ---------------------------------------------------------------------------
// Resolution: require string -> target file
// ---------------------------------------------------------------------------

// A module path may denote "Foo.luau", "Foo.lua", or a folder with an init file. Probes the
// index first; falls back to disk for targets outside the scan roots (e.g. Packages/).
function probeModulePath(modulePath, ctx) {
    if (!modulePath) return null;
    const candidates = [
        `${modulePath}.luau`,
        `${modulePath}.lua`,
        `${modulePath}/init.luau`,
        `${modulePath}/init.lua`
    ];
    for (const candidate of candidates) {
        if (ctx.targetSet.has(candidate)) return candidate;
    }
    for (const candidate of candidates) {
        if (fs.existsSync(path.join(ctx.workspaceRoot, candidate))) return candidate;
    }
    return null;
}

/**
 * Resolves one require string to the module path it denotes, WITHOUT checking a file exists
 * there. Rename handling needs this to see where a now-dangling require used to point.
 * @returns {{status: 'path', modulePath: string}
 *         | {status: 'unverifiable'}
 *         | {status: 'unresolved', reason: string, message: string}}
 *   'unverifiable' means the spec cannot be checked against the filesystem (e.g. @self from
 *   a non-init file, @game with no Rojo project) — diagnostics must stay quiet about it.
 */
function resolveModulePath(spec, fromFileRel, ctx) {
    if (spec.startsWith('./') || spec.startsWith('../')) {
        const modulePath = resolveDots(baseDir(fromFileRel), spec);
        return modulePath === null
            ? { status: 'unresolved', reason: 'outside-workspace', message: `"${spec}" escapes the workspace root` }
            : { status: 'path', modulePath };
    }

    if (!spec.startsWith('@')) return { status: 'unverifiable' };

    const specSegments = spec.slice(1).split('/');
    const aliasName = specSegments[0];
    const rest = specSegments.slice(1);

    if (aliasName === 'self') {
        // @self is the requiring script itself. Only an init file has a filesystem
        // counterpart for its children; a plain ModuleScript's children live in the
        // DataModel, not on disk.
        if (!isInitFile(fromFileRel) || rest.length === 0) return { status: 'unverifiable' };
        const folder = stripExt(fromFileRel).split('/').slice(0, -1).join('/');
        const modulePath = resolveDots(folder, rest.join('/'));
        return modulePath === null
            ? { status: 'unresolved', reason: 'outside-workspace', message: `"${spec}" escapes the workspace root` }
            : { status: 'path', modulePath };
    }

    if (aliasName === 'game') {
        if (!ctx.rojoMap || rest.length === 0) return { status: 'unverifiable' };
        const dmPath = rest.join('/');
        // Longest dmPath prefix wins, matched on segment boundaries.
        let best = null;
        for (const entry of ctx.rojoMap) {
            if (dmPath === entry.dmPath || dmPath.startsWith(entry.dmPath + '/')) {
                if (!best || entry.dmPath.length > best.dmPath.length) best = entry;
            }
        }
        if (!best) {
            return { status: 'unresolved', reason: 'no-rojo-mapping', message: `no Rojo $path maps "${dmPath}"` };
        }
        const remainder = dmPath.slice(best.dmPath.length).replace(/^\//, '');
        return { status: 'path', modulePath: remainder ? `${best.fsPath}/${remainder}` : best.fsPath };
    }

    const aliasValue = ctx.aliases[aliasName];
    if (aliasValue === undefined) {
        return { status: 'unresolved', reason: 'unknown-alias', message: `alias "${aliasName}" is not defined in .luaurc` };
    }
    return { status: 'path', modulePath: rest.length > 0 ? `${aliasValue}/${rest.join('/')}` : aliasValue };
}

/**
 * Resolves one require string to a target file (resolveModulePath + existence probe).
 * @param {string} spec - The require string content, e.g. "@Shared/Stuff/myModule" or "./Sibling"
 * @param {string} fromFileRel - Workspace-relative path of the file containing the require
 * @param {object} ctx - Context from refreshContext()
 * @returns {{status: 'resolved', target: string}
 *         | {status: 'unverifiable'}
 *         | {status: 'unresolved', reason: string, message: string}}
 */
function resolveRequire(spec, fromFileRel, ctx) {
    const resolution = resolveModulePath(spec, fromFileRel, ctx);
    if (resolution.status !== 'path') return resolution;

    const target = probeModulePath(resolution.modulePath, ctx);
    return target
        ? { status: 'resolved', target }
        : { status: 'unresolved', reason: 'file-not-found', message: `no module found at "${resolution.modulePath}"` };
}

// Reads each source file under the scan roots, preferring open-editor text so unsaved
// edits are reflected (and so edit ranges are valid against the live buffer).
// Returns a Map of absolute file path -> text.
function readSourceTexts(workspaceRoot, config) {
    const directoriesToScan = config.get('directoriesToScan') || [];
    const ignorePatterns = compileIgnorePatterns(config.get('ignoreDirectories') || []);

    // No editor means no unsaved buffers to prefer; everything comes from disk below.
    const openTexts = new Map();
    if (vscode) {
        vscode.workspace.textDocuments.forEach(doc => {
            if (doc.uri.scheme === 'file') openTexts.set(doc.uri.fsPath, doc.getText());
        });
    }

    const texts = new Map();
    for (const filePath of collectSourceFiles(workspaceRoot, directoriesToScan, ignorePatterns)) {
        let text = openTexts.get(filePath);
        if (text === undefined) {
            try {
                text = fs.readFileSync(filePath, 'utf8');
            } catch (e) {
                debug(`pathResolver: could not read "${filePath}" (${e.message})`);
                continue;
            }
        }
        texts.set(filePath, text);
    }
    return texts;
}

// ---------------------------------------------------------------------------
// Rendering: target file -> require string
// ---------------------------------------------------------------------------

function renderRelative(modulePath, fromFileRel) {
    const base = segments(baseDir(fromFileRel));
    const moduleSegments = segments(modulePath);
    // Navigate to the module's parent, then into its name — uniform for all cases,
    // including requiring the folder the from-file lives in.
    const parent = moduleSegments.slice(0, -1);
    const lastSegment = moduleSegments[moduleSegments.length - 1];
    const common = commonPrefixLength(base, parent);
    const ups = base.length - common;
    const downs = [...parent.slice(common), lastSegment];
    return ups > 0 ? '../'.repeat(ups).slice(0, -1) + '/' + downs.join('/') : './' + downs.join('/');
}

function renderAlias(modulePath, ctx) {
    let bestName = null;
    let bestValue = null;
    for (const [name, value] of Object.entries(ctx.aliases)) {
        if (modulePath === value || modulePath.startsWith(value + '/')) {
            if (bestValue === null || value.length > bestValue.length) {
                bestName = name;
                bestValue = value;
            }
        }
    }
    if (bestName === null) return null;
    const remainder = modulePath.slice(bestValue.length).replace(/^\//, '');
    return remainder ? `@${bestName}/${remainder}` : `@${bestName}`;
}

function renderGame(modulePath, ctx) {
    if (!ctx.rojoMap) return null;
    let best = null;
    for (const entry of ctx.rojoMap) {
        if (modulePath === entry.fsPath || modulePath.startsWith(entry.fsPath + '/')) {
            if (!best || entry.fsPath.length > best.fsPath.length) best = entry;
        }
    }
    if (!best) return null;
    const remainder = modulePath.slice(best.fsPath.length).replace(/^\//, '');
    return remainder ? `@game/${best.dmPath}/${remainder}` : `@game/${best.dmPath}`;
}

function segmentCount(rendered) {
    return rendered.split('/').length;
}

/**
 * Renders the require string for a target file, per the configured style.
 * @param {string} targetRel - Workspace-relative path of the target file (with extension)
 * @param {string} fromFileRel - Workspace-relative path of the requiring file
 * @param {'alias'|'relative'|'game'} style
 * @param {boolean} preferRelative - Substitute the relative form when strictly shorter
 * @param {object} ctx
 * @returns {string} e.g. "@Shared/Stuff/myModule" or "./myModule"
 */
function renderRequire(targetRel, fromFileRel, style, preferRelative, ctx) {
    const modulePath = modulePathOf(targetRel);
    const relativeForm = renderRelative(modulePath, fromFileRel);

    let styled = null;
    if (style === 'alias') styled = renderAlias(modulePath, ctx);
    else if (style === 'game') styled = renderGame(modulePath, ctx);
    // A rendered path must always be valid, so a style that cannot cover this target
    // (no alias prefix / no Rojo mapping) falls back to the relative form.
    if (styled === null || style === 'relative') return relativeForm;

    if (preferRelative && segmentCount(relativeForm) < segmentCount(styled)) {
        return relativeForm;
    }
    return styled;
}

// ---------------------------------------------------------------------------
// Ranking: which candidate is "closest"
// ---------------------------------------------------------------------------

function treeDistance(fromFileRel, targetRel) {
    const from = segments(fromFileRel).slice(0, -1); // containing dir
    const target = segments(modulePathOf(targetRel));
    const common = commonPrefixLength(from, target);
    return (from.length - common) + (target.length - common);
}

function pathPriorityIndex(targetRel, pathPriority) {
    const index = pathPriority.findIndex(prefix => targetRel.startsWith(prefix));
    return index === -1 ? Infinity : index;
}

/**
 * Sorts candidate target paths closest-first: filesystem tree distance from the editing
 * file, ties broken by pathPriority order, then alphabetically.
 * @param {string[]} candidates - Workspace-relative target file paths
 * @param {string} fromFileRel
 * @param {string[]} pathPriority
 * @returns {string[]} New sorted array
 */
function rankByDistance(candidates, fromFileRel, pathPriority) {
    return [...candidates].sort((a, b) => {
        const distance = treeDistance(fromFileRel, a) - treeDistance(fromFileRel, b);
        if (distance !== 0) return distance;
        // Compare indexes, not their difference: both Infinity (no prefix matched)
        // must fall through to the alphabetical tie-break, not produce NaN.
        const priorityA = pathPriorityIndex(a, pathPriority);
        const priorityB = pathPriorityIndex(b, pathPriority);
        if (priorityA !== priorityB) return priorityA - priorityB;
        return a.localeCompare(b);
    });
}

// Finds every require string in a document's text, with positions for ranges/diagnostics.
// Full-line comments are skipped so commented-out code is neither flagged nor rewritten.
function findRequireStrings(text) {
    const found = [];
    text.split(/\r?\n/).forEach((line, lineIndex) => {
        if (line.trimStart().startsWith('--')) return;
        REQUIRE_STRING.lastIndex = 0;
        let match;
        while ((match = REQUIRE_STRING.exec(line)) !== null) {
            const spec = match[2];
            const startColumn = match.index + match[0].indexOf(spec);
            found.push({
                spec,
                line: lineIndex,
                startColumn,
                endColumn: startColumn + spec.length
            });
        }
    });
    return found;
}

module.exports = {
    REQUIRE_STRING,
    RESERVED_ALIASES,
    refreshContext,
    createContext,
    getContext,
    invalidateContext,
    collectSourceFiles,
    readSourceTexts,
    resolveModulePath,
    resolveRequire,
    probeModulePath,
    renderRequire,
    rankByDistance,
    findRequireStrings,
    // Exported for tests and shared path math
    baseDir,
    modulePathOf,
    treeDistance,
    parseRojoProject
};
