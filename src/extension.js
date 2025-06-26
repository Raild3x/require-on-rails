const vscode = require('vscode');
// const path = require('path');
const { generateFileAliases } = require('./updateLuaFileAliases');
const { updateRequireNames } = require('./updateRequireNames');
const { hideLines } = require('./hideLines');

let isActive = false;
let statusBarItem;
let subscriptionsToToggle = [];

function setStatusBarText() {
    if (statusBarItem) {
        statusBarItem.text = isActive ? '$(check) RequireOnRails: On' : '$(circle-slash) RequireOnRails: Off';
        statusBarItem.tooltip = isActive ? 'Click to deactivate RequireOnRails' : 'Click to activate RequireOnRails';
    }
}

function toggleExtension() {
    isActive = !isActive;
    setStatusBarText();
    if (isActive) {
        enableExtensionFeatures();
    } else {
        disableExtensionFeatures();
    }
}

function enableExtensionFeatures() {
    // Re-register all event listeners
    subscriptionsToToggle.forEach(sub => vscode.Disposable.from(sub).dispose());
    subscriptionsToToggle = [];

    const TextEditorConnection = vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && editor.document.languageId === 'luau') {
            hideLines(editor);
        }
    });
    subscriptionsToToggle.push(TextEditorConnection);

    const TextDocumentConnection = vscode.workspace.onDidChangeTextDocument((event) => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === event.document) {
            hideLines(editor);
        }
    });
    subscriptionsToToggle.push(TextDocumentConnection);

    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.luau');
    fileWatcher.onDidCreate((uri) => {
        generateFileAliases();
    });
    fileWatcher.onDidDelete((uri) => {
        generateFileAliases();
    });
    fileWatcher.onDidChange((uri) => {
        // No-op for now
    });
    subscriptionsToToggle.push(fileWatcher);

    const RenameConnection = vscode.workspace.onDidRenameFiles((event) => {
        event.files.forEach((file) => {
            // You can call your update logic here, e.g.:
            updateRequireNames(file.newUri.fsPath, file.oldUri.fsPath);
        });
    });
    subscriptionsToToggle.push(RenameConnection);

    generateFileAliases();
}

function disableExtensionFeatures() {
    // Dispose all event listeners
    subscriptionsToToggle.forEach(sub => sub.dispose());
    subscriptionsToToggle = [];
    setStatusBarText();
}

function activate(context) {
    const config = vscode.workspace.getConfiguration('require-on-rails');
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
	console.log('Activating RequireOnRails extension with workspace root:', workspaceRoot);

    // Status bar button
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'require-on-rails.toggleActive';
    setStatusBarText();
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Register toggle command
    const toggleCommand = vscode.commands.registerCommand('require-on-rails.toggleActive', () => {
        toggleExtension();
    });
    context.subscriptions.push(toggleCommand);

    // Clean up on deactivate
    context.subscriptions.push({
        dispose: () => {
            disableExtensionFeatures();
        }
    });

    if (config.get("startsImmediately", true)) {
        isActive = true;
        enableExtensionFeatures();
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
