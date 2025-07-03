const vscode = require('vscode');
// const path = require('path');
const { generateFileAliases } = require('./updateLuaFileAliases');
const { updateRequireNames } = require('./updateRequireNames');
const { hideLines, unhideLines } = require('./hideLines');
const { unpackProjectTemplate } = require('./unpackProjectTemplate');

let isActive = false;
let statusBarItem;

//----------------------------------------------------------------------------------------------

// Store watcher disposables for enable/disable
let watcherDisposables = [];

// Store event listener disposables for enable/disable
let eventListenerDisposables = [];

// --- Watcher Management ---

function enableWatchers() {
    // Helper to create a watcher for a glob pattern and hook up all events to the same handler
    function createWatcher(glob, onChange, handler) {
        const watcher = vscode.workspace.createFileSystemWatcher(glob);
        watcher.onDidCreate(handler);
        watcher.onDidDelete(handler);
        if (onChange) watcher.onDidChange(onChange);
        watcherDisposables.push(watcher);
    }

    createWatcher('**/*.luau', false, (data) => {
        console.log('Luau file changed, regenerating aliases...', data.path);
        debouncedGenerateFileAliases();
    });
    createWatcher('**/*.lua', false, (data) => {
        console.log('Lua file changed, regenerating aliases...', data.path);
        debouncedGenerateFileAliases();
    });
    createWatcher('**/.requireonrails.aliases.json', true, () => {
        console.log('.requireonrails.aliases.json changed, regenerating aliases...');
        debouncedGenerateFileAliases();
    });
    createWatcher('**/settings.json', true, () => {
        console.log('settings.json changed, regenerating aliases...');
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

    // Listen for file renames (future: update require names)
    const renameListener = vscode.workspace.onDidRenameFiles((event) => {
        event.files.forEach((file) => {
            //console.log(`File renamed from ${file.oldUri.fsPath} to ${file.newUri.fsPath}`);
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

// Debounce utility (shared instance for all watchers)
let debounceTimer = null;
let debouncePending = false;
function debouncedGenerateFileAliases() {
    debouncePending = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (debouncePending) {
            debouncePending = false;
            // Temporarily disable watchers to prevent retriggering
            disableWatchers();
            generateFileAliases();
            // Re-enable watchers after a short delay to allow file writes to settle
            setTimeout(enableWatchers, 500);
        }
    }, 500);
}

function activate(context) {
    const config = vscode.workspace.getConfiguration('require-on-rails');
    
    // Check if workspace folders exist before accessing
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        console.log('No workspace folder found. RequireOnRails will be available when a folder is opened.');
    } else {
        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        console.log('Activating RequireOnRails extension with workspace root:', workspaceRoot);
    }

    // Status bar button
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'require-on-rails.toggleActive';
    setStatusBarText();
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Register toggle command
    const toggleCommand = vscode.commands.registerCommand('require-on-rails.toggleActive', () => {
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            vscode.window.showWarningMessage('RequireOnRails: Please open a folder first.');
            return;
        }
        toggleExtension();
    });
    context.subscriptions.push(toggleCommand);

    // Register setup default project command
    const setupProjectCommand = vscode.commands.registerCommand('require-on-rails.setupDefaultProject', () => {
        unpackProjectTemplate(context);
    });
    context.subscriptions.push(setupProjectCommand);

    // Clean up on deactivate
    context.subscriptions.push({
        dispose: () => {
            disableExtensionFeatures();
        }
    });

    if (config.get("startsImmediately") && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        console.log('RequireOnRails is starting immediately as per configuration.');
        toggleExtension();
    }
}

// This method is called when your extension is deactivated
function deactivate() {
    console.log('Deactivating RequireOnRails...');
    disableExtensionFeatures();
}

module.exports = {
	activate,
	deactivate
}
