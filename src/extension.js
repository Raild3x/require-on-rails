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

let isActive = false;
let statusBarItem;
let toggleStatusBarItem;
let outputChannel;

//----------------------------------------------------------------------------------------------

// Store watcher disposables for enable/disable
let watcherDisposables = [];

// Store event listener disposables for enable/disable
let eventListenerDisposables = [];

// --- Watcher Management ---

function enableWatchers() {
    // Helper to create a watcher for a glob pattern and hook up all events to the same handler
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
}

function disableWatchers() {
    watcherDisposables.forEach(sub => sub.dispose());
    watcherDisposables = [];
}

// --- Event Listener Management ---

function enableEventListeners() {
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

    // Alias *requires* live in file contents, but the .lua/.luau watchers deliberately ignore
    // change events (contents cannot change the alias set), so a save is the only signal that
    // a require was added, removed, or fixed. Only the diagnostics need refreshing here.
    const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.languageId !== 'luau' && document.languageId !== 'lua') return;
        refreshAliasDiagnostics();
    });
    eventListenerDisposables.push(saveListener);

    // Listen for file renames (future: update require names)
    const renameListener = vscode.workspace.onDidRenameFiles((event) => {
        event.files.forEach((file) => {
            //print(`File renamed from ${file.oldUri.fsPath} to ${file.newUri.fsPath}`);
            updateRequireNames(file.newUri.fsPath, file.oldUri.fsPath);
        });
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
function registerCommand(context, commandId, handler) {
    const command = vscode.commands.registerCommand(commandId, handler);
    context.subscriptions.push(command);
    return command;
}

// Debounce utility (shared instance for all watchers)
let debounceTimer = null;
let debouncePending = false;
let isGeneratingAliases = false;
const CONTEXTUAL_IMPORT_PLACEHOLDER = '{IMPORT_MODULE_PATH}';

// Settings that change the generated alias set, and so must trigger a regeneration.
const ALIAS_CONFIG_KEYS = ['directoriesToScan', 'ignoreDirectories', 'pathPriority', 'manualAliases'];

// Every regeneration path goes through here, so alias diagnostics can never drift out of sync
// with the .luaurc that was just written. generateFileAliases returns undefined when it bails
// early (no workspace folder, unparseable .luaurc), in which case there is nothing to report on.
function regenerateAliasesAndDiagnostics() {
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

function activate(context) {
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
        const items = [
            isActive
                ? { label: '$(circle-slash) Deactivate', description: 'Turn off RequireOnRails features', command: 'require-on-rails.toggleActive' }
                : { label: '$(play) Activate', description: 'Turn on RequireOnRails features', command: 'require-on-rails.toggleActive' },
            { label: '$(sync) Regenerate Aliases', description: 'Force alias regeneration and show the log', command: 'require-on-rails.regenerateAliases' },
            { label: '$(cloud-download) Download Luau Module', description: 'Get the RequireOnRails Luau module', command: 'require-on-rails.downloadLuauModule' },
            { label: '$(new-folder) Setup Default Project Structure', description: 'Unpack the starter project template', command: 'require-on-rails.setupDefaultProject' },
            { label: '$(edit) Add Import Definition to All Files', description: 'Insert the import require def where missing', command: 'require-on-rails.addImportToAllFiles' },
            { label: '$(terminal) Manage Alias Regeneration Commands', description: 'Approve or revoke workspace onAliasesRegenerated commands', command: 'require-on-rails.manageAliasCommands' },
            { label: '$(gear) Open Extension Settings', description: 'Open RequireOnRails settings', command: 'workbench.action.openSettings', args: 'require-on-rails' },
            { label: '$(arrow-up) Check for Updates', description: 'Check for RequireOnRails package updates', command: 'require-on-rails.checkForUpdates' },
        ];
        const pick = await vscode.window.showQuickPick(items, { placeHolder: 'RequireOnRails' });
        if (pick) {
            vscode.commands.executeCommand(pick.command, pick.args);
        }
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
        downloadLuauModule(context);
    });

    registerCommand(context, 'require-on-rails.addImportToAllFiles', () => {
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