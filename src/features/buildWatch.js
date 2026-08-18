const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { warn, debug } = require('../core/logger');
const pathResolver = require('./pathResolver');
const { runBuild, convertOrCopyFile } = require('./buildProject');
const { runHookCommands } = require('./updateLuaFileAliases');
const { getExtensionConfig, getBuildConversionConfig } = require('../utils/workspaceUtils');

// Watch pipeline: keeps the Build conversion output directory continuously fresh, so
// `rojo serve build.project.json` playtesting never sees stale code.
//
// Steady-state cost is O(changed file): a save converts and writes exactly that file
// (~0.4ms measured, see test/perf), against the resolver context the extension's existing
// watchers already maintain. Renames and resolution-context changes (aliases, Rojo mapping,
// settings) schedule a FULL rebuild instead — they can change the rendered form of requires
// in files that were not edited, and a full build is cheap enough that indexing the fan-out
// isn't worth it.
//
// Writes are gated on validity rather than debounced: a save streams immediately when the
// file is clean, and is HELD — keeping its last good output — while the Luau language
// server reports Error diagnostics on it, so autosave never streams half-typed code at a
// running rojo serve. Because the diagnostics API cannot separate syntax errors from type
// errors, a hold is brief: it ends when the errors clear, when HOLD_GRACE_MS expires, or
// when the editor loses focus (alt-tab to Studio = about to playtest) — whichever comes
// first — so a file with standing type errors still iterates normally instead of being
// pinned at stale output forever. Requires that do not resolve (our own findings) always
// keep the last good output; those crash at runtime, and they surface on explicit builds
// and Checks. No Luau LSP present simply means the diagnostics gate passes.

// How long a save with Luau errors waits for them to clear before writing anyway.
// Half-typed states clear within a save or two; standing type errors outlive any window.
const HOLD_GRACE_MS = 2000;
// Hook batching: writes are immediate, but user hook commands (e.g. a darklua pass) must
// not run once per keystroke-save, so hook firing coalesces behind a trailing window.
const HOOK_COALESCE_MS = 1000;
// Full rebuilds coalesce boundary storms (multi-file renames, settings churn).
const FULL_REBUILD_DELAY_MS = 250;

/** Files whose write is held on Luau errors: rel -> expiry timer. */
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
let _held = new Map();
/** @type {Set<string>} */
let _deleted = new Set();
/** @type {string[]} */
let _hookChanged = [];
/** @type {ReturnType<typeof setTimeout> | null} */
let _hookTimer = null;
let _fullRebuildPending = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let _rebuildTimer = null;

function getWorkspaceRoot() {
    return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
        ? vscode.workspace.workspaceFolders[0].uri.fsPath
        : null;
}

/**
 * @param {string} workspaceRoot
 * @param {string} fsPath
 */
function toRel(workspaceRoot, fsPath) {
    return path.relative(workspaceRoot, fsPath).replace(/\\/g, '/');
}

/**
 * @param {string} rel
 * @param {string[]} scannedDirs
 */
function underScannedDirs(rel, scannedDirs) {
    return scannedDirs.some(dir => rel === dir || rel.startsWith(dir + '/'));
}

/** @returns {string[]} */
function getScannedDirs() {
    const dirs = getExtensionConfig().get('directoriesToScan') || [];
    return (Array.isArray(dirs) ? dirs : [])
        .map(d => String(d).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, ''));
}

// The validity gate. Sources are matched loosely ("Luau") so this follows luau-lsp without
// hard-coding one exact string; an absent language server just means no gate.
/** @param {import('vscode').Uri} uri */
function hasLuauErrors(uri) {
    return vscode.languages.getDiagnostics(uri).some(d =>
        d.severity === vscode.DiagnosticSeverity.Error && typeof d.source === 'string' && /luau/i.test(d.source));
}

/** @returns {{directoriesToScan: string[], ignoreDirectories: string[], pathPriority: string[], rojoProjectPath: string, sourcemapPath: string, importModulePaths: string[]}} */
function buildOptionsFromConfig() {
    const config = getExtensionConfig();
    return {
        directoriesToScan: config.get('directoriesToScan') || [],
        ignoreDirectories: config.get('ignoreDirectories') || [],
        pathPriority: config.get('pathPriority', []),
        rojoProjectPath: config.get('rojoProjectPath', 'default.project.json'),
        sourcemapPath: config.get('sourcemapPath', 'sourcemap.json'),
        importModulePaths: config.get('importModulePaths') || []
    };
}

/** @param {string} rel */
function clearHold(rel) {
    const timer = _held.get(rel);
    if (timer !== undefined) clearTimeout(timer);
    _held.delete(rel);
}

/**
 * Converts one file and writes it unless gated. The single entry point for saves, creates,
 * hold expiries, and diagnostics-cleared retries.
 * @param {string} rel
 * @param {{ignoreDiagnostics?: boolean}} [options]
 */
function attemptWrite(rel, { ignoreDiagnostics = false } = {}) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;
    const build = getBuildConversionConfig();
    if (!build.enabled) return;

    const absolute = path.join(workspaceRoot, rel);
    if (!fs.existsSync(absolute)) {
        clearHold(rel);
        return;
    }

    // Unresolvable requires always keep the last good output — they crash at runtime, and
    // they surface on explicit builds and Checks. Retried naturally on the next save.
    /** @type {import('./buildProject').BuildFinding[]} */
    const findings = [];
    const ctx = pathResolver.getContext() || pathResolver.refreshContext();
    if (!ctx) return;
    const result = convertOrCopyFile(workspaceRoot, rel, ctx, {
        outputRequireStyle: build.outputRequireStyle,
        importModulePaths: buildOptionsFromConfig().importModulePaths
    }, findings);
    if (!result || findings.length > 0) {
        clearHold(rel);
        debug(`build watch: kept previous output for ${rel} (${findings.length || 'read'} issue(s) right now).`);
        return;
    }

    // Luau errors hold the write briefly, keeping the last good output. The hold's expiry
    // timer is NOT reset by further broken saves, so continuously typing through the window
    // still writes at expiry rather than never.
    if (!ignoreDiagnostics && hasLuauErrors(vscode.Uri.file(absolute))) {
        if (!_held.has(rel)) {
            _held.set(rel, setTimeout(() => {
                _held.delete(rel);
                debug(`build watch: hold expired for ${rel}; writing despite Luau errors.`);
                attemptWrite(rel, { ignoreDiagnostics: true });
            }, HOLD_GRACE_MS));
            debug(`build watch: holding ${rel} while the Luau language server reports errors.`);
        }
        return;
    }
    clearHold(rel);

    const outPath = path.join(workspaceRoot, build.outputDirectory, rel);
    try {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, result.data);
    } catch (e) {
        warn(`build watch: could not write ${outPath}`);
        return;
    }
    noteChanged(build, rel);
}

function flushDeletions() {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot || _deleted.size === 0) return;
    const build = getBuildConversionConfig();
    for (const rel of _deleted) {
        try {
            fs.rmSync(path.join(workspaceRoot, build.outputDirectory, rel), { recursive: true, force: true });
            noteChanged(build, rel);
        } catch (e) { /* mirrored path may not exist */ }
    }
    _deleted.clear();
}

// A created path can be a whole pasted directory; convert every file inside it.
/**
 * @param {string} workspaceRoot
 * @param {string} rel
 */
function attemptPath(workspaceRoot, rel) {
    const absolute = path.join(workspaceRoot, rel);
    /** @type {fs.Stats} */
    let stats;
    try {
        stats = fs.statSync(absolute);
    } catch (e) {
        return;
    }
    if (!stats.isDirectory()) {
        attemptWrite(rel);
        return;
    }
    /** @type {fs.Dirent[]} */
    let entries;
    try {
        entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch (e) {
        return;
    }
    for (const entry of entries) {
        attemptPath(workspaceRoot, `${rel}/${entry.name}`);
    }
}

// ---------------------------------------------------------------------------
// Hooks: batched even though writes are not.
// ---------------------------------------------------------------------------

/**
 * @param {ReturnType<typeof getBuildConversionConfig>} build
 * @param {string} rel
 */
function noteChanged(build, rel) {
    _hookChanged.push(rel);
    if (_hookTimer) clearTimeout(_hookTimer);
    _hookTimer = setTimeout(() => { _hookTimer = null; fireHooks(build); }, HOOK_COALESCE_MS);
}

/** @param {ReturnType<typeof getBuildConversionConfig>} build */
function fireHooks(build) {
    if (_hookChanged.length === 0) return;
    const changed = _hookChanged;
    _hookChanged = [];
    runHookCommands('buildConversion.hooks.onWatchConverted', 'after each watch conversion batch', {
        ROR_EVENT: 'watch-converted',
        ROR_OUTPUT_DIR: build.outputDirectory,
        ROR_CHANGED_FILES: changed.join('\n')
    });
}

// ---------------------------------------------------------------------------
// Full rebuild boundary
// ---------------------------------------------------------------------------

function scheduleFullRebuild() {
    _fullRebuildPending = true;
    if (_rebuildTimer) clearTimeout(_rebuildTimer);
    _rebuildTimer = setTimeout(() => { _rebuildTimer = null; runFullRebuild(); }, FULL_REBUILD_DELAY_MS);
}

function runFullRebuild() {
    if (!_fullRebuildPending) return;
    _fullRebuildPending = false;
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;
    const build = getBuildConversionConfig();
    if (!build.enabled) return;

    for (const rel of [..._held.keys()]) clearHold(rel);
    _deleted.clear();

    const result = runBuild(workspaceRoot, {
        ...buildOptionsFromConfig(),
        outputDirectory: build.outputDirectory,
        outputRequireStyle: build.outputRequireStyle
    });
    if (result.findings.length > 0) {
        // Quiet by design: the previous output stays in place, and the findings will
        // surface with full detail on the next explicit build or Check.
        warn(`build watch: full rebuild skipped — ${result.findings.length} require(s) cannot be converted yet (run Build Project for details).`);
        return;
    }
    debug(`build watch: full rebuild — ${result.filesConverted} converted, ${result.filesCopied} copied.`);
    noteChanged(build, '<full rebuild>');
}

// ---------------------------------------------------------------------------

/**
 * Registers the watch. Returned disposables belong in eventListenerDisposables so the watch
 * tears down with the rest on deactivate/rewire. Caller gates on buildConversion.enabled.
 * @returns {import('vscode').Disposable[]}
 */
function registerBuildWatch() {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return [];
    debug('build watch: registering (initial full rebuild queued)');

    // Boundary: (re)activation. Deferred through the coalescing delay so activation stays snappy.
    scheduleFullRebuild();

    return [
        vscode.workspace.onDidSaveTextDocument((document) => {
            if (document.uri.scheme !== 'file') return;
            const rel = toRel(workspaceRoot, document.uri.fsPath);
            if (underScannedDirs(rel, getScannedDirs())) attemptWrite(rel);
        }),
        // A held file's errors clearing is the moment its write was waiting for.
        vscode.languages.onDidChangeDiagnostics((event) => {
            if (_held.size === 0) return;
            for (const uri of event.uris) {
                const rel = toRel(workspaceRoot, uri.fsPath);
                if (_held.has(rel) && !hasLuauErrors(uri)) {
                    clearHold(rel);
                    attemptWrite(rel);
                }
            }
        }),
        vscode.workspace.onDidCreateFiles((event) => {
            const dirs = getScannedDirs();
            for (const uri of event.files) {
                const rel = toRel(workspaceRoot, uri.fsPath);
                if (underScannedDirs(rel, dirs)) attemptPath(workspaceRoot, rel);
            }
        }),
        vscode.workspace.onDidDeleteFiles((event) => {
            const dirs = getScannedDirs();
            for (const uri of event.files) {
                const rel = toRel(workspaceRoot, uri.fsPath);
                if (underScannedDirs(rel, dirs)) {
                    clearHold(rel);
                    _deleted.add(rel);
                }
            }
            flushDeletions();
        }),
        // Renames can change the rendered form of requires in files that were NOT renamed
        // (the rename machinery rewrites them, in dynamic mode directly on disk with no save
        // event) — a full rebuild is the simple, always-correct answer.
        vscode.workspace.onDidRenameFiles(() => scheduleFullRebuild()),
        vscode.window.onDidChangeWindowState((state) => {
            if (state.focused) return;
            // Alt-tab to Studio = about to playtest: every hold ends now (write despite
            // errors — stale output is more confusing than broken output at this moment),
            // pending rebuilds run, and batched hooks fire.
            for (const rel of [..._held.keys()]) {
                clearHold(rel);
                attemptWrite(rel, { ignoreDiagnostics: true });
            }
            if (_rebuildTimer) { clearTimeout(_rebuildTimer); _rebuildTimer = null; }
            runFullRebuild();
            if (_hookTimer) { clearTimeout(_hookTimer); _hookTimer = null; }
            fireHooks(getBuildConversionConfig());
        }),
        {
            dispose: () => {
                for (const rel of [..._held.keys()]) clearHold(rel);
                if (_hookTimer) { clearTimeout(_hookTimer); _hookTimer = null; }
                if (_rebuildTimer) { clearTimeout(_rebuildTimer); _rebuildTimer = null; }
                _hookChanged = [];
                _deleted.clear();
                _fullRebuildPending = false;
            }
        }
    ];
}

module.exports = {
    registerBuildWatch,
    scheduleFullRebuild
};
