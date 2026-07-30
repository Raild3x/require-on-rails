const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const vscode = require('vscode');
const { print, warn, error, debug, trace, showOutputChannel } = require('../core/logger');

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

function toCommandList(value) {
    return Array.isArray(value) ? value.filter(c => typeof c === 'string' && c.length > 0) : [];
}

// onAliasesRegenerated only ever runs from the user's own settings, so that opening a
// repository cannot make RequireOnRails execute arbitrary shell commands. This is enforced
// here rather than with `"scope": "machine"` in package.json, because VS Code strips
// machine-scoped values out of the workspace configuration before `inspect()` can see them,
// and we need to see them in order to tell the user what the workspace was asking for.
function getAliasCommands(config) {
    const inspected = config.inspect('onAliasesRegenerated') || {};
    return {
        userCommands: toCommandList(inspected.globalValue),
        workspaceCommands: toCommandList(inspected.workspaceFolderValue ?? inspected.workspaceValue)
    };
}

// Commands the user has approved *for this workspace only*.
//
// This deliberately does not live in settings. User settings would apply the commands to
// every workspace the user opens, and workspace settings are the very thing being guarded
// against. `workspaceState` is keyed to this workspace and lives in VS Code's own storage,
// so the repository cannot approve itself by editing a file.
//
// Exact command strings are stored rather than a "this workspace is trusted" flag, so that
// editing a command in the repository invalidates the approval and re-prompts.
const APPROVED_COMMANDS_KEY = 'approvedAliasCommands';

let _extensionContext = null;

function setExtensionContext(context) {
    _extensionContext = context;
}

// No usable workspace state means no stored approvals, so nothing extra is allowed to run.
function getWorkspaceState() {
    return _extensionContext && _extensionContext.workspaceState
        ? _extensionContext.workspaceState
        : null;
}

function getApprovedCommands() {
    const state = getWorkspaceState();
    return state ? toCommandList(state.get(APPROVED_COMMANDS_KEY)) : [];
}

function approveCommandsForWorkspace(commands) {
    const state = getWorkspaceState();
    if (!state) return Promise.reject(new Error('No workspace state available to store the approval'));

    const merged = [...new Set([...getApprovedCommands(), ...commands])];
    return Promise.resolve(state.update(APPROVED_COMMANDS_KEY, merged));
}

// Announced once per distinct set per session, since alias regeneration runs on every file change.
const _announcedWorkspaceCommands = new Set();

function announceWorkspaceCommands(pending) {
    const signature = JSON.stringify(pending);
    if (_announcedWorkspaceCommands.has(signature)) return;
    _announcedWorkspaceCommands.add(signature);

    warn(`This workspace asks to run ${pending.length} command(s) after each alias regeneration, but workspace settings cannot run commands on their own:`);
    pending.forEach(c => warn(`    ${c}`));
    warn('Approve them for this workspace from the notification, or put them in require-on-rails.onAliasesRegenerated in your User settings to run them in every workspace.');

    const review = 'Review Commands';
    vscode.window.showWarningMessage(
        `RequireOnRails: this workspace wants to run ${pending.length} command(s) after aliases regenerate. They are being ignored until you approve them.`,
        review,
        'Dismiss'
    ).then(choice => {
        if (choice !== review) return;
        if (!getWorkspaceState()) {
            vscode.window.showErrorMessage('RequireOnRails: cannot store an approval right now. See the RequireOnRails output for the commands.');
            return;
        }

        const enable = 'Approve for This Workspace';
        return vscode.window.showWarningMessage(
            `Run ${pending.length === 1 ? 'this command' : `these ${pending.length} commands`} whenever RequireOnRails regenerates aliases in this workspace?`,
            {
                modal: true,
                detail: `${pending.join('\n')}\n\nThis workspace supplied them. RequireOnRails has not checked what they do, and they will run with your permissions from the workspace root. The approval applies to this workspace only, and is withdrawn automatically if the commands change.`
            },
            enable
        ).then(confirm => {
            if (confirm !== enable) return;
            return approveCommandsForWorkspace(pending).then(
                () => vscode.window.showInformationMessage('RequireOnRails: approved for this workspace. They will run on the next alias regeneration.'),
                e => {
                    error('Failed to store onAliasesRegenerated approval:', e);
                    vscode.window.showErrorMessage('RequireOnRails: could not store the approval. See the RequireOnRails output for details.');
                }
            );
        });
    });
}

// Ambiguity is re-detected on every regeneration, which fires on every file change, so the
// notification is tied to *what* is ambiguous rather than to each run. Storing the last
// announced set (instead of every set ever seen) means clearing an ambiguity and reintroducing
// it warns again, while an unchanged ambiguity stays quiet.
let _lastAmbiguousSignature = null;

function resetAmbiguityNotificationState() {
    _lastAmbiguousSignature = null;
}

// Deliberately a non-modal warning: warnings persist in the notification area until the user
// dismisses them, so it still needs acknowledging, but it cannot stack up a modal dialog on a
// hot path that runs after every file change.
function announceAmbiguousAliases(ambiguousAliases) {
    const names = Object.keys(ambiguousAliases).sort();
    const signature = JSON.stringify(names);
    if (signature === _lastAmbiguousSignature) return;
    _lastAmbiguousSignature = signature;

    if (names.length === 0) return;

    const summary = names.length === 1
        ? `alias "${names[0]}" is ambiguous`
        : `${names.length} aliases are ambiguous (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''})`;

    warn(`${summary}. Requires of these names will not resolve:`);
    names.forEach(name => warn(`    "${name}" found in: ${ambiguousAliases[name].join(', ')}`));

    const showDetails = 'Show Details';
    const showProblems = 'Show Problems';
    vscode.window.showWarningMessage(
        `RequireOnRails: ${summary}, so no alias was generated for ${names.length === 1 ? 'it' : 'them'}. ` +
        `Requires using ${names.length === 1 ? 'that name' : 'those names'} will fail to resolve.`,
        showDetails,
        showProblems,
        'Dismiss'
    ).then(choice => {
        if (choice === showDetails) {
            showOutputChannel();
        } else if (choice === showProblems) {
            vscode.commands.executeCommand('workbench.actions.view.problems');
        }
    });
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

    // Ambiguous aliases (multiple files with the same basename), mapped to the conflicting
    // paths so both the notification and the Problems-panel diagnostics can name them.
    const ambiguousAliases = {};
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

    trace(`Final aliases: ${JSON.stringify(compiledAliases, null, 2)}`);
    // Note: candidates != files seen - files skipped, because a directory's init file
    // contributes a folder-name candidate as well as being skipped under its own name.
    debug(
        `--- Alias generation finished --- roots: ${rootDirs.length}, dirs scanned: ${stats.dirsScanned}, ` +
        `dirs pruned: ${stats.dirsPruned}, files seen: ${stats.filesSeen}, files skipped: ${stats.filesRejected}, ` +
        `alias candidates: ${stats.filesAdded}, ambiguous names dropped: ${Object.keys(ambiguousAliases).length}, ` +
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

    // An ambiguous name silently produces no alias, so every require of it breaks. Warn the
    // user directly; extension.js turns the returned map into Problems-panel diagnostics.
    announceAmbiguousAliases(ambiguousAliases);

    // Run post-regeneration scripts. Commands come from the user's own settings (which they
    // chose for every workspace) plus anything they explicitly approved for this workspace.
    // Skipped entirely in untrusted workspaces.
    const { userCommands, workspaceCommands } = getAliasCommands(config);
    if (!vscode.workspace.isTrusted) {
        // Nothing runs and nothing is offered until the workspace is trusted, so that the
        // trust prompt stays the first gate rather than this one.
        if (userCommands.length > 0 || workspaceCommands.length > 0) {
            warn('onAliasesRegenerated: skipping commands in untrusted workspace');
        }
    } else {
        const approved = getApprovedCommands();
        const pending = workspaceCommands.filter(c => !userCommands.includes(c) && !approved.includes(c));
        if (pending.length > 0) {
            announceWorkspaceCommands(pending);
        }

        const toRun = [...userCommands, ...workspaceCommands.filter(c => approved.includes(c))];
        if (toRun.length > 0) {
            _scheduleAliasCommands(toRun, workspaceRoot);
        }
    }

    return { aliases: compiledAliases, ambiguousAliases };
}

module.exports = {
    generateFileAliases,
    setExtensionContext,
    resetAmbiguityNotificationState,
    // Exported so aliasDiagnostics can prune the same directories with the same semantics,
    // rather than growing a third copy of this matching logic.
    compileIgnorePatterns,
    findIgnoreMatch
};