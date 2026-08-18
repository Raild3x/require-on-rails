const vscode = require('vscode');
const path = require('path');
const {
    generateFileAliases,
    setExtensionContext,
    resetAmbiguityNotificationState,
    getAliasCommandApprovalState,
    setApprovedCommands
} = require('./features/updateLuaFileAliases');
const {
    refreshAliasDiagnostics,
    setAmbiguousAliases,
    clearAliasDiagnostics,
    disposeAliasDiagnostics
} = require('./features/aliasDiagnostics');
const { updateRequireNames } = require('./features/updateRequireNames');
const { hideLines, unhideLines } = require('./features/hideLines');
const { unpackProjectTemplate } = require('./commands/unpackProjectTemplate');
const { downloadLuauModule } = require('./commands/downloadLuauModule');
const { addImportToAllFiles } = require('./features/addImportToFiles');
const { setOutputChannel, print, warn, error, debug } = require('./core/logger');
const { checkForPackageUpdatesWithSkip, checkForPackageUpdates } = require('./features/packageUpdateChecker');
const { getMode, runtimeModuleRequired } = require('./utils/workspaceUtils');
const pathResolver = require('./features/pathResolver');
const explicitMode = require('./features/explicitMode');

let isActive = false;
/** @type {import('vscode').StatusBarItem | undefined} */
let statusBarItem;
/** @type {import('vscode').StatusBarItem | undefined} */
let toggleStatusBarItem;
/** @type {import('vscode').LogOutputChannel} */
let outputChannel;

//----------------------------------------------------------------------------------------------

// Store watcher disposables for enable/disable
/** @type {import('vscode').Disposable[]} */
let watcherDisposables = [];

// Store event listener disposables for enable/disable
/** @type {import('vscode').Disposable[]} */
let eventListenerDisposables = [];

// --- Watcher Management ---

function enableWatchers() {
    // Helper to create a watcher for a glob pattern and hook up all events to the same handler
    /**
     * @param {import('vscode').GlobPattern} glob
     * @param {boolean} onChange
     * @param {(uri: import('vscode').Uri) => void} handler
     */
    function createWatcher(glob, onChange, handler) {
        print(`Creating watcher for glob: ${glob}`);
        const watcher = vscode.workspace.createFileSystemWatcher(glob);
        watcher.onDidCreate(handler);
        watcher.onDidDelete(handler);
        if (onChange) watcher.onDidChange(handler);
        watcherDisposables.push(watcher);
    }

    createWatcher('**/*.luau', false, (data) => {
        print('Luau file changed, regenerating aliases...', data.path);
        debouncedGenerateFileAliases();
    });
    createWatcher('**/*.lua', false, (data) => {
        print('Lua file changed, regenerating aliases...', data.path);
        debouncedGenerateFileAliases();
    });
    createWatcher('**/settings.json', true, () => {
        print('settings.json changed, regenerating aliases...');
        debouncedGenerateFileAliases();
    });
    createWatcher('**/settings.jsonc', true, () => {
        print('settings.jsonc changed, regenerating aliases...');
        debouncedGenerateFileAliases();
    });

    // Explicit mode reads .luaurc (user-maintained) and the Rojo project instead of writing
    // them, so edits to either must refresh the resolver context. NOT watched in dynamic
    // mode: the extension writes .luaurc there, which would create a feedback loop.
    if (getMode() === 'explicit') {
        createWatcher('**/.luaurc', true, () => {
            print('.luaurc changed, refreshing module index...');
            debouncedGenerateFileAliases();
        });
        const config = vscode.workspace.getConfiguration('require-on-rails');
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            const folder = vscode.workspace.workspaceFolders[0];
            // Both are watched: the sourcemap is the preferred source, the project file the
            // fallback, and either can appear or change at any time. Rojo rewriting the
            // sourcemap on every save is absorbed by the existing debounce.
            for (const [label, relativePath] of [
                ['Rojo project', config.get('rojoProjectPath', 'default.project.json')],
                ['Rojo sourcemap', config.get('sourcemapPath', 'sourcemap.json')]
            ]) {
                createWatcher(new vscode.RelativePattern(folder, relativePath), true, () => {
                    print(`${label} changed, refreshing module index...`);
                    debouncedGenerateFileAliases();
                });
            }
        }
    }
}

function disableWatchers() {
    watcherDisposables.forEach(sub => sub.dispose());
    watcherDisposables = [];
}

// --- Event Listener Management ---

function enableEventListeners() {
    // The import-block UI (insertion prompts + dimming) only makes sense when the runtime
    // Luau module is in play: dynamic mode, or explicit mode with alias-rooted paths.
    if (runtimeModuleRequired()) {
        // Listen for active editor changes to hide lines in Luau files
        const textEditorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor && (editor.document.languageId === 'luau' || editor.document.languageId === 'lua')) {
                hideLines(editor);
            }
        });
        eventListenerDisposables.push(textEditorListener);

        // Listen for document changes to hide lines in Luau files
        const textDocumentListener = vscode.workspace.onDidChangeTextDocument((event) => {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document === event.document &&
                (editor.document.languageId === 'luau' || editor.document.languageId === 'lua')) {
                // Use a small delay to ensure the document has been fully updated
                setTimeout(() => {
                    hideLines(editor);
                }, 10);
            }
        });
        eventListenerDisposables.push(textDocumentListener);

        // Listen for when documents are opened to apply decorations
        const documentOpenListener = vscode.workspace.onDidOpenTextDocument((document) => {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document === document &&
                (document.languageId === 'luau' || document.languageId === 'lua')) {
                hideLines(editor);
            }
        });
        eventListenerDisposables.push(documentOpenListener);
    }

    // Completion, auto-replace, and the on-save sweep only exist in explicit mode.
    if (getMode() === 'explicit') {
        eventListenerDisposables.push(...explicitMode.registerExplicitFeatures());
    }

    // Alias *requires* live in file contents, but the .lua/.luau watchers deliberately ignore
    // change events (contents cannot change the alias set), so a save is the only signal that
    // a require was added, removed, or fixed. Only the diagnostics need refreshing here.
    const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.languageId !== 'luau' && document.languageId !== 'lua') return;
        refreshAliasDiagnostics();
    });
    eventListenerDisposables.push(saveListener);

    // Listen for file renames to update require statements
    const renameListener = vscode.workspace.onDidRenameFiles((event) => {
        if (getMode() === 'explicit') {
            // Full-path rewrites: inbound requires prompted, outbound relative fixed.
            explicitMode.handleRenameEventExplicit(event.files);
        } else {
            event.files.forEach((file) => {
                updateRequireNames(file.newUri.fsPath, file.oldUri.fsPath);
            });
        }
        // Renaming a *folder* only emits watcher events for the folder path, which matches
        // neither **/*.luau nor **/*.lua, so the watchers never fire. A folder holding an
        // init file owns an alias named after the folder, and every file under a renamed
        // folder has a stale alias path, so regenerate here instead.
        // ponytail: only covers renames made through VS Code; external renames (git checkout,
        // OS file explorer) still need a manual "Regenerate Aliases". Add a '**' directory
        // watcher if that turns out to matter.
        debouncedGenerateFileAliases();
    });
    eventListenerDisposables.push(renameListener);
}

function disableEventListeners() {
    eventListenerDisposables.forEach(sub => sub.dispose());
    eventListenerDisposables = [];
}

//----------------------------------------------------------------------------------------------
// --- Extension Feature Toggle ---

function enableExtensionFeatures() {
    isActive = true;

    // Ensure clean state before enabling
    disableWatchers();
    disableEventListeners();

    enableWatchers();
    enableEventListeners();

    regenerateAliasesAndDiagnostics();
    setStatusBarText();
}

function disableExtensionFeatures() {
    isActive = false;

    disableWatchers();
    disableEventListeners();

    setStatusBarText();

    // Stale squiggles would otherwise outlive the feature that produced them, and the next
    // enable should re-warn about any ambiguity that is still present.
    clearAliasDiagnostics();
    resetAmbiguityNotificationState();

    unhideLines(vscode.window.activeTextEditor);
}

function setStatusBarText() {
    if (statusBarItem) {
        statusBarItem.text = isActive ? '$(check) RequireOnRails' : '$(circle-slash) RequireOnRails';
        statusBarItem.tooltip = 'Open RequireOnRails menu';
    }
    if (toggleStatusBarItem) {
        toggleStatusBarItem.text = isActive ? '$(debug-stop)' : '$(play)';
        toggleStatusBarItem.tooltip = isActive ? 'Deactivate RequireOnRails' : 'Activate RequireOnRails';
    }
}

//----------------------------------------------------------------------------------------------

function toggleExtension() {
    if (!isActive) {
        enableExtensionFeatures();
    } else {
        disableExtensionFeatures();
    }
}

// Helper function to register commands
/**
 * @param {import('vscode').ExtensionContext} context
 * @param {string} commandId
 * @param {Parameters<typeof vscode.commands.registerCommand>[1]} handler
 */
function registerCommand(context, commandId, handler) {
    const command = vscode.commands.registerCommand(commandId, handler);
    context.subscriptions.push(command);
    return command;
}

// Debounce utility (shared instance for all watchers)
/** @type {ReturnType<typeof setTimeout> | null} */
let debounceTimer = null;
let debouncePending = false;
let isGeneratingAliases = false;
const CONTEXTUAL_IMPORT_PLACEHOLDER = '{IMPORT_MODULE_PATH}';

// Settings that change the generated alias set (dynamic) or the module index (explicit),
// and so must trigger a regeneration.
const ALIAS_CONFIG_KEYS = ['directoriesToScan', 'ignoreDirectories', 'pathPriority', 'manualAliases', 'preferRelativePaths', 'rojoProjectPath', 'sourcemapPath'];

// Settings that change which watchers/listeners/providers should exist, requiring a full
// feature rewire rather than just a regeneration.
const REWIRE_CONFIG_KEYS = ['mode', 'explicitPathStyle'];

// Every regeneration path goes through here, so alias diagnostics can never drift out of sync
// with what was just computed. Dynamic mode writes .luaurc; explicit mode NEVER touches it and
// rebuilds the in-memory module index instead. generateFileAliases returns undefined when it
// bails early (no workspace folder, unparseable .luaurc).
function regenerateAliasesAndDiagnostics() {
    if (getMode() === 'explicit') {
        const ctx = pathResolver.refreshContext();
        if (!ctx) return;
        refreshAliasDiagnostics();
        return { aliases: {}, ambiguousAliases: {} };
    }

    const result = generateFileAliases();
    if (!result) return result;

    setAmbiguousAliases(result.ambiguousAliases);
    refreshAliasDiagnostics();
    return result;
}

function debouncedGenerateFileAliases() {
    if (isGeneratingAliases) return; // Prevent recursive calls

    debouncePending = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
        debounceTimer = null;
        if (debouncePending && !isGeneratingAliases) {
            debouncePending = false;
            isGeneratingAliases = true;
            try {
                await regenerateAliasesAndDiagnostics();
            } finally {
                isGeneratingAliases = false;
            }
        }
    }, 500);
}

/**
 * @param {unknown} template
 * @param {boolean} [showWarning]
 */
function validateContextualImportTemplate(template, showWarning = true) {
    const isValid =
        typeof template === 'string' &&
        template.includes(CONTEXTUAL_IMPORT_PLACEHOLDER);

    if (!isValid && showWarning) {
        vscode.window.showWarningMessage(
            `RequireOnRails: contextualImportTemplate must include ${CONTEXTUAL_IMPORT_PLACEHOLDER}. Falling back to default template.`
        );
    }

    return isValid;
}

/** @param {import('vscode').ExtensionContext} context */
function activate(context) {
    // Start from a known-inactive state with nothing left registered. VS Code activates an
    // extension once per host, so in production this is a no-op — but activate() must not
    // inherit state, or a second activation reads isActive as true and the startsImmediately
    // toggle below turns the extension *off* instead of on.
    isActive = false;
    disableWatchers();
    disableEventListeners();

    const config = vscode.workspace.getConfiguration('require-on-rails');
    const contextualImportTemplate = config.get('contextualImportTemplate', '');

    // Create output channel for logging. `{ log: true }` makes this a LogOutputChannel, so
    // verbosity is controlled by the user via the Output panel's gear icon (or the
    // "Developer: Set Log Level..." command) rather than an extension setting.
    outputChannel = vscode.window.createOutputChannel('RequireOnRails', { log: true });
    context.subscriptions.push(outputChannel);
    setOutputChannel(outputChannel);

    // Needed for workspaceState, where per-workspace onAliasesRegenerated approvals are kept.
    setExtensionContext(context);

    print('RequireOnRails extension activated');

    validateContextualImportTemplate(contextualImportTemplate, true);

    const configChangeListener = vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('require-on-rails.contextualImportTemplate')) {
            const updatedTemplate = vscode.workspace
                .getConfiguration('require-on-rails')
                .get('contextualImportTemplate', '');

            validateContextualImportTemplate(updatedTemplate, true);
        }

        // Mode/style changes swap which watchers, listeners, and providers should exist,
        // so tear everything down and bring it back up under the new configuration.
        const changedRewireSetting = REWIRE_CONFIG_KEYS.find(key =>
            event.affectsConfiguration(`require-on-rails.${key}`)
        );
        if (changedRewireSetting) {
            pathResolver.invalidateContext();
            if (isActive) {
                debug(`Setting "require-on-rails.${changedRewireSetting}" changed; rewiring extension features.`);
                disableExtensionFeatures();
                enableExtensionFeatures();
            }
            return;
        }

        // The settings.json watcher only catches workspace-file edits, so global-scope changes
        // to these would otherwise never take effect until the next file change.
        const changedAliasSetting = ALIAS_CONFIG_KEYS.find(key =>
            event.affectsConfiguration(`require-on-rails.${key}`)
        );
        if (changedAliasSetting && isActive) {
            debug(`Setting "require-on-rails.${changedAliasSetting}" changed; regenerating aliases.`);
            debouncedGenerateFileAliases();
        }
    });
    context.subscriptions.push(configChangeListener);
    
    // Check if workspace folders exist before accessing
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        print('No workspace folder found. RequireOnRails will be available when a folder is opened.');
    } else {
        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        print('Activating RequireOnRails extension with workspace root:', workspaceRoot);
        
        // Check for package updates after a short delay
        setTimeout(async () => {
            await checkForPackageUpdatesWithSkip(workspaceRoot);
        }, 2000);
    }

    // Status bar: name opens the menu, adjacent icon button toggles (Rojo-style pair)
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'require-on-rails.openMenu';
    toggleStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    toggleStatusBarItem.command = 'require-on-rails.toggleActive';
    setStatusBarText();
    statusBarItem.show();
    toggleStatusBarItem.show();
    context.subscriptions.push(statusBarItem, toggleStatusBarItem);

    // Register commands using helper function
    registerCommand(context, 'require-on-rails.openMenu', async () => {
        // Entries irrelevant to the current mode/style are hidden rather than disabled:
        // alias lifecycle actions are dynamic-only, import-block actions need the runtime
        // module, and explicit-path actions only exist in explicit mode.
        const mode = getMode();
        const isExplicit = mode === 'explicit';
        const items = /** @type {{label: string, description: string, command: string, args?: string}[]} */ ([
            isActive
                ? { label: '$(circle-slash) Deactivate', description: 'Turn off RequireOnRails features', command: 'require-on-rails.toggleActive' }
                : { label: '$(play) Activate', description: 'Turn on RequireOnRails features', command: 'require-on-rails.toggleActive' },
            { label: `$(arrow-swap) Switch Mode (current: ${mode})`, description: 'Choose dynamic alias generation or explicit path writing', command: 'require-on-rails.selectMode' },
            isExplicit
                ? { label: '$(sync) Rescan Modules', description: 'Refresh the module index and diagnostics, and show the log', command: 'require-on-rails.regenerateAliases' }
                : { label: '$(sync) Regenerate Aliases', description: 'Force alias regeneration and show the log', command: 'require-on-rails.regenerateAliases' },
            isExplicit
                ? { label: '$(replace-all) Rewrite All Requires to Current Style', description: 'Re-render every resolvable require string', command: 'require-on-rails.rewriteAllRequires' }
                : null,
            runtimeModuleRequired()
                ? { label: '$(cloud-download) Download Luau Module', description: 'Get the RequireOnRails Luau module', command: 'require-on-rails.downloadLuauModule' }
                : null,
            { label: '$(new-folder) Setup Default Project Structure', description: 'Unpack the starter project template', command: 'require-on-rails.setupDefaultProject' },
            runtimeModuleRequired()
                ? { label: '$(edit) Add Import Definition to All Files', description: 'Insert the import require def where missing', command: 'require-on-rails.addImportToAllFiles' }
                : null,
            !isExplicit
                ? { label: '$(terminal) Manage Alias Regeneration Commands', description: 'Approve or revoke workspace onAliasesRegenerated commands', command: 'require-on-rails.manageAliasCommands' }
                : null,
            { label: '$(gear) Open Extension Settings', description: 'Open RequireOnRails settings', command: 'workbench.action.openSettings', args: 'require-on-rails' },
            { label: '$(arrow-up) Check for Updates', description: 'Check for RequireOnRails package updates', command: 'require-on-rails.checkForUpdates' },
        ].filter(Boolean));
        const pick = await vscode.window.showQuickPick(items, { placeHolder: `RequireOnRails (${mode} mode)` });
        if (pick) {
            vscode.commands.executeCommand(pick.command, pick.args);
        }
    });

    registerCommand(context, 'require-on-rails.selectMode', async () => {
        const current = getMode();
        const pick = await vscode.window.showQuickPick([
            {
                label: 'dynamic',
                description: (current === 'dynamic' ? '(current) ' : '') + 'Generate basename aliases into .luaurc, resolved at runtime by the Luau module'
            },
            {
                label: 'explicit',
                description: (current === 'explicit' ? '(current) ' : '') + 'Write full require paths into your source at edit time; .luaurc is yours to maintain'
            }
        ], { placeHolder: `How should requires be resolved? (current: ${current})` });
        if (!pick || pick.label === current) return;
        await vscode.workspace.getConfiguration('require-on-rails')
            .update('mode', pick.label, vscode.ConfigurationTarget.Workspace);
        // The configuration listener performs the rewire; just confirm.
        vscode.window.showInformationMessage(`RequireOnRails: switched to ${pick.label} mode for this workspace.`);
    });

    registerCommand(context, 'require-on-rails.rewriteAllRequires', () => {
        if (getMode() !== 'explicit') {
            vscode.window.showInformationMessage('RequireOnRails: "Rewrite All Requires" is an explicit-mode action. Switch mode first (RequireOnRails: Select Mode).');
            return;
        }
        explicitMode.rewriteAllRequires();
    });

    registerCommand(context, 'require-on-rails.toggleActive', () => {
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            vscode.window.showWarningMessage('RequireOnRails: Please open a folder first.');
            return;
        }
        toggleExtension();
    });

    registerCommand(context, 'require-on-rails.setupDefaultProject', () => {
        unpackProjectTemplate(context);
    });

    registerCommand(context, 'require-on-rails.downloadLuauModule', () => {
        if (!runtimeModuleRequired()) {
            vscode.window.showInformationMessage('RequireOnRails: the Luau module is not needed with the current mode/path style — Roblox resolves these require paths natively.');
            return;
        }
        downloadLuauModule(context);
    });

    registerCommand(context, 'require-on-rails.addImportToAllFiles', () => {
        if (!runtimeModuleRequired()) {
            vscode.window.showInformationMessage('RequireOnRails: the import block is not needed with the current mode/path style — Roblox resolves these require paths natively.');
            return;
        }
        addImportToAllFiles();
    });

    registerCommand(context, 'require-on-rails.regenerateAliases', () => {
        // This command exists for debugging, so surface the log. Set the channel's level to
        // Debug (gear icon in the Output panel) to see every scan/skip decision.
        outputChannel.show(true);
        // Run unconditionally, so this stays usable for diagnosing a workspace where the
        // ambiguity warning has already been dismissed this session.
        resetAmbiguityNotificationState();
        regenerateAliasesAndDiagnostics();
    });

    // The approval notification only announces itself once per session, so this is the way back
    // to the decision after it has been dismissed or missed, and the only way to revoke one.
    // No modal confirmation here: invoking this command *is* the deliberate act, and the picker
    // already shows each command verbatim.
    registerCommand(context, 'require-on-rails.manageAliasCommands', async () => {
        const { userCommands, workspaceCommands, approved, canApprove } = getAliasCommandApprovalState();

        if (workspaceCommands.length === 0) {
            vscode.window.showInformationMessage(
                'RequireOnRails: this workspace does not request any onAliasesRegenerated commands.' +
                (userCommands.length > 0
                    ? ` Your User settings supply ${userCommands.length}, which run in every workspace and need no approval.`
                    : '')
            );
            return;
        }

        if (!canApprove) {
            vscode.window.showErrorMessage('RequireOnRails: no workspace storage is available, so approvals cannot be saved right now.');
            return;
        }

        const picks = await vscode.window.showQuickPick(
            workspaceCommands.map(command => ({
                label: command,
                picked: approved.includes(command),
                description: userCommands.includes(command) ? 'also in your User settings' : undefined
            })),
            {
                canPickMany: true,
                title: 'Commands this workspace runs after aliases regenerate',
                placeHolder: 'Checked commands run from the workspace root with your permissions. Unchecked commands are ignored.'
            }
        );

        // Escaping leaves the current approvals alone; an empty selection is a real answer.
        if (!picks) return;

        try {
            await setApprovedCommands(picks.map(pick => pick.label));
        } catch (e) {
            error('Failed to store onAliasesRegenerated approval:', e);
            vscode.window.showErrorMessage('RequireOnRails: could not store the approval. See the RequireOnRails output for details.');
            return;
        }

        vscode.window.showInformationMessage(
            picks.length === 0
                ? 'RequireOnRails: no workspace commands are approved. None will run.'
                : `RequireOnRails: approved ${picks.length} command(s) for this workspace. They run on the next alias regeneration.`
        );
    });

    registerCommand(context, 'require-on-rails.checkForUpdates', async () => {
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            await checkForPackageUpdates(workspaceRoot);
        } else {
            vscode.window.showWarningMessage('RequireOnRails: Please open a folder first.');
        }
    });

    // Clean up on deactivate
    context.subscriptions.push({
        dispose: () => {
            disableExtensionFeatures();
            disposeAliasDiagnostics();
        }
    });

    // First activation in a workspace: ask which mode to use and store the answer in
    // workspace settings. Dismissal writes nothing — behavior stays dynamic (the setting's
    // default) and the choice is re-offered next activation and via the menu.
    const modeInspection = config.inspect('mode');
    const hasModeChoice = modeInspection?.workspaceValue !== undefined
        || modeInspection?.workspaceFolderValue !== undefined
        || modeInspection?.globalValue !== undefined;
    if (!hasModeChoice && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        const dynamicChoice = 'Dynamic (aliases + runtime module)';
        const explicitChoice = 'Explicit (full paths)';
        vscode.window.showInformationMessage(
            'RequireOnRails: how should requires be resolved in this workspace?',
            dynamicChoice,
            explicitChoice
        ).then(choice => {
            if (!choice) return;
            const mode = choice === explicitChoice ? 'explicit' : 'dynamic';
            return vscode.workspace.getConfiguration('require-on-rails')
                .update('mode', mode, vscode.ConfigurationTarget.Workspace);
        });
    }

    if (config.get("startsImmediately") && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        print('RequireOnRails is starting immediately as per configuration.');
        toggleExtension();
    }
}

// This method is called when your extension is deactivated
function deactivate() {
    print('Deactivating RequireOnRails...');
    disableExtensionFeatures();
}


module.exports = {
	activate,
	deactivate
}