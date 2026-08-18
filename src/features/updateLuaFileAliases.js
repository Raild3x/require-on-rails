const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
// Optional: this module's scanning and classification logic is also used by the CI checker,
// which runs in plain Node where the vscode module does not exist. Only the editor-facing
// functions below dereference it.
/** @type {typeof import('vscode') | null} */
let vscode = null;
try { vscode = require('vscode'); } catch (e) { /* running outside VS Code */ }
const { print, warn, error, debug, trace, showOutputChannel } = require('../core/logger');

const extenionName = 'require-on-rails';
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
 * Helper function to get the absolute path of a directory or file
 * @param {string} workspaceRoot
 * @param {string} filePath
 * @returns {string}
 */
function getDirPath(workspaceRoot, filePath) {
    return path.join(workspaceRoot, filePath);
}

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
// Patterns containing path separators ('/' or '\\') are matched against the workspace-root-relative
// path; all others are matched against the bare directory name.
/**
 * @param {string[]} patterns
 * @returns {CompiledIgnorePattern[]}
 */
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
 * @returns {void}
 */
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


// Serialization state for hook commands (onAliasesRegenerated, buildConversion hooks).
// Only one batch of commands runs at a time; if another trigger fires while commands are
// in-flight, the latest request is queued (previous pending run is dropped).
let _commandsInFlight = false;
/** @type {{ commands: string[], workspaceRoot: string, label: string, env: Record<string, string> } | null} */
let _pendingRun = null;

/**
 * @param {string[]} commands
 * @param {string} workspaceRoot
 * @param {string} label - Setting key, for log lines
 * @param {Record<string, string>} env - Extra environment variables for the commands
 */
function _runCommandsSerial(commands, workspaceRoot, label, env) {
    let index = 0;
    function runNext() {
        if (index >= commands.length) {
            _commandsInFlight = false;
            if (_pendingRun) {
                const next = _pendingRun;
                _pendingRun = null;
                _runCommandsSerial(next.commands, next.workspaceRoot, next.label, next.env);
            }
            return;
        }
        const command = commands[index++];
        exec(command, { cwd: workspaceRoot, env: { ...process.env, ...env } }, (err) => {
            if (err) error(`${label} command failed: "${command}"`, err.message);
            else print(`${label}: ran "${command}"`);
            runNext();
        });
    }
    _commandsInFlight = true;
    runNext();
}

/**
 * @param {string[]} commands
 * @param {string} workspaceRoot
 * @param {string} label
 * @param {Record<string, string>} env
 */
function _scheduleHookCommands(commands, workspaceRoot, label, env) {
    if (_commandsInFlight) {
        _pendingRun = { commands, workspaceRoot, label, env };
        return;
    }
    _runCommandsSerial(commands, workspaceRoot, label, env);
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function toCommandList(value) {
    return Array.isArray(value) ? value.filter(c => typeof c === 'string' && c.length > 0) : [];
}

// Hook commands only ever run from the user's own settings, so that opening a repository
// cannot make RequireOnRails execute arbitrary shell commands. This is enforced here rather
// than with `"scope": "machine"` in package.json, because VS Code strips machine-scoped
// values out of the workspace configuration before `inspect()` can see them, and we need to
// see them in order to tell the user what the workspace was asking for.
/**
 * @param {import('vscode').WorkspaceConfiguration} config
 * @param {string} [settingKey]
 * @returns {{ userCommands: string[], workspaceCommands: string[] }}
 */
function getAliasCommands(config, settingKey = 'onAliasesRegenerated') {
    const inspected = /** @type {{ globalValue?: unknown, workspaceValue?: unknown, workspaceFolderValue?: unknown }} */ (
        config.inspect(settingKey) || {}
    );
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

/** @type {import('vscode').ExtensionContext | null} */
let _extensionContext = null;

/**
 * @param {import('vscode').ExtensionContext} context
 */
function setExtensionContext(context) {
    _extensionContext = context;
}

// No usable workspace state means no stored approvals, so nothing extra is allowed to run.
/** @returns {import('vscode').Memento | null} */
function getWorkspaceState() {
    return _extensionContext && _extensionContext.workspaceState
        ? _extensionContext.workspaceState
        : null;
}

function getApprovedCommands() {
    const state = getWorkspaceState();
    return state ? toCommandList(state.get(APPROVED_COMMANDS_KEY)) : [];
}

/**
 * @param {string[]} commands
 * @returns {Promise<void>}
 */
function approveCommandsForWorkspace(commands) {
    const state = getWorkspaceState();
    if (!state) return Promise.reject(new Error('No workspace state available to store the approval'));

    const merged = [...new Set([...getApprovedCommands(), ...commands])];
    return Promise.resolve(state.update(APPROVED_COMMANDS_KEY, merged));
}

// Announced once per distinct set per session, since alias regeneration runs on every file change.
const _announcedWorkspaceCommands = new Set();

/**
 * @param {string[]} pending
 * @param {string} settingKey
 * @param {string} eventDescription - e.g. "after each alias regeneration"
 */
function announceWorkspaceCommands(pending, settingKey, eventDescription) {
    const signature = JSON.stringify([settingKey, pending]);
    if (_announcedWorkspaceCommands.has(signature)) return;
    _announcedWorkspaceCommands.add(signature);

    warn(`This workspace asks to run ${pending.length} command(s) ${eventDescription}, but workspace settings cannot run commands on their own:`);
    pending.forEach(c => warn(`    ${c}`));
    warn(`Approve them for this workspace from the notification, or put them in require-on-rails.${settingKey} in your User settings to run them in every workspace.`);

    if (!vscode) return;
    const review = 'Review Commands';
    vscode.window.showWarningMessage(
        `RequireOnRails: this workspace wants to run ${pending.length} command(s) ${eventDescription}. They are being ignored until you approve them.`,
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
            `Run ${pending.length === 1 ? 'this command' : `these ${pending.length} commands`} ${eventDescription} in this workspace?`,
            {
                modal: true,
                detail: `${pending.join('\n')}\n\nThis workspace supplied them. RequireOnRails has not checked what they do, and they will run with your permissions from the workspace root. The approval applies to this workspace only, and is withdrawn automatically if the commands change.`
            },
            enable
        ).then(confirm => {
            if (confirm !== enable) return;
            return approveCommandsForWorkspace(pending).then(
                () => vscode.window.showInformationMessage('RequireOnRails: approved for this workspace. They will run on the next trigger.'),
                e => {
                    error(`Failed to store ${settingKey} approval:`, e);
                    vscode.window.showErrorMessage('RequireOnRails: could not store the approval. See the RequireOnRails output for details.');
                }
            );
        });
    });
}

// Runs one hook's commands: the user's own from User settings unconditionally, workspace-
// supplied ones only after per-workspace approval, nothing in untrusted workspaces. The
// shared serial queue keeps batches from different hooks from interleaving.
/**
 * @param {string} settingKey - e.g. 'buildConversion.hooks.onBuildCompleted'
 * @param {string} eventDescription - e.g. "after each project build"
 * @param {Record<string, string>} env - Extra environment variables (ROR_*)
 */
function runHookCommands(settingKey, eventDescription, env) {
    if (!vscode) return;
    const config = vscode.workspace.getConfiguration(extenionName);
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return;

    const { userCommands, workspaceCommands } = getAliasCommands(config, settingKey);
    if (!vscode.workspace.isTrusted) {
        if (userCommands.length > 0 || workspaceCommands.length > 0) {
            warn(`${settingKey}: skipping commands in untrusted workspace`);
        }
        return;
    }

    const approved = getApprovedCommands();
    const pending = workspaceCommands.filter(c => !userCommands.includes(c) && !approved.includes(c));
    if (pending.length > 0) {
        announceWorkspaceCommands(pending, settingKey, eventDescription);
    }

    const toRun = [...userCommands, ...workspaceCommands.filter(c => approved.includes(c))];
    if (toRun.length > 0) {
        _scheduleHookCommands(toRun, workspaceRoot, settingKey, env);
    }
}

// Every hook setting whose workspace-supplied commands go through the shared approval pool.
const HOOK_SETTING_KEYS = ['onAliasesRegenerated', 'buildConversion.hooks.onBuildCompleted', 'buildConversion.hooks.onWatchConverted'];

// Backs the "Manage Alias Regeneration Commands" palette entry. The notification announces
// itself once per session, so without a way in from the palette a dismissed prompt is
// unreachable until the window reloads, and an approval can never be withdrawn. Approvals
// are stored per command string across every hook, so the picker aggregates all hooks.
function getAliasCommandApprovalState() {
    if (!vscode) throw new Error('getAliasCommandApprovalState requires VS Code.');
    const config = vscode.workspace.getConfiguration(extenionName);
    /** @type {string[]} */
    const userCommands = [];
    /** @type {string[]} */
    const workspaceCommands = [];
    for (const key of HOOK_SETTING_KEYS) {
        const forKey = getAliasCommands(config, key);
        userCommands.push(...forKey.userCommands.filter(c => !userCommands.includes(c)));
        workspaceCommands.push(...forKey.workspaceCommands.filter(c => !workspaceCommands.includes(c)));
    }
    return {
        userCommands,
        workspaceCommands,
        approved: getApprovedCommands(),
        canApprove: getWorkspaceState() !== null
    };
}

// Replaces the approved set outright, unlike approveCommandsForWorkspace, which merges. The
// picker shows every workspace command with its current state, so what comes back is the whole
// answer, and deselecting is how a command is revoked. Clearing the announcement cache lets a
// revoked command warn again on the next regeneration instead of staying silently ignored.
/**
 * @param {string[]} commands
 * @returns {Promise<void>}
 */
function setApprovedCommands(commands) {
    const state = getWorkspaceState();
    if (!state) return Promise.reject(new Error('No workspace state available to store the approval'));

    _announcedWorkspaceCommands.clear();
    return Promise.resolve(state.update(APPROVED_COMMANDS_KEY, toCommandList(commands)));
}

// Ambiguity is re-detected on every regeneration, which fires on every file change, so the
// notification is tied to *what* is ambiguous rather than to each run. Storing the last
// announced set (instead of every set ever seen) means clearing an ambiguity and reintroducing
// it warns again, while an unchanged ambiguity stays quiet.
/** @type {string | null} */
let _lastAmbiguousSignature = null;

function resetAmbiguityNotificationState() {
    _lastAmbiguousSignature = null;
}

// Deliberately a non-modal warning: warnings persist in the notification area until the user
// dismisses them, so it still needs acknowledging, but it cannot stack up a modal dialog on a
// hot path that runs after every file change.
/**
 * @param {Object<string, string[]>} ambiguousAliases
 */
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

    if (!vscode) return;
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

// Scans the configured directories and returns the basename -> candidate-file map. This is
// the single source of module-index semantics (folder-init aliasing, .server/.client skip,
// ignoreDirectories pruning): dynamic mode turns it into .luaurc aliases, explicit mode's
// pathResolver turns it into the completion/rewrite index. Resets the per-run stats counters.
//
// Settings arrive as plain values rather than being read from VS Code here, so the CI
// checker can supply them from a parsed settings.json.
/**
 * @param {string} workspaceRoot
 * @param {{directoriesToScan?: string[], ignoreDirectories?: string[]}} [options]
 * @returns {{ basenameMap: BasenameMap, rootDirs: string[] }}
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

    // Map of basename -> array of { path }
    /** @type {BasenameMap} */
    const basenameMap = {};
    rootDirs.forEach(rootDir => {
        print(`Scanning directory: ${rootDir}`);
        scanDir(rootDir, rootDir, supportedExtensions, ignorePatterns, ignoreList, basenameMap, workspaceRoot);
    });

    trace(`Finished scanning. Found basenames: ${JSON.stringify(Object.keys(basenameMap).sort())}`);

    return { basenameMap, rootDirs };
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

// Main function to generate file aliases
function generateFileAliases() {
    if (!vscode) return;
    const config = vscode.workspace.getConfiguration(extenionName);

    // Check if workspace folders exist
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        print('No workspace folder found. Skipping alias generation.');
        return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;

    const rawPathPriority = /** @type {string[]} */ (config.get('pathPriority', []));
    const pathPriority = Array.isArray(rawPathPriority) ? rawPathPriority : [];
    const inspectedManualAliases = config.inspect('manualAliases');
    const manualAliases = /** @type {Object<string, string>} */ ((inspectedManualAliases
        ? (inspectedManualAliases.workspaceFolderValue
            ?? inspectedManualAliases.workspaceValue
            ?? inspectedManualAliases.globalValue
            ?? inspectedManualAliases.defaultValue)
        : null) ?? {});
    const luaurcPath = getDirPath(workspaceRoot, '.luaurc');

    debug(`--- Alias generation started ---`);
    debug(`workspaceRoot: ${workspaceRoot}`);
    debug(`pathPriority: ${JSON.stringify(pathPriority)}`);
    debug(`manualAliases: ${JSON.stringify(manualAliases)}`);

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

    const { basenameMap, rootDirs } = buildBasenameMap(workspaceRoot, {
        directoriesToScan: /** @type {string[]} */ (config.get('directoriesToScan') || []),
        ignoreDirectories: /** @type {string[]} */ (config.get('ignoreDirectories') || [])
    });

    const { aliases: compiledAliases, ambiguousAliases, shadowedByManual } =
        classifyBasenames(basenameMap, { pathPriority, manualAliases });

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
    runHookCommands('onAliasesRegenerated', 'after each alias regeneration', { ROR_EVENT: 'aliases-regenerated' });

    return { aliases: compiledAliases, ambiguousAliases };
}

module.exports = {
    generateFileAliases,
    buildBasenameMap,
    classifyBasenames,
    setExtensionContext,
    resetAmbiguityNotificationState,
    getAliasCommandApprovalState,
    setApprovedCommands,
    runHookCommands,
    // Exported so aliasDiagnostics can prune the same directories with the same semantics,
    // rather than growing a third copy of this matching logic.
    compileIgnorePatterns,
    findIgnoreMatch
};