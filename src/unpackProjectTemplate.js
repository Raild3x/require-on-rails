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
                            'Merge', 'Force Overwrite', 'Skip', 'Cancel All'
                        );

                        if (selection === 'Merge') {
                            if (isJsonFile(srcPath)) {
                                const mergedContent = await mergeJson(srcPath, destPath, itemRelativePath);
                                if (mergedContent !== null) {
                                    // Show diff before overwriting
                                    await showFileDiff(destPath, srcPath, itemRelativePath, mergedContent);
                                    console.log(`Merged JSON file: ${itemRelativePath}`);
                                    mergedDirs++;
                                }
                            } else {
                                await showFileDiff(srcPath, destPath, itemRelativePath);
                                console.log(`Merged file: ${itemRelativePath}`);
                                mergedDirs++;
                            }
                        } else if (selection === 'Force Overwrite') {
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
 * @param {string} mergedContent - Optional merged content to write after showing diff
 */
async function showFileDiff(templateFilePath, existingFilePath, relativePath, mergedContent = null) {
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
        
        let message = `Diff opened for "${relativePath}". You can manually merge changes from the left (template) to the right (your file). The right side is your editable file.`;
        
        if (mergedContent !== null) {
            message = `Diff opened for "${relativePath}". This shows the merged JSON result. The file will be updated with the merged content.`;
            
            // Write the merged content to the existing file
            fs.writeFileSync(existingFilePath, mergedContent, 'utf8');
        }
        
        // Show information message with instructions
        vscode.window.showInformationMessage(message, 'Got it');
        
    } catch (error) {
        console.error('Error showing diff:', error);
        vscode.window.showErrorMessage(`Failed to show diff for ${relativePath}: ${error.message}`);
    }
}

/**
 * Intelligently merges JSON files, preserving existing properties
 * 
 * @param {string} templateFilePath - Path to the template JSON file
 * @param {string} existingFilePath - Path to the existing JSON file
 * @param {string} relativePath - Relative path for display purposes
 * @returns {string|null} - The merged JSON content as string, or null if merge failed
 */
async function mergeJson(templateFilePath, existingFilePath, relativePath) {
    try {
        // Read both JSON files
        const templateContent = fs.readFileSync(templateFilePath, 'utf8');
        const existingContent = fs.readFileSync(existingFilePath, 'utf8');
        
        let templateJson, existingJson;
        
        try {
            templateJson = JSON.parse(templateContent);
            existingJson = JSON.parse(existingContent);
        } catch (parseError) {
            console.warn(`Failed to parse JSON files for ${relativePath}, falling back to diff view:`, parseError.message);
            await showFileDiff(templateFilePath, existingFilePath, relativePath);
            return null;
        }
        
        // Perform deep merge, preserving existing values
        const mergedJson = deepMergeJson(existingJson, templateJson);
        
        // Return the merged content as formatted JSON string
        return JSON.stringify(mergedJson, null, 2);
        
    } catch (error) {
        console.error(`Error merging JSON files for ${relativePath}:`, error);
        vscode.window.showErrorMessage(`Failed to merge JSON file ${relativePath}: ${error.message}`);
        // Fall back to showing diff
        await showFileDiff(templateFilePath, existingFilePath, relativePath);
        return null;
    }
}

/**
 * Deep merges two JSON objects, preserving existing values in the base object
 * 
 * @param {object} existing - The existing JSON object (takes precedence)
 * @param {object} template - The template JSON object (provides new properties)
 * @returns {object} - The merged JSON object
 */
function deepMergeJson(existing, template) {
    // If existing is not an object or is null, return template
    if (typeof existing !== 'object' || existing === null) {
        return template;
    }
    
    // If template is not an object or is null, return existing
    if (typeof template !== 'object' || template === null) {
        return existing;
    }
    
    // Handle arrays - preserve existing array completely
    if (Array.isArray(existing)) {
        return existing;
    }
    
    // If template is array but existing is object, preserve existing
    if (Array.isArray(template)) {
        return existing;
    }
    
    // Create a new object starting with existing properties
    const result = { ...existing };
    
    // Add properties from template that don't exist in existing
    for (const key in template) {
        if (template.hasOwnProperty(key)) {
            if (!existing.hasOwnProperty(key)) {
                // Property doesn't exist in existing, add it from template
                result[key] = template[key];
            } else {
                // Property exists in both, recursively merge if both are objects
                if (typeof existing[key] === 'object' && existing[key] !== null &&
                    typeof template[key] === 'object' && template[key] !== null &&
                    !Array.isArray(existing[key]) && !Array.isArray(template[key])) {
                    result[key] = deepMergeJson(existing[key], template[key]);
                }
                // Otherwise, keep the existing value (don't overwrite)
            }
        }
    }
    
    return result;
}

/**
 * Checks if a file is a JSON file based on its extension
 * 
 * @param {string} filePath - Path to the file
 * @returns {boolean} - True if the file has a .json extension
 */
function isJsonFile(filePath) {
    return path.extname(filePath).toLowerCase() === '.json';
}

module.exports = { unpackProjectTemplate };
