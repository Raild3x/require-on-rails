const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const vscode = require('vscode');
const { print, warn, error, debug, trace } = require('../core/logger');

const extenionName = 'require-on-rails';
const supportedExtensions = ['.lua', '.luau'];

// Per-run counters, reset at the top of generateFileAliases and reported in its summary.
let stats = null;

// Helper function to get the absolute path of a directory or file
function getDirPath(workspaceRoot, filePath) {
    return path.join(workspaceRoot, filePath);
}

// Workspace-root-relative, forward-slashed path. Used both for alias values and log messages.
function toAliasPath(filePath, workspaceRoot) {
    return path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
}

// Helper to check if any parent directories contain an init file
function hasInitInParentDirs(filePath, rootDir, supportedExtensions) {
    let currentDir = path.dirname(filePath);
    while (currentDir !== rootDir) {
        for (const ext of supportedExtensions) {
            if (fs.existsSync(path.join(currentDir, `init${ext}`))) {
                return true;
            }
        }
        currentDir = path.dirname(currentDir);
    }
    return false;
}

// Modify the .luaurc json into a string with blank lines separating user and extension aliases, and group extension aliases by root
function adjustLuaurcWithSeparation(userAliases, extensionAliases, restConfig) {
    print("Adjusting .luaurc with aliases separated");

    // Group auto-generated aliases for pretty writing
    const config = vscode.workspace.getConfiguration(extenionName);
    const rootNames = config.get('directoriesToScan')
    function getRoot(path) {
        for (const root of rootNames) {
            if (path.startsWith(root + "/") || path === root) {
                return root;
            }
        }
        return "Other";
    }

    // Group extension aliases
    const grouped = {};
    for (const root of rootNames.concat("Other")) {
        grouped[root] = [];
    }
    for (const [alias, filePath] of Object.entries(extensionAliases)) {
        const group = getRoot(filePath);
        grouped[group].push({ alias, filePath });
    }
    for (const group of Object.values(grouped)) {
        group.sort((a, b) => a.alias.localeCompare(b.alias));
    }

    // Compose the aliases object with user aliases first, then extension aliases grouped
    let aliasLines = [];
    for (const [k, v] of Object.entries(userAliases)) {
        aliasLines.push(`        "${k}": "${v}",`);
    }
    if (aliasLines.length > 0 && Object.values(grouped).some(g => g.length > 0)) {
        aliasLines.push(""); // blank line between user and extension aliases
    }
    let firstGroup = true;
    for (const root of rootNames.concat("Other")) {
        const group = grouped[root] || [];
        if (group.length > 0) {
            if (!firstGroup) aliasLines.push(""); // blank line between groups
            firstGroup = false;
            for (const { alias, filePath } of group) {
                aliasLines.push(`        "${alias}": "${filePath}",`);
            }
        }
    }
    // Remove trailing comma from last alias
    if (aliasLines.length > 0) {
        let lastIdx = aliasLines.length - 1;
        while (lastIdx >= 0 && aliasLines[lastIdx].trim() === "") lastIdx--;
        if (lastIdx >= 0) aliasLines[lastIdx] = aliasLines[lastIdx].replace(/,$/, "");
    }
    let rest = { ...restConfig };
    delete rest.aliases;
    let restStr = Object.keys(rest).length > 0 ? (",\n" + JSON.stringify(rest, null, 4).slice(1, -1)) : "";
    return `{
    "aliases": {
${aliasLines.join('\n')}
    }${restStr}
}`;
}

// Compile ignore patterns once per run, so the regex (and the invalid-pattern warning)
// is not rebuilt for every directory visited.
// Patterns containing path separators ('/' or '\\') are matched against the workspace-root-relative
// path; all others are matched against the bare directory name.
function compileIgnorePatterns(patterns) {
    return patterns.map(pattern => {
        const isPathPattern = pattern.includes('/') || pattern.includes('\\');
        const source = isPathPattern ? pattern.replace(/\\/g, '/') : pattern;
        let regex = null;
        try {
            regex = new RegExp(source);
        } catch (e) {
            warn(`Invalid regex pattern: ${pattern}, falling back to exact match`);
        }
        return { pattern, source, regex, subjectKind: isPathPattern ? 'path' : 'name' };
    });
}

// Returns the first compiled pattern that matches this directory, or null.
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
function findIgnoredFileSubstring(fileName, ignoreList) {
    return ignoreList.find(substring => fileName.includes(substring)) || null;
}

// Resolve ambiguous basename candidates using ordered path-priority prefixes.
// Returns a resolved path only when exactly one candidate matches the highest-priority matched prefix.
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
function scanDir(dir, rootDir, supportedExtensions, ignorePatterns, ignoreList, basenameMap, workspaceRoot) {
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

    const files = fs.readdirSync(dir, { withFileTypes: true });

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
            scanDir(filePath, rootDir, supportedExtensions, ignorePatterns, ignoreList, basenameMap, workspaceRoot);
            return;
        }
        if (!file.isFile()) return;

        if (!supportedExtensions.includes(path.extname(file.name))) {
            trace(`    . ignore "${toAliasPath(filePath, workspaceRoot)}": extension not in ${JSON.stringify(supportedExtensions)}`);
            return;
        }

        stats.filesSeen++;

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


// Serialization state for post-regeneration commands.
// Only one batch of commands runs at a time; if another regeneration fires while commands
// are in-flight, the latest request is queued (previous pending run is dropped).
let _commandsInFlight = false;
let _pendingRun = null; // { commands: string[], workspaceRoot: string } | null

function _runCommandsSerial(commands, workspaceRoot) {
    let index = 0;
    function runNext() {
        if (index >= commands.length) {
            _commandsInFlight = false;
            if (_pendingRun) {
                const { commands: nextCmds, workspaceRoot: nextRoot } = _pendingRun;
                _pendingRun = null;
                _runCommandsSerial(nextCmds, nextRoot);
            }
            return;
        }
        const command = commands[index++];
        exec(command, { cwd: workspaceRoot }, (err) => {
            if (err) error(`onAliasesRegenerated command failed: "${command}"`, err.message);
            else print(`onAliasesRegenerated: ran "${command}"`);
            runNext();
        });
    }
    _commandsInFlight = true;
    runNext();
}

function _scheduleAliasCommands(commands, workspaceRoot) {
    if (_commandsInFlight) {
        _pendingRun = { commands, workspaceRoot };
        return;
    }
    _runCommandsSerial(commands, workspaceRoot);
}

// Main function to generate file aliases
function generateFileAliases() {
    const config = vscode.workspace.getConfiguration(extenionName);
    
    // Check if workspace folders exist
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        print('No workspace folder found. Skipping alias generation.');
        return;
    }
    
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;

    const directoriesToScan = config.get('directoriesToScan') || [];
    const ignoreDirectories = config.get('ignoreDirectories') || [];
    const rawPathPriority = config.get('pathPriority', []);
    const pathPriority = Array.isArray(rawPathPriority) ? rawPathPriority : [];
    const inspectedManualAliases = config.inspect('manualAliases');
    const manualAliases = (inspectedManualAliases
        ? (inspectedManualAliases.workspaceFolderValue
            ?? inspectedManualAliases.workspaceValue
            ?? inspectedManualAliases.globalValue
            ?? inspectedManualAliases.defaultValue)
        : null) ?? {};
    const ignoreList = ['.server', '.client'];
    const luaurcPath = getDirPath(workspaceRoot, '.luaurc');

    stats = { dirsScanned: 0, dirsPruned: 0, filesSeen: 0, filesAdded: 0, filesRejected: 0 };

    debug(`--- Alias generation started ---`);
    debug(`workspaceRoot: ${workspaceRoot}`);
    debug(`directoriesToScan: ${JSON.stringify(directoriesToScan)}`);
    debug(`ignoreDirectories: ${JSON.stringify(ignoreDirectories)}`);
    debug(`pathPriority: ${JSON.stringify(pathPriority)}`);
    debug(`manualAliases: ${JSON.stringify(manualAliases)}`);
    debug(`file name substrings never aliased: ${JSON.stringify(ignoreList)}`);
    debug(`aliased file extensions: ${JSON.stringify(supportedExtensions)}`);

    // Resolve scan roots. A configured root that does not exist is almost always a typo,
    // so it warns rather than disappearing silently.
    const rootDirs = [];
    for (const dir of directoriesToScan) {
        const absolute = getDirPath(workspaceRoot, dir);
        if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
            rootDirs.push(absolute);
        } else {
            warn(`directoriesToScan entry "${dir}" is not an existing directory (looked in "${absolute}"); skipping it.`);
        }
    }
    if (rootDirs.length === 0) {
        warn('No scan roots resolved; no aliases will be generated. Check require-on-rails.directoriesToScan.');
    }

    const ignorePatterns = compileIgnorePatterns(ignoreDirectories);

    // Read and update the .luaurc file with generated aliases
    let luaurc = {};
    if (fs.existsSync(luaurcPath)) {
        const rawData = fs.readFileSync(luaurcPath, 'utf8');
        try {
            luaurc = rawData ? JSON.parse(rawData) : {};
        } catch (e) {
            error("Failed to parse .luaurc as JSON:", e);
            vscode.window.showErrorMessage("RequireOnRails: Failed to parse .luaurc as JSON. Please fix or delete the file.");
            return
        }
    }

    // Map of basename -> array of { path }
    const basenameMap = {};
    rootDirs.forEach(rootDir => {
        print(`Scanning directory: ${rootDir}`);
        scanDir(rootDir, rootDir, supportedExtensions, ignorePatterns, ignoreList, basenameMap, workspaceRoot);
    });

    trace(`Finished scanning. Found basenames: ${JSON.stringify(Object.keys(basenameMap).sort())}`);

    // Merge manual and auto-generated aliases, manual takes precedence
    let compiledAliases = {};

    // Add manual aliases from VS Code settings (these take precedence)
    for (const [k, v] of Object.entries(manualAliases)) {
        compiledAliases[k] = v;
    }

    // Track which aliases are ambiguous (multiple files with same basename)
    const ambiguousAliases = new Set();
    // Track which aliases are unique (only one file with that basename)
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
            ambiguousAliases.add(basename);
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

    trace(`Final aliases: ${JSON.stringify(compiledAliases, null, 2)}`);
    // Note: candidates != files seen - files skipped, because a directory's init file
    // contributes a folder-name candidate as well as being skipped under its own name.
    debug(
        `--- Alias generation finished --- roots: ${rootDirs.length}, dirs scanned: ${stats.dirsScanned}, ` +
        `dirs pruned: ${stats.dirsPruned}, files seen: ${stats.filesSeen}, files skipped: ${stats.filesRejected}, ` +
        `alias candidates: ${stats.filesAdded}, ambiguous names dropped: ${ambiguousAliases.size}, ` +
        `shadowed by manualAliases: ${shadowedByManual}, written to .luaurc: ${Object.keys(compiledAliases).length}`
    );

    luaurc.aliases = compiledAliases;

    // Create a proper JSON structure ensuring aliases is always an object
    const finalLuaurc = {
        aliases: compiledAliases || {},
        ...Object.fromEntries(Object.entries(luaurc).filter(([key]) => key !== 'aliases'))
    };

    // Write with proper JSON formatting
    const luaurcString = JSON.stringify(finalLuaurc, null, 4);
    fs.writeFileSync(luaurcPath, luaurcString);

    // Run post-regeneration scripts (user settings only; skipped in untrusted workspaces)
    const rawAliasCommands = config.get('onAliasesRegenerated');
    const onAliasesRegenerated = Array.isArray(rawAliasCommands)
        ? rawAliasCommands.filter(c => typeof c === 'string' && c.length > 0)
        : [];
    if (onAliasesRegenerated.length > 0) {
        if (!vscode.workspace.isTrusted) {
            warn('onAliasesRegenerated: skipping commands in untrusted workspace');
        } else {
            _scheduleAliasCommands(onAliasesRegenerated, workspaceRoot);
        }
    }
}

module.exports = { generateFileAliases };