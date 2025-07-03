const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

/**
 * Unpacks the project template into the workspace directory.
 * Copies the contents of the ProjectTemplate folder into the workspace.
 */
function unpackProjectTemplate(context) {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder found. Please open a folder first.');
        return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    
    // Get the template directory path - it should be in the extension's installation directory
    const extensionPath = context.extensionUri.fsPath;
    const templatePath = path.join(extensionPath, 'ProjectTemplate');

    console.log('Extension path:', extensionPath);
    console.log('Template path:', templatePath);
    console.log('Template exists:', fs.existsSync(templatePath));
    
    if (!fs.existsSync(templatePath)) {
        vscode.window.showErrorMessage(`Project template not found at: ${templatePath}`);
        return;
    }
    
    // Check if workspace already has some structure at root level only
    const templateContents = fs.readdirSync(templatePath);
    const existingRootItems = templateContents.filter(item => 
        fs.existsSync(path.join(workspaceRoot, item))
    );
    
    if (existingRootItems.length > 0) {
        vscode.window.showWarningMessage(
            `Some template items already exist at root level (found: ${existingRootItems.join(', ')}). Folders will be merged, files will be prompted individually. Continue?`,
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
        let mergedDirs = 0;

        /**
         * Recursively copies files and directories with individual file prompting.
         * 
         * @param {string} srcDir - Source directory to copy from
         * @param {string} destDir - Destination directory to copy to
         * @param {string} relativePath - Relative path for logging purposes
         */
        async function copyRecursive(srcDir, destDir, relativePath = '') {
            const items = fs.readdirSync(srcDir);
            
            for (const item of items) {
                const srcPath = path.join(srcDir, item);
                const destPath = path.join(destDir, item);
                const itemRelativePath = path.join(relativePath, item);
                
                const stats = fs.statSync(srcPath);
                
                if (stats.isDirectory()) {
                    // Always merge directories - create if doesn't exist, merge if it does
                    if (!fs.existsSync(destPath)) {
                        fs.mkdirSync(destPath, { recursive: true });
                        console.log(`Created directory: ${itemRelativePath}`);
                    } else {
                        console.log(`Merging with existing directory: ${itemRelativePath}`);
                        mergedDirs++;
                    }
                    // Recursively copy directory contents
                    await copyRecursive(srcPath, destPath, itemRelativePath);
                } else if (stats.isFile()) {
                    if (!fs.existsSync(destPath)) {
                        // File doesn't exist, copy it
                        fs.copyFileSync(srcPath, destPath);
                        console.log(`Copied file: ${itemRelativePath}`);
                        copiedItems++;
                    } else {
                        // File exists, prompt user for decision
                        const selection = await vscode.window.showWarningMessage(
                            `File "${itemRelativePath}" already exists. What would you like to do?`,
                            'Merge', 'Overwrite', 'Skip', 'Cancel All'
                        );

                        if (selection === 'Merge') {
                            await showFileDiff(srcPath, destPath, itemRelativePath);
                            console.log(`Merged file: ${itemRelativePath}`);
                            mergedDirs++;
                        } else if (selection === 'Overwrite') {
                            fs.copyFileSync(srcPath, destPath);
                            console.log(`Overwritten file: ${itemRelativePath}`);
                            copiedItems++;
                        } else if (selection === 'Skip') {
                            console.log(`Skipped existing file: ${itemRelativePath}`);
                            skippedItems++;
                        } else if (selection === 'Cancel All') {
                            console.log('Template unpacking cancelled by user');
                            vscode.window.showInformationMessage('Template unpacking cancelled.');
                            return false; // Signal to stop processing
                        }
                    }
                }
            }
            return true; // Signal to continue processing
        }

        // Start the recursive copy (wrap in async function to handle promises)
        (async () => {
            const completed = await copyRecursive(templatePath, workspaceRoot);
            
            if (completed) {
                // Show completion message
                let message = `Project template unpacked successfully! `;
                if (copiedItems > 0) {
                    message += `${copiedItems} files copied. `;
                }
                if (skippedItems > 0) {
                    message += `${skippedItems} files skipped. `;
                }
                if (mergedDirs > 0) {
                    message += `${mergedDirs} directories merged. `;
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
            }
        })();

    } catch (error) {
        console.error('Error copying project template:', error);
        vscode.window.showErrorMessage(`Failed to copy project template: ${error.message}`);
    }
}

/**
 * Shows a diff between the template file and existing file, allowing user to manually merge
 * 
 * @param {string} templateFilePath - Path to the template file
 * @param {string} existingFilePath - Path to the existing file
 * @param {string} relativePath - Relative path for display purposes
 */
async function showFileDiff(templateFilePath, existingFilePath, relativePath) {
    try {
        // Create URIs for both files
        const templateUri = vscode.Uri.file(templateFilePath);
        const existingUri = vscode.Uri.file(existingFilePath);
        
        // Open diff editor
        await vscode.commands.executeCommand(
            'vscode.diff',
            templateUri,
            existingUri,
            `Template vs Existing: ${relativePath}`,
            {
                preview: false,
                preserveFocus: false
            }
        );
        
        // Show information message with instructions
        vscode.window.showInformationMessage(
            `Diff opened for "${relativePath}". You can manually merge changes from the left (template) to the right (your file). The right side is your editable file.`,
            'Got it'
        );
        
    } catch (error) {
        console.error('Error showing diff:', error);
        vscode.window.showErrorMessage(`Failed to show diff for ${relativePath}: ${error.message}`);
    }
}

module.exports = { unpackProjectTemplate };
