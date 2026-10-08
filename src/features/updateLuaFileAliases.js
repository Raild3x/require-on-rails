const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
// Optional so this module loads outside the editor (e.g. in headless tests); only the
// editor-facing functions below dereference it.
/** @type {typeof import('vscode') | null} */
let vscode = null;
try { vscode = require('vscode'); } catch (e) { /* running outside VS Code */ }
const { print, warn, error, debug, trace, showOutputChannel } = require('../core/logger');
const { classifyBasenames, readLuaurc, normalizeAliases, renderLuaurc } = require('../core/projectIndex');
// Required lazily inside the editor-only functions, since workspaceUtils' settings accessors
// are editor-only.
/** @returns {typeof import('../utils/workspaceUtils')} */
function workspaceUtils() {
    return require('../utils/workspaceUtils');
}

const extenionName = 'require-on-rails';

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
    // Hooks in the Project settings file are workspace-supplied by definition — the file is
    // committed — so they join the workspace list and need the same approval (ADR 0004).
    const fromProjectFile = toCommandList(workspaceUtils().getProjectFileValues()[settingKey]);
    const workspaceCommands = toCommandList(inspected.workspaceFolderValue ?? inspected.workspaceValue);
    return {
        userCommands: toCommandList(inspected.globalValue),
        workspaceCommands: [...fromProjectFile, ...workspaceCommands.filter(c => !fromProjectFile.includes(c))]
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

// Main function to generate file aliases
function generateFileAliases() {
    if (!vscode) return;

    // Check if workspace folders exist
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        print('No workspace folder found. Skipping alias generation.');
        return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;

    // Settings come from the resolved chain (Project settings file > editor config >
    // defaults), which already picks one scope for manualAliases rather than merging them.
    const settings = workspaceUtils().getSettings();
    const rawPathPriority = /** @type {string[]} */ (settings['pathPriority']);
    const pathPriority = Array.isArray(rawPathPriority) ? rawPathPriority : [];
    const manualAliases = /** @type {Object<string, string>} */ (settings['manualAliases'] ?? {});
    const luaurcPath = path.join(workspaceRoot, '.luaurc');

    debug(`--- Alias generation started ---`);
    debug(`workspaceRoot: ${workspaceRoot}`);
    debug(`pathPriority: ${JSON.stringify(pathPriority)}`);
    debug(`manualAliases: ${JSON.stringify(manualAliases)}`);

    // Every generation is a fresh walk, so the editor's cached index is refreshed here rather
    // than scanned twice — first, so the file list stays current even if .luaurc is broken.
    const ctx = workspaceUtils().refreshContext();
    if (!ctx) return;

    // Read and update the .luaurc file with generated aliases
    // Parsed as JSONC, as Luau does. The rewrite below is plain JSON, so comments in a
    // dynamic-mode .luaurc (a file this mode owns and rewrites on every change) do not survive.
    /** @type {Record<string, any>} */
    let luaurc;
    try {
        luaurc = readLuaurc(workspaceRoot) ?? {};
    } catch (e) {
        error("Failed to parse .luaurc:", e);
        vscode.window.showErrorMessage("RequireOnRails: Failed to parse .luaurc. Please fix or delete the file.");
        return;
    }

    const { aliases: compiledAliases, ambiguousAliases, shadowedByManual } =
        classifyBasenames(ctx.basenameMap, { pathPriority, manualAliases });

    trace(`Final aliases: ${JSON.stringify(compiledAliases, null, 2)}`);
    debug(
        `--- Alias generation finished --- ambiguous names dropped: ${Object.keys(ambiguousAliases).length}, ` +
        `shadowed by manualAliases: ${shadowedByManual}, written to .luaurc: ${Object.keys(compiledAliases).length}`
    );

    fs.writeFileSync(luaurcPath, renderLuaurc(luaurc, compiledAliases));
    // The index read .luaurc before this write; bring it up to date so resolution (explicit
    // features, the build watch) and diagnostics see the set just written.
    ctx.aliases = normalizeAliases(compiledAliases);

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
    setExtensionContext,
    resetAmbiguityNotificationState,
    getAliasCommandApprovalState,
    setApprovedCommands,
    runHookCommands
};