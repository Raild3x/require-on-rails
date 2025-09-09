const vscode = require('vscode');
const path = require('path');
const { generateFileAliases } = require('./features/updateLuaFileAliases');
const { updateRequireNames } = require('./features/updateRequireNames');
const { hideLines, unhideLines } = require('./features/hideLines');
const { unpackProjectTemplate } = require('./commands/unpackProjectTemplate');
const { downloadLuauModule } = require('./commands/downloadLuauModule');
const { addImportToAllFiles } = require('./features/addImportToFiles');
const { setOutputChannel, print, warn, error } = require('./core/logger');
const { checkForPackageUpdatesWithSkip, checkForPackageUpdates } = require('./features/packageUpdateChecker');
const { processRobloxYml, checkAndOfferSeleneGeneration } = require('./utils/yamlUtils');

let isActive = false;
let statusBarItem;
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
    createWatcher('**/roblox.yml', true, (data) => {
        print('roblox.yml changed, checking require configuration...', data.path);
        processRobloxYml(data.fsPath);
    });
    createWatcher('**/selene.toml', true, (data) => {
        print('selene.toml changed, checking for roblox.yml...', data.path);
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            checkAndOfferSeleneGeneration(workspaceRoot);
        }
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

    // Listen for file renames (future: update require names)
    const renameListener = vscode.workspace.onDidRenameFiles((event) => {
        event.files.forEach((file) => {
            //print(`File renamed from ${file.oldUri.fsPath} to ${file.newUri.fsPath}`);
            updateRequireNames(file.newUri.fsPath, file.oldUri.fsPath);
        });
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

    generateFileAliases();
    scanAndProcessRobloxYmlFiles();
    setStatusBarText();
}

function disableExtensionFeatures() {
    isActive = false;

    disableWatchers();
    disableEventListeners();

    setStatusBarText();

    unhideLines(vscode.window.activeTextEditor);
}

function setStatusBarText() {
    if (statusBarItem) {
        statusBarItem.text = isActive ? '$(check) RequireOnRails: On' : '$(circle-slash) RequireOnRails: Off';
        statusBarItem.tooltip = isActive ? 'Click to deactivate RequireOnRails' : 'Click to activate RequireOnRails';
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
                await generateFileAliases();
            } finally {
                isGeneratingAliases = false;
            }
        }
    }, 500);
}

function activate(context) {
    const config = vscode.workspace.getConfiguration('require-on-rails');
    
    // Create output channel for logging
    outputChannel = vscode.window.createOutputChannel('RequireOnRails');
    context.subscriptions.push(outputChannel);
    setOutputChannel(outputChannel);
    
    print('RequireOnRails extension activated');
    print(config);
    
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

    // Status bar button
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'require-on-rails.toggleActive';
    setStatusBarText();
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Register commands using helper function
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

    registerCommand(context, 'require-on-rails.checkForUpdates', async () => {
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            await checkForPackageUpdates(workspaceRoot);
        } else {
            vscode.window.showWarningMessage('RequireOnRails: Please open a folder first.');
        }
    });

    registerCommand(context, 'require-on-rails.checkRobloxYml', () => {
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            vscode.window.showWarningMessage('RequireOnRails: Please open a folder first.');
            return;
        }
        scanAndProcessRobloxYmlFiles();
        vscode.window.showInformationMessage('RequireOnRails: Checked and processed roblox.yml files.');
    });

    registerCommand(context, 'require-on-rails.generateRobloxYml', async () => {
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            vscode.window.showWarningMessage('RequireOnRails: Please open a folder first.');
            return;
        }
        
        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const { generateSeleneConfig } = require('./utils/yamlUtils');
        
        try {
            const success = await generateSeleneConfig(workspaceRoot);
            if (success) {
                vscode.window.showInformationMessage('RequireOnRails: Successfully generated and configured roblox.yml!');
            } else {
                vscode.window.showErrorMessage('RequireOnRails: Failed to generate roblox.yml. Please check that selene is installed and accessible.');
            }
        } catch (err) {
            vscode.window.showErrorMessage(`RequireOnRails: Error generating roblox.yml: ${err.message}`);
        }
    });

    // Clean up on deactivate
    context.subscriptions.push({
        dispose: () => {
            disableExtensionFeatures();
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

//----------------------------------------------------------------------------------------------
// --- roblox.yml Processing ---

async function scanAndProcessRobloxYmlFiles() {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;

    try {
        print('Scanning for existing roblox.yml files...');
        const robloxYmlFiles = await vscode.workspace.findFiles('**/roblox.yml', '**/node_modules/**');
        
        if (robloxYmlFiles.length === 0) {
            print('No roblox.yml files found in workspace');
            
            // Check if there's a selene.toml but no roblox.yml
            await checkAndOfferSeleneGeneration(workspaceRoot);
        } else {
            print(`Found ${robloxYmlFiles.length} roblox.yml file(s), processing...`);
            
            for (const file of robloxYmlFiles) {
                processRobloxYml(file.fsPath);
            }
            
            print('Finished processing roblox.yml files');
        }
    } catch (err) {
        error('Failed to scan for roblox.yml files:', err.message);
    }
}

//----------------------------------------------------------------------------------------------

module.exports = {
	activate,
	deactivate
}