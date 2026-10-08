// The project index's pure parts: which files under the scan roots are modules, what
// ignoreDirectories prunes, which basenames become aliases, and what .luaurc says. No editor
// dependency, so the extension, the CLI, and the build all derive the index by the same rules.
// pathResolver.createContext assembles these into the ResolverContext the rest of the code uses.

const fs = require('fs');
const path = require('path');
const { print, warn, debug, trace } = require('./logger');
const { parseJsonc } = require('./settings');

const supportedExtensions = ['.lua', '.luau'];

/**
 * One candidate file for a given basename.
 * @typedef {{ path: string }} AliasCandidate
 *
 * Basename -> every file that could claim that alias.
 * @typedef {Object<string, AliasCandidate[]>} BasenameMap
 *
 * An ignoreDirectories entry, compiled once per run. `regex` is null when the
 * pattern failed to compile, in which case matching falls back to `source`.
 * @typedef {{ pattern: string, source: string, regex: RegExp | null, subjectKind: string }} CompiledIgnorePattern
 *
 * Per-run scan counters.
 * @typedef {{ dirsScanned: number, dirsPruned: number, filesSeen: number, filesAdded: number, filesRejected: number }} ScanStats
 */

// Per-run counters, reset at the top of buildBasenameMap and reported in its summary.
/** @type {ScanStats} */
let stats = { dirsScanned: 0, dirsPruned: 0, filesSeen: 0, filesAdded: 0, filesRejected: 0 };

/**
 * Workspace-root-relative, forward-slashed path. Used both for alias values and log messages.
 * @param {string} filePath
 * @param {string} workspaceRoot
 * @returns {string}
 */
function toAliasPath(filePath, workspaceRoot) {
    return path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
}

// Compile ignore patterns once per run, so the regex (and the invalid-pattern warning)
// is not rebuilt for every directory visited.
// Patterns containing '/' are matched against the workspace-root-relative path; all others
// against the bare directory name. A backslash is ambiguous — a Windows separator
// ("src\Server\Private") or a regex escape ("^\.git$") — so such a pattern is tried both
// ways: as a path with '\' read as '/', and as a name regex as written.
/**
 * @param {string[]} patterns
 * @returns {CompiledIgnorePattern[]}
 */
function compileIgnorePatterns(patterns) {
    /**
     * @param {string} pattern
     * @param {string} source
     * @param {'path' | 'name'} subjectKind
     * @returns {CompiledIgnorePattern}
     */
    function compile(pattern, source, subjectKind) {
        let regex = null;
        try {
            regex = new RegExp(source);
        } catch (e) {
            warn(`Invalid regex pattern: ${pattern}, falling back to exact match`);
        }
        return { pattern, source, regex, subjectKind };
    }
    return patterns.flatMap(pattern => {
        if (pattern.includes('/')) return [compile(pattern, pattern, 'path')];
        if (pattern.includes('\\')) return [compile(pattern, pattern.replace(/\\/g, '/'), 'path'), compile(pattern, pattern, 'name')];
        return [compile(pattern, pattern, 'name')];
    });
}

// Returns the first compiled pattern that matches this directory, or null.
/**
 * @param {CompiledIgnorePattern[]} compiledPatterns
 * @param {string} dirName
 * @param {string} relPath
 * @returns {(CompiledIgnorePattern & { subject: string }) | null}
 */
function findIgnoreMatch(compiledPatterns, dirName, relPath) {
    for (const compiled of compiledPatterns) {
        const subject = compiled.subjectKind === 'path' ? relPath : dirName;
        const matched = compiled.regex
            ? compiled.regex.test(subject)
            : subject.toLowerCase() === compiled.source.toLowerCase();
        if (matched) return { ...compiled, subject };
    }
    return null;
}

// Helper to check if the file is located under a directory that matches any ignore pattern.
// Returns the matching pattern (for logging) or null.
/**
 * @param {string} filePath
 * @param {string} rootDir
 * @param {string} workspaceRoot
 * @param {CompiledIgnorePattern[]} compiledPatterns
 * @returns {(CompiledIgnorePattern & { subject: string, dir: string }) | null}
 */
function findIgnoredAncestor(filePath, rootDir, workspaceRoot, compiledPatterns) {
    let currentDir = path.dirname(filePath);
    while (currentDir !== rootDir) {
        const match = findIgnoreMatch(
            compiledPatterns,
            path.basename(currentDir),
            toAliasPath(currentDir, workspaceRoot)
        );
        if (match) return { ...match, dir: currentDir };
        currentDir = path.dirname(currentDir);
    }
    return null;
}

// Helper function to check if a file should be ignored.
// Returns the offending substring (for logging) or null.
/**
 * @param {string} fileName
 * @param {string[]} ignoreList
 * @returns {string | null}
 */
function findIgnoredFileSubstring(fileName, ignoreList) {
    return ignoreList.find(substring => fileName.includes(substring)) || null;
}

// Resolve ambiguous basename candidates using ordered path-priority prefixes.
// Returns a resolved path only when exactly one candidate matches the highest-priority matched prefix.
/**
 * @param {AliasCandidate[]} candidates
 * @param {string[]} pathPriority
 * @returns {{ resolvedPath?: string, priorityPrefix?: string, triedPrefixes?: string[], ambiguous?: boolean, matchCount?: number, noPrefixMatched?: boolean } | null}
 */
function resolveAmbiguousAliasByPathPriority(candidates, pathPriority) {
    if (!Array.isArray(pathPriority) || pathPriority.length === 0) {
        return null;
    }

    const normalizedPriority = pathPriority
        .filter(entry => typeof entry === 'string' && entry.length > 0)
        .map(entry => entry.replace(/\\/g, '/'));

    for (const priorityPrefix of normalizedPriority) {
        const matched = candidates.filter(candidate => candidate.path.startsWith(priorityPrefix));

        if (matched.length === 1) {
            return { resolvedPath: matched[0].path, priorityPrefix, triedPrefixes: normalizedPriority };
        }

        // Highest-priority tie remains ambiguous by design.
        if (matched.length > 1) {
            return { ambiguous: true, priorityPrefix, matchCount: matched.length, triedPrefixes: normalizedPriority };
        }
    }

    return { noPrefixMatched: true, triedPrefixes: normalizedPriority };
}


// Recursive function to scan a directory and collect files by basename
/**
 * @param {string} dir
 * @param {string} rootDir
 * @param {string[]} supportedExtensions
 * @param {CompiledIgnorePattern[]} ignorePatterns
 * @param {string[]} ignoreList
 * @param {BasenameMap} basenameMap
 * @param {string} workspaceRoot
 * @param {string[]} sourceFiles - Receives every Luau file reached, aliased or not
 * @returns {void}
 */
function scanDir(dir, rootDir, supportedExtensions, ignorePatterns, ignoreList, basenameMap, workspaceRoot, sourceFiles) {
    const relDir = toAliasPath(dir, workspaceRoot);

    // If this directory or any of its parents (up to rootDir) matches any ignore pattern, skip entirely
    let match = null;
    let checkDir = dir;
    while (checkDir !== rootDir && checkDir !== path.dirname(checkDir)) {
        match = findIgnoreMatch(
            ignorePatterns,
            path.basename(checkDir),
            toAliasPath(checkDir, workspaceRoot)
        );
        if (match) break;
        checkDir = path.dirname(checkDir);
    }
    if (match) {
        stats.dirsPruned++;
        const via = checkDir === dir ? '' : ` (via ancestor "${toAliasPath(checkDir, workspaceRoot)}")`;
        debug(`  prune dir "${relDir}"${via}: ignoreDirectories pattern /${match.pattern}/ matched ${match.subjectKind} "${match.subject}"`);
        return;
    }

    stats.dirsScanned++;
    debug(`  scan dir "${relDir}"`);

    /** @type {fs.Dirent[]} */
    let files;
    try {
        files = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        warn(`Could not read directory "${relDir}"; skipping it (${e instanceof Error ? e.message : String(e)}).`);
        return;
    }

    // Check for init files in the current directory
    let foundInit = null;
    for (const ext of supportedExtensions) {
        const initFilePath = path.join(dir, `init${ext}`);
        if (fs.existsSync(initFilePath)) {
            if (foundInit) {
                warn(`Directory "${relDir}" contains both init.lua and init.luau; the folder alias "${path.basename(dir)}" will be ambiguous and dropped.`);
            }
            foundInit = initFilePath;
            const folderName = path.basename(dir);
            const ignoredAncestor = findIgnoredAncestor(initFilePath, rootDir, workspaceRoot, ignorePatterns);
            if (!ignoredAncestor) {
                if (!basenameMap[folderName]) basenameMap[folderName] = [];
                basenameMap[folderName].push({ path: toAliasPath(initFilePath, workspaceRoot) });
                stats.filesAdded++;
                debug(`    + "${folderName}" -> "${toAliasPath(initFilePath, workspaceRoot)}" (folder alias from init file)`);
            } else {
                stats.filesRejected++;
                debug(`    - skip init file "${toAliasPath(initFilePath, workspaceRoot)}": ancestor "${toAliasPath(ignoredAncestor.dir, workspaceRoot)}" matches ignoreDirectories pattern /${ignoredAncestor.pattern}/`);
            }
        }
    }

    files.forEach(file => {
        const filePath = path.join(dir, file.name);
        if (file.isDirectory()) {
            scanDir(filePath, rootDir, supportedExtensions, ignorePatterns, ignoreList, basenameMap, workspaceRoot, sourceFiles);
            return;
        }
        if (!file.isFile()) return;

        if (!supportedExtensions.includes(path.extname(file.name))) {
            trace(`    . ignore "${toAliasPath(filePath, workspaceRoot)}": extension not in ${JSON.stringify(supportedExtensions)}`);
            return;
        }

        stats.filesSeen++;
        sourceFiles.push(filePath);

        const ignoredSubstring = findIgnoredFileSubstring(file.name, ignoreList);
        if (ignoredSubstring) {
            stats.filesRejected++;
            debug(`    - skip "${toAliasPath(filePath, workspaceRoot)}": file name contains "${ignoredSubstring}" (Roblox context-scoped file, never aliased)`);
            return;
        }
        // If this is an init file and we've already aliased the containing directory, skip aliasing "init"
        if (foundInit && file.name.startsWith('init.')) {
            stats.filesRejected++;
            debug(`    - skip "${toAliasPath(filePath, workspaceRoot)}": init file is aliased as its folder name "${path.basename(dir)}" instead`);
            return;
        }
        const ignoredAncestor = findIgnoredAncestor(filePath, rootDir, workspaceRoot, ignorePatterns);
        if (ignoredAncestor) {
            stats.filesRejected++;
            debug(`    - skip "${toAliasPath(filePath, workspaceRoot)}": ancestor "${toAliasPath(ignoredAncestor.dir, workspaceRoot)}" matches ignoreDirectories pattern /${ignoredAncestor.pattern}/`);
            return;
        }

        const aliasKey = path.parse(file.name).name;
        if (!basenameMap[aliasKey]) basenameMap[aliasKey] = [];
        basenameMap[aliasKey].push({ path: toAliasPath(filePath, workspaceRoot) });
        stats.filesAdded++;
        debug(`    + "${aliasKey}" -> "${toAliasPath(filePath, workspaceRoot)}"`);
    });
}

// The one walk of the scan roots. Returns the basename -> candidate-file map, the single
// source of module-index semantics (folder-init aliasing, .server/.client skip,
// ignoreDirectories pruning) that dynamic mode turns into .luaurc aliases and explicit mode
// into the completion/rewrite index, plus every Luau file the walk reached, which is the set
// diagnostics, rewrites, and the checker read. Resets the per-run stats counters.
//
// Settings arrive as plain values rather than being read from VS Code here, so the CI
// checker can supply them from a parsed settings.json.
/**
 * @param {string} workspaceRoot
 * @param {{directoriesToScan?: string[], ignoreDirectories?: string[]}} [options]
 * @returns {{ basenameMap: BasenameMap, rootDirs: string[], sourceFiles: string[] }}
 */
function buildBasenameMap(workspaceRoot, { directoriesToScan = [], ignoreDirectories = [] } = {}) {
    const ignoreList = ['.server', '.client'];

    stats = { dirsScanned: 0, dirsPruned: 0, filesSeen: 0, filesAdded: 0, filesRejected: 0 };

    debug(`directoriesToScan: ${JSON.stringify(directoriesToScan)}`);
    debug(`ignoreDirectories: ${JSON.stringify(ignoreDirectories)}`);
    debug(`file name substrings never aliased: ${JSON.stringify(ignoreList)}`);
    debug(`aliased file extensions: ${JSON.stringify(supportedExtensions)}`);

    // Resolve scan roots. A configured root that does not exist is almost always a typo,
    // so it warns rather than disappearing silently.
    /** @type {string[]} */
    const rootDirs = [];
    for (const dir of directoriesToScan) {
        const absolute = path.join(workspaceRoot, dir);
        if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
            rootDirs.push(absolute);
        } else {
            warn(`directoriesToScan entry "${dir}" is not an existing directory (looked in "${absolute}"); skipping it.`);
        }
    }
    if (rootDirs.length === 0) {
        warn('No scan roots resolved; no modules will be indexed. Check require-on-rails.directoriesToScan.');
    }

    const ignorePatterns = compileIgnorePatterns(ignoreDirectories);

    // Map of basename -> array of { path }
    /** @type {BasenameMap} */
    const basenameMap = {};
    /** @type {string[]} Absolute paths */
    const sourceFiles = [];
    rootDirs.forEach(rootDir => {
        print(`Scanning directory: ${rootDir}`);
        scanDir(rootDir, rootDir, supportedExtensions, ignorePatterns, ignoreList, basenameMap, workspaceRoot, sourceFiles);
    });

    trace(`Finished scanning. Found basenames: ${JSON.stringify(Object.keys(basenameMap).sort())}`);
    // Note: candidates != files seen - files skipped, because a directory's init file
    // contributes a folder-name candidate as well as being skipped under its own name.
    debug(
        `scan finished — roots: ${rootDirs.length}, dirs scanned: ${stats.dirsScanned}, ` +
        `dirs pruned: ${stats.dirsPruned}, files seen: ${stats.filesSeen}, files skipped: ${stats.filesRejected}, ` +
        `alias candidates: ${stats.filesAdded}`
    );

    return { basenameMap, rootDirs, sourceFiles };
}

// Turns the basename map into the alias set RequireOnRails would write: unique basenames
// become aliases, ambiguous ones are dropped (unless pathPriority breaks the tie), and
// manualAliases win over both. Ambiguous names are returned with their conflicting paths so
// callers can explain the omission.
//
// Pure, so that dynamic mode's .luaurc write and the CI checker's read-only report derive the
// same "generated alias set" from the same rules.
/**
 * @param {BasenameMap} basenameMap
 * @param {{pathPriority?: string[], manualAliases?: Object<string, string>}} [options]
 * @returns {{ aliases: Object<string, string>, ambiguousAliases: Object<string, string[]>, shadowedByManual: number }}
 */
function classifyBasenames(basenameMap, { pathPriority = [], manualAliases = {} } = {}) {
    // Merge manual and auto-generated aliases, manual takes precedence
    /** @type {Object<string, string>} */
    const compiledAliases = {};

    // Add manual aliases from VS Code settings (these take precedence)
    for (const [k, v] of Object.entries(manualAliases)) {
        compiledAliases[k] = v;
    }

    // Ambiguous aliases (multiple files with the same basename), mapped to the conflicting
    // paths so both the notification and the Problems-panel diagnostics can name them.
    /** @type {Object<string, string[]>} */
    const ambiguousAliases = {};
    // Track which aliases are unique (only one file with that basename)
    /** @type {Object<string, string>} */
    const uniqueAliases = {};
    for (const [basename, arr] of Object.entries(basenameMap)) {
        if (arr.length === 1) {
            uniqueAliases[basename] = arr[0].path;
            trace(`Unique alias: "${basename}" -> "${arr[0].path}"`);
        } else {
            const priorityResolution = resolveAmbiguousAliasByPathPriority(arr, pathPriority);
            if (priorityResolution && priorityResolution.resolvedPath) {
                uniqueAliases[basename] = priorityResolution.resolvedPath;
                print(
                    `Resolved ambiguous alias: "${basename}" using pathPriority prefix "${priorityResolution.priorityPrefix}" -> "${priorityResolution.resolvedPath}"`
                );
                continue;
            }
            ambiguousAliases[basename] = arr.map(x => x.path);
            print(`Ambiguous alias: "${basename}" found in:`, arr.map(x => x.path));

            // Explain exactly why pathPriority did not break the tie.
            if (!priorityResolution) {
                debug(`  "${basename}" dropped: pathPriority is empty, so no tie-break was attempted. Add a prefix to require-on-rails.pathPriority to pick a winner.`);
            } else if (priorityResolution.ambiguous) {
                debug(`  "${basename}" dropped: ${priorityResolution.matchCount} candidates share the highest matching pathPriority prefix "${priorityResolution.priorityPrefix}", so lower-priority prefixes were not tried. Tried in order: ${JSON.stringify(priorityResolution.triedPrefixes)}`);
            } else {
                debug(`  "${basename}" dropped: no candidate path starts with any pathPriority prefix. Tried in order: ${JSON.stringify(priorityResolution.triedPrefixes)}`);
            }
        }
    }

    // Add or update unique aliases (auto-generated)
    let shadowedByManual = 0;
    for (const [key, value] of Object.entries(uniqueAliases)) {
        if (!manualAliases[key]) { // don't overwrite manual
            compiledAliases[key] = value;
        } else {
            shadowedByManual++;
            debug(`Alias "${key}" -> "${value}" was discarded: require-on-rails.manualAliases already maps "${key}" to "${manualAliases[key]}".`);
        }
    }

    return { aliases: compiledAliases, ambiguousAliases, shadowedByManual };
}

// The one .luaurc reader. Parsed as JSONC because Luau accepts comments and trailing commas
// there, and a reader stricter than Luau would reject a file the language server is happy with.
/**
 * @param {string} workspaceRoot
 * @returns {Record<string, any> | null} null when the file is absent; {} when it is blank
 * @throws When the file exists but is not valid JSONC — callers decide how loudly to fail
 */
function readLuaurc(workspaceRoot) {
    const luaurcPath = path.join(workspaceRoot, '.luaurc');
    if (!fs.existsSync(luaurcPath)) return null;
    const raw = fs.readFileSync(luaurcPath, 'utf8');
    return raw.trim() ? parseJsonc(raw) : {};
}

// Alias keys are accepted bare ("Shared") and @-prefixed ("@Shared"), because Luau accepts
// both. Values become workspace-root-relative, forward-slashed, without "./" or a trailing "/",
// so a committed .luaurc and a generated alias set compare equal when they mean the same thing.
/**
 * @param {Object<string, unknown> | null | undefined} aliases
 * @returns {Record<string, string>} Bare alias name -> normalized path
 */
function normalizeAliases(aliases) {
    /** @type {Record<string, string>} */
    const out = {};
    for (const [key, value] of Object.entries(aliases || {})) {
        if (typeof value !== 'string') continue;
        out[key.replace(/^@/, '')] = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    }
    return out;
}

// The .luaurc dynamic mode writes: the generated aliases first, every other key kept.
/**
 * @param {Record<string, any>} existing - The parsed current file, {} when there is none
 * @param {Object<string, string>} aliases
 * @returns {string}
 */
function renderLuaurc(existing, aliases) {
    const others = Object.fromEntries(Object.entries(existing).filter(([key]) => key !== 'aliases'));
    return JSON.stringify({ aliases, ...others }, null, 4);
}

module.exports = {
    renderLuaurc,
    buildBasenameMap,
    classifyBasenames,
    compileIgnorePatterns,
    findIgnoreMatch,
    readLuaurc,
    normalizeAliases
};
