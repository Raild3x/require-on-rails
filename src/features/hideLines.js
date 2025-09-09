const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { print } = require('../core/logger');
const { addImportToSingleFile, hasValidImportRequire } = require('./addImportToFiles');

// Store decoration types globally to properly dispose of them
let currentDecorationType = null;

// Store the current editor document to avoid unnecessary reprocessing
let currentEditorDocument = null;

// Utility to escape regex special characters in a string
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hideLines(editor) {
    const editorLang = editor.document.languageId;
    if (!editor || (editorLang !== 'luau' && editorLang !== 'lua')) {
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
    const importModulePaths = config.get("importModulePaths");
    const pathsArray = Array.isArray(importModulePaths) ? importModulePaths : [importModulePaths];
    const defaultImportModulePath = pathsArray[0];
    const tryToAddImportRequire = config.get("tryToAddImportRequire");

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
                const preferredImportPlacement = config.get("preferredImportPlacement");
                
                // Use the centralized addImportToSingleFile function
                const success = addImportToSingleFile(filePath, defaultImportModulePath, preferredImportPlacement);
                
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
    currentDecorationType = vscode.window.createTextEditorDecorationType({
        opacity: config.get("importOpacity").toString(), // Makes the text nearly invisible        
    });

    const linesToHide = [];
    // Build regex dynamically based on all importModulePaths, escaping special characters
    const pathPatterns = pathsArray.map(path => 
        escapeRegExp(`require = require(${path})(script)`)
    ).join('|');
    const regex = new RegExp(
        `-- selene: allow\\(incorrect_standard_library_use\\)|${pathPatterns}`
    );

    text.split('\n').forEach((line, index) => {
        if (regex.test(line)) {
            const range = new vscode.Range(index, 0, index, line.length);
            linesToHide.push(range);
        }
    });
    
    editor.setDecorations(currentDecorationType, linesToHide);
}

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