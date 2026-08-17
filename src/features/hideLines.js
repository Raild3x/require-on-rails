const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { print } = require('../core/logger');
const {
    addImportToSingleFile,
    hasValidImportRequire,
    getImportRequireLineIndexes
} = require('./addImportToFiles');

// Store decoration types globally to properly dispose of them
/** @type {vscode.TextEditorDecorationType | null} */
let currentDecorationType = null;

// Store the current editor document to avoid unnecessary reprocessing
/** @type {string | null} */
let currentEditorDocument = null;

/**
 * Dims the import require definition (and its selene comment) in the given editor.
 *
 * @param {vscode.TextEditor} editor - Editor whose document should be decorated
 */
function hideLines(editor) {
    if (!editor) return;
    const editorLang = editor.document.languageId;
    if (editorLang !== 'luau' && editorLang !== 'lua') {
        return;
    }

    const text = editor.document.getText();

    // Don't do anything for empty files
    if (!text.trim()) {
        return;
    }

    // Clear any existing decorations first
    unhideLines(editor);



    const config = vscode.workspace.getConfiguration('require-on-rails');
    const importModulePaths = /** @type {string[]} */ (config.get("importModulePaths", []));
    const pathsArray = Array.isArray(importModulePaths) ? importModulePaths : [importModulePaths];
    const defaultImportModulePath = pathsArray[0];
    const tryToAddImportRequire = config.get("tryToAddImportRequire", true);

    // Use the centralized function to check for valid import require definitions
    const hasValidImport = hasValidImportRequire(text, importModulePaths);

    // Check if the file contains require statements with '@' symbol
    const requireWithAtPattern = /require\s*\(\s*["']([^"']*@[^"']*)["']\s*\)/;
    const hasRequireWithAtSymbol = requireWithAtPattern.test(text);
    
    // Only prompt to add import require definition if:
    // 1. tryToAddImportRequire is enabled
    // 2. There's no valid import require definition present
    // 3. There's at least one require statement with '@' symbol
    if (tryToAddImportRequire && !hasValidImport && hasRequireWithAtSymbol) {
        if (currentEditorDocument && currentEditorDocument == editor.document.fileName) {
            print(`No changes detected in ${editor.document.fileName}, skipping reprocessing.`);
            return; // If the document hasn't changed, no need to reprocess
        }
        currentEditorDocument = editor.document.fileName; // Update current document reference

        // Prompt the user for if they want to add the import require definition
        vscode.window.showWarningMessage(
            `This file is missing the import require definition. Would you like to add it?`,
            'Yes', 'No'
        ).then((selection) => {
            if (selection === 'Yes') {
                const filePath = editor.document.fileName;
                const preferredImportPlacement = /** @type {string} */ (config.get("preferredImportPlacement", 'TopOfFile'));
                const contextualImportTemplate = /** @type {string|undefined} */ (config.get("contextualImportTemplate"));

                if (!defaultImportModulePath) {
                    vscode.window.showWarningMessage('RequireOnRails: No import module path configured.');
                    return;
                }
                
                // Use the centralized addImportToSingleFile function
                const success = addImportToSingleFile(filePath, defaultImportModulePath, preferredImportPlacement, contextualImportTemplate);
                
                if (success) {
                    // Refresh the editor to show the new content and apply decorations
                    setTimeout(() => {
                        hideLines(editor); // Call hideLines again to apply the decoration
                    }, 100);
                }
            }
        });
        return; // Exit early if the import require definition is not present
    }

    // Create new decoration type
    const importOpacity = config.get("importOpacity", 0.45);
    currentDecorationType = vscode.window.createTextEditorDecorationType({
        opacity: importOpacity.toString(), // Makes the text nearly invisible
    });

    const seleneComment = '-- selene: allow(incorrect_standard_library_use)';
    const importLineIndexes = new Set(getImportRequireLineIndexes(text, importModulePaths));
    /** @type {vscode.Range[]} */
    const linesToHide = [];
    text.split('\n').forEach((line, index) => {
        if (line.trim() === seleneComment || importLineIndexes.has(index)) {
            const range = new vscode.Range(index, 0, index, line.length);
            linesToHide.push(range);
        }
    });
    
    editor.setDecorations(currentDecorationType, linesToHide);
}

/**
 * Removes any decoration applied by {@link hideLines}.
 *
 * @param {vscode.TextEditor | undefined} editor - Editor to clear, if one is active
 */
function unhideLines(editor) {
    if (!editor) {
        return;
    }
    
    // Dispose of the current decoration type if it exists
    if (currentDecorationType) {
        currentDecorationType.dispose();
        currentDecorationType = null;
    }
}

module.exports = { hideLines, unhideLines };