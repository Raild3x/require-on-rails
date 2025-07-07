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
         * Recursively copies files and directories with automatic merging.
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
                        // File exists, attempt to merge
                        if (isJsonConvertible(srcPath) && isJsonConvertible(destPath)) {
                            // Store original content before merging
                            const originalContent = fs.readFileSync(destPath, 'utf8');
                            const mergedContent = await mergeJson(srcPath, destPath, itemRelativePath);
                            if (mergedContent !== null) {
                                fs.writeFileSync(destPath, mergedContent, 'utf8');
                                console.log(`Merged JSON-compatible file: ${itemRelativePath}`);
                                mergedDirs++;
                                
                                // Show notification with diff option
                                showFileChangeNotification(itemRelativePath, originalContent, mergedContent, 'merged');
                            } else {
                                // JSON merge failed, copy template file
                                const originalContent = fs.readFileSync(destPath, 'utf8');
                                const templateContent = fs.readFileSync(srcPath, 'utf8');
                                fs.copyFileSync(srcPath, destPath);
                                console.log(`Overwritten file (JSON merge failed): ${itemRelativePath}`);
                                copiedItems++;
                                
                                // Show notification with diff option
                                showFileChangeNotification(itemRelativePath, originalContent, templateContent, 'overwritten');
                            }
                        } else {
                            // Not JSON-compatible, overwrite with template
                            const originalContent = fs.readFileSync(destPath, 'utf8');
                            const templateContent = fs.readFileSync(srcPath, 'utf8');
                            fs.copyFileSync(srcPath, destPath);
                            console.log(`Overwritten file: ${itemRelativePath}`);
                            copiedItems++;
                            
                            // Show notification with diff option
                            showFileChangeNotification(itemRelativePath, originalContent, templateContent, 'overwritten');
                        }
                    }
                }
            }
            return true;
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
 * Shows a diff between the template file and existing file (removed prompting)
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
        
        if (mergedContent !== null) {
            // Write the merged content to the existing file
            fs.writeFileSync(existingFilePath, mergedContent, 'utf8');
            console.log(`Applied merged content for ${relativePath}`);
        }
        
    } catch (error) {
        console.error('Error showing diff:', error);
    }
}

/**
 * Intelligently merges JSON files, preserving existing properties and adding missing template properties
 * 
 * @param {string} templateFilePath - Path to the template JSON file
 * @param {string} existingFilePath - Path to the existing JSON file
 * @param {string} relativePath - Relative path for display purposes
 * @returns {string|null} - The merged JSON content as string, or null if merge failed
 */
async function mergeJson(templateFilePath, existingFilePath, relativePath) {
    try {
        // Read both files
        const templateContent = fs.readFileSync(templateFilePath, 'utf8');
        const existingContent = fs.readFileSync(existingFilePath, 'utf8');
        
        let templateJson, existingJson;
        
        try {
            templateJson = JSON.parse(templateContent);
            existingJson = JSON.parse(existingContent);
        } catch (parseError) {
            console.warn(`Failed to parse JSON content for ${relativePath}:`, parseError.message);
            return null;
        }
        
        // Perform deep merge, preserving existing values and adding missing template fields
        const mergedJson = deepMergeJson(existingJson, templateJson);
        
        // Return the merged content as formatted JSON string
        return JSON.stringify(mergedJson, null, 2);
        
    } catch (error) {
        console.error(`Error merging JSON files for ${relativePath}:`, error);
        return null;
    }
}

/**
 * Deep merges two JSON objects, preserving existing values and adding missing template properties
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
    
    // Add properties from template that don't exist in existing (deep search)
    for (const key in template) {
        if (template.hasOwnProperty(key)) {
            if (!existing.hasOwnProperty(key)) {
                // Property doesn't exist in existing, add it from template
                result[key] = JSON.parse(JSON.stringify(template[key])); // Deep clone
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
 * Checks if a file contains JSON-convertible content by attempting to parse it
 * 
 * @param {string} filePath - Path to the file
 * @returns {boolean} - True if the file content can be parsed as JSON
 */
function isJsonConvertible(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            return false;
        }
        
        const content = fs.readFileSync(filePath, 'utf8').trim();
        
        // Empty files are not JSON-convertible
        if (!content) {
            return false;
        }
        
        // Try to parse as JSON
        JSON.parse(content);
        return true;
    } catch (error) {
        return false;
    }
}

/**
 * Shows a notification for a changed file with option to view diff
 * 
 * @param {string} relativePath - Relative path of the changed file
 * @param {string} originalContent - Original file content before changes
 * @param {string} newContent - New file content after changes
 * @param {string} changeType - Type of change ('merged' or 'overwritten')
 */
function showFileChangeNotification(relativePath, originalContent, newContent, changeType) {
    const message = changeType === 'merged' 
        ? `Merged template fields into: ${relativePath}`
        : `Overwritten file: ${relativePath}`;
    
    vscode.window.showInformationMessage(
        message,
        'Show Diff'
    ).then(selection => {
        if (selection === 'Show Diff') {
            showContentDiff(relativePath, originalContent, newContent, changeType);
        }
    });
}

/**
 * Shows a diff between original and new content using temporary files
 * 
 * @param {string} relativePath - Relative path for display purposes
 * @param {string} originalContent - Original file content
 * @param {string} newContent - New file content
 * @param {string} changeType - Type of change for labeling
 */
async function showContentDiff(relativePath, originalContent, newContent, changeType) {
    try {
        const os = require('os');
        const tempDir = os.tmpdir();
        
        // Create temporary files for diff
        const originalTempPath = path.join(tempDir, `original_${path.basename(relativePath)}`);
        const newTempPath = path.join(tempDir, `new_${path.basename(relativePath)}`);
        
        fs.writeFileSync(originalTempPath, originalContent, 'utf8');
        fs.writeFileSync(newTempPath, newContent, 'utf8');
        
        // Create URIs for both temp files
        const originalUri = vscode.Uri.file(originalTempPath);
        const newUri = vscode.Uri.file(newTempPath);
        
        const titlePrefix = changeType === 'merged' ? 'Merged' : 'Overwritten';
        
        // Open diff editor
        await vscode.commands.executeCommand(
            'vscode.diff',
            originalUri,
            newUri,
            `${titlePrefix}: ${relativePath} (Original ← → New)`,
            {
                preview: false,
                preserveFocus: false
            }
        );
        
        // Clean up temp files after a delay
        setTimeout(() => {
            try {
                if (fs.existsSync(originalTempPath)) fs.unlinkSync(originalTempPath);
                if (fs.existsSync(newTempPath)) fs.unlinkSync(newTempPath);
            } catch (cleanupError) {
                console.warn('Failed to clean up temp files:', cleanupError);
            }
        }, 30000); // Clean up after 30 seconds
        
    } catch (error) {
        console.error('Error showing content diff:', error);
        vscode.window.showErrorMessage(`Failed to show diff for ${relativePath}: ${error.message}`);
    }
}

module.exports = { unpackProjectTemplate };
