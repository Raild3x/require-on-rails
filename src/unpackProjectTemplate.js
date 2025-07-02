const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

/**
 * Unpacks the project template into the workspace directory.
 * Copies the contents of the ProjectTemplate folder into the workspace.
 */
function unpackProjectTemplate() {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder found. Please open a folder first.');
        return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    
    // Get the template directory path (sibling to the extension directory)
    const extensionPath = path.dirname(__dirname); // Go up from src/ to extension root
    const templatePath = path.join(path.dirname(extensionPath), 'ProjectTemplate');
    
    if (!fs.existsSync(templatePath)) {
        vscode.window.showErrorMessage(`Project template not found at: ${templatePath}`);
        return;
    }
    
    // Check if workspace already has some structure
    const templateContents = fs.readdirSync(templatePath);
    const existingItems = templateContents.filter(item => 
        fs.existsSync(path.join(workspaceRoot, item))
    );
    
    if (existingItems.length > 0) {
        vscode.window.showWarningMessage(
            `Some template items already exist (found: ${existingItems.join(', ')}). Continue anyway?`,
            'Yes', 'Cancel'
        ).then(selection => {
            if (selection === 'Yes') {
                copyTemplateContents(templatePath, workspaceRoot);
            }
        });
    } else {
        copyTemplateContents(templatePath, workspaceRoot);
    }
}

/**
 * Recursively copies all contents from the template directory to the workspace.
 * 
 * @param {string} templatePath - Path to the ProjectTemplate directory
 * @param {string} workspaceRoot - Root directory of the workspace
 */
function copyTemplateContents(templatePath, workspaceRoot) {
    try {
        let copiedItems = 0;
        let skippedItems = 0;

        /**
         * Recursively copies files and directories.
         * 
         * @param {string} srcDir - Source directory to copy from
         * @param {string} destDir - Destination directory to copy to
         * @param {string} relativePath - Relative path for logging purposes
         */
        function copyRecursive(srcDir, destDir, relativePath = '') {
            const items = fs.readdirSync(srcDir);
            
            for (const item of items) {
                const srcPath = path.join(srcDir, item);
                const destPath = path.join(destDir, item);
                const itemRelativePath = path.join(relativePath, item);
                
                const stats = fs.statSync(srcPath);
                
                if (stats.isDirectory()) {
                    // Create directory if it doesn't exist
                    if (!fs.existsSync(destPath)) {
                        fs.mkdirSync(destPath, { recursive: true });
                        console.log(`Created directory: ${itemRelativePath}`);
                    }
                    // Recursively copy directory contents
                    copyRecursive(srcPath, destPath, itemRelativePath);
                } else if (stats.isFile()) {
                    // Copy file if it doesn't exist
                    if (!fs.existsSync(destPath)) {
                        fs.copyFileSync(srcPath, destPath);
                        console.log(`Copied file: ${itemRelativePath}`);
                        copiedItems++;
                    } else {
                        console.log(`Skipped existing file: ${itemRelativePath}`);
                        skippedItems++;
                    }
                }
            }
        }

        // Start the recursive copy
        copyRecursive(templatePath, workspaceRoot);

        // Show completion message
        let message = `Project template unpacked successfully! `;
        if (copiedItems > 0) {
            message += `${copiedItems} items copied. `;
        }
        if (skippedItems > 0) {
            message += `${skippedItems} items skipped (already exist). `;
        }
        message += `RequireOnRails structure is ready to use.`;

        vscode.window.showInformationMessage(
            message,
            'Open Explorer'
        ).then(selection => {
            if (selection === 'Open Explorer') {
                vscode.commands.executeCommand('workbench.view.explorer');
            }
        });

    } catch (error) {
        console.error('Error copying project template:', error);
        vscode.window.showErrorMessage(`Failed to copy project template: ${error.message}`);
    }
}

module.exports = { unpackProjectTemplate };
