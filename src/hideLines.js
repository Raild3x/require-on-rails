const vscode = require('vscode');

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

    const config = vscode.workspace.getConfiguration('require-on-rails');
    const importString = config.get("importString") || "@Import";
    const importRequireDef = `require = require('${importString}')(script) :: typeof(require)`;
    const importRequireDefAlt = `require = require("${importString}")(script) :: typeof(require)`;
    const tryToAddImportRequire = config.get("tryToAddImportRequire");

    // Look for the import require def. If its not present then add it
    if (tryToAddImportRequire && !(text.includes(importRequireDef) || text.includes(importRequireDefAlt))) {
        // Prompt the user for if they want to add the import require definition, if they do then append it to the top of the file
        vscode.window.showWarningMessage(
            `This file is missing the import require definition. Would you like to add it?`,
            'Yes', 'No'
        ).then((selection) => {
            if (selection === 'Yes') {
                const importRequire = `${importRequireDef}\n`;
                const firstLine = editor.document.lineAt(0);
                const edit = new vscode.WorkspaceEdit();
                edit.insert(editor.document.uri, firstLine.range.start, importRequire);
                vscode.workspace.applyEdit(edit).then(() => {
                    editor.revealRange(firstLine.range);
                    hideLines(editor); // Call hideLines again to apply the decoration
                });
            }
        });
        return; // Exit early if the import require definition is not present
    }

    const decorationType = vscode.window.createTextEditorDecorationType({
        opacity: config.get("importOpacity").toString(), // Makes the text nearly invisible        
    });

    const linesToHide = [];
    // Build regex dynamically based on importString, escaping special characters
    const regex = new RegExp(
        `-- selene: allow\\(incorrect_standard_library_use\\)|${escapeRegExp(importRequireDef)}|${escapeRegExp(importRequireDefAlt)}`
    );

    text.split('\n').forEach((line, index) => {
        if (regex.test(line)) {
            const range = new vscode.Range(index, 0, index, line.length);
            linesToHide.push(range);
        }
    });
    
    editor.setDecorations(decorationType, linesToHide);
}

function unhideLines(editor) {
    const decorationType = vscode.window.createTextEditorDecorationType({
        opacity: '1', // Restores the original visibility
    });

    editor.setDecorations(decorationType, []);
}

module.exports = { hideLines };