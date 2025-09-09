const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { print, warn, error } = require('../core/logger');

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

    print('Extension path:', extensionPath);
    print('Template path:', templatePath);
    print('Template exists:', fs.existsSync(templatePath));
    
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
                        print(`Created directory: ${itemRelativePath}`);
                    } else {
                        print(`Merging with existing directory: ${itemRelativePath}`);
                        mergedDirs++;
                    }
                    // Recursively copy directory contents
                    await copyRecursive(srcPath, destPath, itemRelativePath);
                } else if (stats.isFile()) {
                    // Special handling for .gitkeep files
                    if (item === '.gitkeep') {
                        // Check if the destination directory already has other files
                        const destDirContents = fs.readdirSync(destDir);
                        const nonGitkeepFiles = destDirContents.filter(file => file !== '.gitkeep');
                        
                        if (nonGitkeepFiles.length > 0) {
                            print(`[DEBUG] Skipping .gitkeep for ${itemRelativePath} - directory already has files: ${nonGitkeepFiles.join(', ')}`);
                            skippedItems++;
                            continue; // Skip this .gitkeep file
                        }
                        
                        // Directory is empty (or only has .gitkeep), proceed with normal file handling
                        print(`[DEBUG] Directory is empty, proceeding with .gitkeep for ${itemRelativePath}`);
                    }
                    
                    if (!fs.existsSync(destPath)) {
                        // File doesn't exist, copy it
                        fs.copyFileSync(srcPath, destPath);
                        print(`Copied file: ${itemRelativePath}`);
                        copiedItems++;
                    } else {
                        // File exists, attempt to merge
                        if (isJsonConvertible(srcPath) && isJsonConvertible(destPath)) {
                            print(`[DEBUG] Attempting JSON merge for: ${itemRelativePath}`);
                            
                            // Store original content before merging
                            const originalContent = fs.readFileSync(destPath, 'utf8');
                            const mergedContent = await mergeJson(srcPath, destPath, itemRelativePath);
                            
                            if (mergedContent !== null) {
                                // Check if content actually changed
                                if (originalContent !== mergedContent) {
                                    fs.writeFileSync(destPath, mergedContent, 'utf8');
                                    print(`[DEBUG] Successfully merged JSON file: ${itemRelativePath}`);
                                    print(`[DEBUG] - Original length: ${originalContent.length}`);
                                    print(`[DEBUG] - Merged length: ${mergedContent.length}`);
                                    mergedDirs++;
                                    
                                    // Show notification with diff option
                                    showFileChangeNotification(itemRelativePath, originalContent, mergedContent, 'merged');
                                } else {
                                    print(`[DEBUG] JSON merge produced identical content for: ${itemRelativePath}`);
                                }
                            } else {
                                // JSON merge failed, but since both files are JSON, try to merge again with better error handling
                                print(`[DEBUG] Initial JSON merge failed, attempting fallback merge: ${itemRelativePath}`);
                                const originalContent = fs.readFileSync(destPath, 'utf8');
                                const templateContent = fs.readFileSync(srcPath, 'utf8');
                                
                                // Try to merge as JSON one more time with fallback
                                const fallbackMerged = await fallbackJsonMerge(templateContent, originalContent, itemRelativePath);
                                if (fallbackMerged !== null) {
                                    fs.writeFileSync(destPath, fallbackMerged, 'utf8');
                                    print(`[DEBUG] Fallback JSON merge succeeded: ${itemRelativePath}`);
                                    mergedDirs++;
                                    showFileChangeNotification(itemRelativePath, originalContent, fallbackMerged, 'merged');
                                } else {
                                    // Complete merge failure - keep existing file unchanged
                                    print(`[DEBUG] All JSON merge attempts failed, keeping existing file: ${itemRelativePath}`);
                                    skippedItems++;
                                }
                            }
                        } else if (isJsonConvertible(srcPath)) {
                            // Source is JSON but destination is not - convert destination to JSON if possible
                            print(`[DEBUG] Source (${srcPath}) is JSON, destination (${destPath}) is not, attempting conversion: ${itemRelativePath}`);
                            const originalContent = fs.readFileSync(destPath, 'utf8');
                            const templateContent = fs.readFileSync(srcPath, 'utf8');
                            
                            // Try to convert destination to JSON and merge
                            const convertedMerged = await convertAndMergeJson(templateContent, originalContent, itemRelativePath);
                            if (convertedMerged !== null) {
                                fs.writeFileSync(destPath, convertedMerged, 'utf8');
                                print(`[DEBUG] Converted and merged file: ${itemRelativePath}`);
                                mergedDirs++;
                                showFileChangeNotification(itemRelativePath, originalContent, convertedMerged, 'merged');
                            } else {
                                // Keep existing file unchanged
                                print(`[DEBUG] Cannot convert destination to JSON, keeping existing: ${itemRelativePath}`);
                                skippedItems++;
                            }
                        } else {
                            // Neither file is JSON-compatible, keep existing file unchanged
                            print(`[DEBUG] Neither file is JSON-compatible, keeping existing: ${itemRelativePath}`);
                            skippedItems++;
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
        error('Error copying project template:', error);
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
            print(`Applied merged content for ${relativePath}`);
        }
        
    } catch (error) {
        error('Error showing diff:', error);
    }
}

/**
 * Strips comments from JSON content to handle JSONC files
 * 
 * @param {string} content - JSON content that may contain comments
 * @returns {string} - JSON content with comments removed
 */
function stripJsonComments(content) {
    try {
        // Remove single-line comments (// comment)
        // But preserve URLs and other legitimate uses of //
        let result = content.replace(/\/\/(?![^\r\n]*["'][^"']*\/\/[^"']*["'])[^\r\n]*/g, '');
        
        // Remove multi-line comments (/* comment */)
        // Use non-greedy matching to avoid removing content between separate comment blocks
        result = result.replace(/\/\*[\s\S]*?\*\//g, '');
        
        // Remove trailing commas that might be left after comment removal
        result = result.replace(/,(\s*[}\]])/g, '$1');
        
        return result;
    } catch (error) {
        warn('[DEBUG] Error stripping JSON comments:', error);
        return content; // Return original content if stripping fails
    }
}

/**
 * Attempts to parse JSON content with JSONC support (JSON with comments)
 * 
 * @param {string} content - JSON/JSONC content to parse
 * @param {string} filePath - File path for error reporting
 * @returns {object|null} - Parsed JSON object or null if parsing failed
 */
function parseJsonWithComments(content, filePath) {
    try {
        // First try parsing as regular JSON
        return JSON.parse(content);
    } catch (error) {
        print(`[DEBUG] Regular JSON parse failed for ${filePath}, trying JSONC parsing`);
        
        try {
            // Strip comments and try parsing again
            const strippedContent = stripJsonComments(content);
            return JSON.parse(strippedContent);
        } catch (jsoncError) {
            warn(`[DEBUG] JSONC parse also failed for ${filePath}:`, jsoncError.message);
            return null;
        }
    }
}

/**
 * Checks if a file contains JSON/JSONC-convertible content by attempting to parse it
 * 
 * @param {string} filePath - Path to the file
 * @returns {boolean} - True if the file content can be parsed as JSON/JSONC
 */
function isJsonConvertible(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            print(`[DEBUG] File does not exist: ${filePath}`);
            return false;
        }
        
        const content = fs.readFileSync(filePath, 'utf8').trim();
        
        // Empty files are not JSON-convertible
        if (!content) {
            print(`[DEBUG] File is empty: ${filePath}`);
            return false;
        }
        
        // Check file extension for common JSON/JSONC files
        const ext = path.extname(filePath).toLowerCase();
        const jsonExtensions = ['.json', '.jsonc'];
        
        // If it's a known JSON extension, try parsing with JSONC support
        if (jsonExtensions.includes(ext)) {
            const parsed = parseJsonWithComments(content, filePath);
            const isConvertible = parsed !== null;
            print(`[DEBUG] File ${filePath} is ${isConvertible ? '' : 'not '}JSON/JSONC-convertible (by extension)`);
            return isConvertible;
        }
        
        // For other files, try parsing as JSON/JSONC anyway
        const parsed = parseJsonWithComments(content, filePath);
        const isConvertible = parsed !== null;
        print(`[DEBUG] File ${filePath} is ${isConvertible ? '' : 'not '}JSON/JSONC-convertible (by content)`);
        return isConvertible;
        
    } catch (error) {
        warn(`[DEBUG] Error checking JSON/JSONC convertible for ${filePath}:`, error.message);
        return false;
    }
}

/**
 * Intelligently merges JSON/JSONC files, preserving existing properties and adding missing template properties
 * 
 * @param {string} templateFilePath - Path to the template JSON/JSONC file
 * @param {string} existingFilePath - Path to the existing JSON/JSONC file
 * @param {string} relativePath - Relative path for display purposes
 * @returns {string|null} - The merged JSON content as string, or null if merge failed
 */
async function mergeJson(templateFilePath, existingFilePath, relativePath) {
    try {
        print(`[DEBUG] Starting JSON/JSONC merge for: ${relativePath}`);
        
        // Read both files
        const templateContent = fs.readFileSync(templateFilePath, 'utf8');
        const existingContent = fs.readFileSync(existingFilePath, 'utf8');
        
        print(`[DEBUG] Template content length: ${templateContent.length}`);
        print(`[DEBUG] Existing content length: ${existingContent.length}`);
        
        let templateJson, existingJson;
        
        // Parse both files with JSONC support
        templateJson = parseJsonWithComments(templateContent, templateFilePath);
        existingJson = parseJsonWithComments(existingContent, existingFilePath);
        
        if (templateJson === null || existingJson === null) {
            print(`[DEBUG] Failed to parse JSON/JSONC content for ${relativePath}`);
            return null;
        }
        
        print(`[DEBUG] Template JSON keys: ${Object.keys(templateJson).join(', ')}`);
        print(`[DEBUG] Existing JSON keys: ${Object.keys(existingJson).join(', ')}`);
        
        // Perform deep merge, preserving existing values and adding missing template fields
        const mergedJson = deepMergeJson(existingJson, templateJson);
        
        print(`[DEBUG] Merged JSON keys: ${Object.keys(mergedJson).join(', ')}`);
        
        // Return the merged content as formatted JSON string
        const mergedContent = JSON.stringify(mergedJson, null, 2);
        print(`[DEBUG] Final merged content length: ${mergedContent.length}`);
        
        return mergedContent;
        
    } catch (error) {
        error(`[DEBUG] Error merging JSON/JSONC files for ${relativePath}:`, error);
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
                warn('Failed to clean up temp files:', cleanupError);
            }
        }, 30000); // Clean up after 30 seconds
        
    } catch (error) {
        error('Error showing content diff:', error);
        vscode.window.showErrorMessage(`Failed to show diff for ${relativePath}: ${error.message}`);
    }
}

/**
 * Fallback JSON/JSONC merge function that attempts to merge with more lenient parsing
 * 
 * @param {string} templateContent - Template file content
 * @param {string} existingContent - Existing file content
 * @param {string} relativePath - Relative path for display purposes
 * @returns {string|null} - The merged JSON content as string, or null if merge failed
 */
async function fallbackJsonMerge(templateContent, existingContent, relativePath) {
    try {
        print(`[DEBUG] Attempting fallback JSON/JSONC merge for: ${relativePath}`);
        
        let templateJson, existingJson;
        
        // Try parsing with JSONC support and more lenient approach
        templateJson = parseJsonWithComments(templateContent.trim(), `template-${relativePath}`);
        existingJson = parseJsonWithComments(existingContent.trim(), `existing-${relativePath}`);
        
        if (templateJson === null || existingJson === null) {
            print(`[DEBUG] Fallback JSON/JSONC parse also failed for ${relativePath}`);
            return null;
        }
        
        print(`[DEBUG] Fallback parse successful for: ${relativePath}`);
        
        // Perform deep merge, preserving existing values and adding missing template fields
        const mergedJson = deepMergeJson(existingJson, templateJson);
        
        print(`[DEBUG] Fallback merge completed for: ${relativePath}`);
        
        // Return the merged content as formatted JSON string
        return JSON.stringify(mergedJson, null, 2);
        
    } catch (error) {
        error(`[DEBUG] Error in fallback JSON/JSONC merge for ${relativePath}:`, error);
        return null;
    }
}

/**
 * Attempts to convert non-JSON content to JSON and merge with template
 * 
 * @param {string} templateContent - Template JSON/JSONC content
 * @param {string} existingContent - Existing non-JSON content
 * @param {string} relativePath - Relative path for display purposes
 * @returns {string|null} - The merged content, or null if conversion failed
 */
async function convertAndMergeJson(templateContent, existingContent, relativePath) {
    try {
        print(`[DEBUG] Attempting to convert and merge: ${relativePath}`);
        
        let templateJson;
        
        // Parse template with JSONC support
        templateJson = parseJsonWithComments(templateContent, `template-${relativePath}`);
        
        if (templateJson === null) {
            print(`[DEBUG] Template is not valid JSON/JSONC for ${relativePath}`);
            return null;
        }
        
        // Try to create a minimal JSON structure from existing content
        // This is a simple approach - in practice you might want more sophisticated conversion
        const existingAsJson = {
            "_originalContent": existingContent.trim(),
            "_convertedToJson": true
        };
        
        // Merge template fields into the converted structure
        const mergedJson = deepMergeJson(existingAsJson, templateJson);
        
        print(`[DEBUG] Conversion and merge completed for: ${relativePath}`);
        
        return JSON.stringify(mergedJson, null, 2);
        
    } catch (error) {
        error(`[DEBUG] Error converting and merging ${relativePath}:`, error);
        return null;
    }
}

module.exports = { unpackProjectTemplate };
