const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

// Store decoration types globally to properly dispose of them
let currentDecorationType = null;

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
    const importRequireDef = `require = require(${defaultImportModulePath})(script) :: typeof(require)`;
    const tryToAddImportRequire = config.get("tryToAddImportRequire");

    // Look for any of the valid import require definitions
    const hasValidImportRequire = pathsArray.some(path => {
        const def = `require = require(${path})(script) :: typeof(require)`;
        return text.includes(def);
    });

    // Check if the file contains require statements with '@' symbol
    const requireWithAtPattern = /require\s*\(\s*["']([^"']*@[^"']*)["']\s*\)/;
    const hasRequireWithAtSymbol = requireWithAtPattern.test(text);
    
    // Only prompt to add import require definition if:
    // 1. tryToAddImportRequire is enabled
    // 2. There's no valid import require definition present
    // 3. There's at least one require statement with '@' symbol
    if (tryToAddImportRequire && !hasValidImportRequire && hasRequireWithAtSymbol) {
        // Prompt the user for if they want to add the import require definition, if they do then append it to the top of the file
        vscode.window.showWarningMessage(
            `This file is missing the import require definition. Would you like to add it?`,
            'Yes', 'No'
        ).then((selection) => {
            if (selection === 'Yes') {
                const seleneComment = '-- selene: allow(incorrect_standard_library_use)';
                const importRequire = `${importRequireDef}`;
                let insertLine = 0;
                
                const lines = text.split('\n');
                
                // Check if selene.toml exists in workspace
                const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
                const hasSeleneConfig = workspaceFolder && 
                    fs.existsSync(path.join(workspaceFolder.uri.fsPath, 'selene.toml'));
                
                const preferredImportPlacement = config.get("preferredImportPlacement");

                // Check if selene comment already exists
                const hasSeleneComment = lines.some(line => 
                    line.trim() === seleneComment
                );
                
                // Determine insertion line based on preference
                switch (preferredImportPlacement) {
                    case "TopOfFile":
                        insertLine = 0;
                        break;
                        
                    case "BeforeFirstRequire":
                        // Look for existing 'require(' on global scope
                        for (let i = 0; i < lines.length; i++) {
                            const line = lines[i].trim();
                            if (line.startsWith('require(') || /^[a-zA-Z_][a-zA-Z0-9_]*\s*=\s*require\(/.test(line)) {
                                insertLine = i;
                                break;
                            }
                        }
                        break;
                        
                    case "AfterDefiningRobloxServices":
                        // Look for ReplicatedStorage service or other service definitions
                        for (let i = 0; i < lines.length; i++) {
                            const line = lines[i].trim();
                            if (line.includes('game:GetService')) {
                                // Find first empty line after this line
                                for (let j = i + 1; j < lines.length; j++) {
                                    if (lines[j].trim() === '') {
                                        insertLine = j;
                                        break;
                                    }
                                }
                                // If no empty line found, insert right after the service line
                                if (insertLine === 0) {
                                    insertLine = i + 1;
                                }
                                break;
                            }
                        }
                        break;
                }
                
                const targetLine = editor.document.lineAt(insertLine);
                const edit = new vscode.WorkspaceEdit();
                
                // Prepare the text to insert
                let textToInsert = '';
                if (hasSeleneConfig && !hasSeleneComment) {
                    textToInsert += seleneComment + '\n';
                }
                textToInsert += importRequire + '\n';
                
                edit.insert(editor.document.uri, targetLine.range.start, textToInsert);
                vscode.workspace.applyEdit(edit).then(() => {
                    editor.revealRange(targetLine.range);
                    hideLines(editor); // Call hideLines again to apply the decoration
                });
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
        escapeRegExp(`require = require(${path})(script) :: typeof(require)`)
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