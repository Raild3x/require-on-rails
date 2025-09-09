const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { print, warn } = require('../core/logger');

const requirePrefix = '@';
const supportedExtensions = ['.lua', '.luau'];

/**
 * Helper function to check if directory should be ignored based on regex patterns.
 * 
 * @param {string} dirName - Directory name to check
 * @param {string[]} ignorePatterns - Array of regex patterns or strings to match against
 * @returns {boolean} True if directory should be ignored
 */
function shouldIgnoreDirectory(dirName, ignorePatterns) {
    return ignorePatterns.some(pattern => {
        try {
            return new RegExp(pattern).test(dirName);
        } catch (e) {
            warn(`Invalid regex pattern: ${pattern}, falling back to exact match`);
            return dirName.toLowerCase() === pattern.toLowerCase();
        }
    });
}

/**
 * Main function to handle require statement updates when files are renamed or moved.
 * Coordinates various sub-operations based on configuration settings.
 * 
 * @param {string} newFilePath - The new file path after rename/move operation
 * @param {string} oldFilePath - The original file path before rename/move operation
 */
function updateRequireNames(newFilePath, oldFilePath) {
    // Check if workspace folders exist
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        print('No workspace folder found. Skipping require name updates.');
        return;
    }
    
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const config = vscode.workspace.getConfiguration('require-on-rails');

    // Determine operation type and file info
    const operationInfo = analyzeFileOperation(newFilePath, oldFilePath);
    if (!operationInfo) return;

    let { operationType, isMove, isRename, oldFileBasename, newFileBasename } = operationInfo;

    // Handle cases where basename didn't change
    if (oldFileBasename === newFileBasename) {
        print(`File was ${operationType} but basename unchanged, no require updates needed`);
        
        if (isMove && config.get('enableAbsolutePathUpdates', true)) {
            handleAbsolutePathUpdates(newFilePath, oldFilePath, workspaceRoot);
        }
        return;
    }

    // Handle filename collision detection and resolution
    if (config.get('enableFileNameCollisionResolution', true)) {
        const collisionResult = handleFilenameCollision(newFilePath, newFileBasename, workspaceRoot);
        if (collisionResult.renamed) {
            newFilePath = collisionResult.newFilePath;
            newFileBasename = collisionResult.newFileBasename;
        }
    }

    // Handle basename require updates
    if (config.get('enableBasenameUpdates', true)) {
        handleBasenameRequireUpdates(operationType, oldFileBasename, newFileBasename, workspaceRoot, () => {
            // Callback after basename updates
            if (isMove && config.get('enableAbsolutePathUpdates', true)) {
                handleAbsolutePathUpdates(newFilePath, oldFilePath, workspaceRoot);
            }
        });
    } else if (isMove && config.get('enableAbsolutePathUpdates', true)) {
        handleAbsolutePathUpdates(newFilePath, oldFilePath, workspaceRoot);
    }
}

/**
 * Analyzes the file operation to determine if it was a rename, move, or both.
 * 
 * @param {string} newFilePath - The new file path
 * @param {string} oldFilePath - The original file path
 * @returns {Object|null} Operation info object with properties:
 *   - operationType: 'renamed', 'moved', or 'moved and renamed'
 *   - isMove: boolean indicating if directories changed
 *   - isRename: boolean indicating if filename changed
 *   - oldFileBasename: basename without extension from old path
 *   - newFileBasename: basename without extension from new path
 *   Returns null if no change detected.
 */
function analyzeFileOperation(newFilePath, oldFilePath) {
    const oldDir = path.dirname(oldFilePath);
    const newDir = path.dirname(newFilePath);
    const oldFileName = path.basename(oldFilePath);
    const newFileName = path.basename(newFilePath);
    
    const isMove = oldDir !== newDir;
    const isRename = oldFileName !== newFileName;
    
    let operationType;
    if (isMove && isRename) {
        operationType = 'moved and renamed';
    } else if (isMove) {
        operationType = 'moved';
    } else if (isRename) {
        operationType = 'renamed';
    } else {
        return null; // No change detected
    }

    const oldFileBasename = path.basename(oldFilePath, path.extname(oldFilePath));
    const newFileBasename = path.basename(newFilePath, path.extname(newFilePath));

    return { operationType, isMove, isRename, oldFileBasename, newFileBasename };
}

/**
 * Handles filename collision detection and resolution.
 * Checks if the new filename conflicts with existing files or directories
 * and automatically renames with "_Duplicate" suffix if collision detected.
 * 
 * @param {string} newFilePath - The new file path to check for collisions
 * @param {string} newFileBasename - The basename of the new file
 * @param {string} workspaceRoot - Root directory of the workspace
 * @returns {Object} Result object with properties:
 *   - renamed: boolean indicating if file was renamed due to collision
 *   - newFilePath: updated file path (may be changed if collision)
 *   - newFileBasename: updated basename (may be changed if collision)
 */
function handleFilenameCollision(newFilePath, newFileBasename, workspaceRoot) {
    const config = vscode.workspace.getConfiguration('require-on-rails');
    const directoriesToScan = config.get('directoriesToScan');
    const ignoreDirectories = config.get('ignoreDirectories');
    
    const scanRoots = directoriesToScan.map(dir => path.join(workspaceRoot, dir));

    // Check for filename collision
    function checkForCollision(dir) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            if (fullPath === newFilePath) continue;
            if (fs.statSync(fullPath).isDirectory()) {
                if (path.basename(fullPath) === newFileBasename) {
                    for (const ext of supportedExtensions) {
                        if (fs.existsSync(path.join(fullPath, `init${ext}`))) {
                            return true;
                        }
                    }
                }
                if (shouldIgnoreDirectory(path.basename(fullPath), ignoreDirectories)) continue;
                if (checkForCollision(fullPath)) return true;
            } else if (supportedExtensions.includes(path.extname(file))) {
                const fileBasename = path.basename(file, path.extname(file));
                if (fileBasename === newFileBasename) {
                    return true;
                }
            }
        }
        return false;
    }

    // Check all scan roots for collision
    let collisionDetected = false;
    for (const root of scanRoots) {
        if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
            if (checkForCollision(root)) {
                collisionDetected = true;
                break;
            }
        }
    }

    if (collisionDetected) {
        const renamedFileBasename = `${newFileBasename}_Duplicate`;
        const renamedFilePath = newFilePath.replace(newFileBasename, renamedFileBasename);
        fs.renameSync(newFilePath, renamedFilePath);
        vscode.window.showWarningMessage(`Filename collision detected. Renaming to ${renamedFileBasename}`);
        return { renamed: true, newFilePath: renamedFilePath, newFileBasename: renamedFileBasename };
    }

    return { renamed: false, newFilePath, newFileBasename };
}

/**
 * Handles the user prompt and coordination for updating basename require statements.
 * Prompts user for confirmation before proceeding with require updates.
 * 
 * @param {string} operationType - Type of operation ('renamed', 'moved', etc.)
 * @param {string} oldFileBasename - Original file basename
 * @param {string} newFileBasename - New file basename
 * @param {string} workspaceRoot - Root directory of the workspace
 * @param {Function} onComplete - Callback function to execute after completion
 */
function handleBasenameRequireUpdates(operationType, oldFileBasename, newFileBasename, workspaceRoot, onComplete) {
    vscode.window.showInformationMessage(
        `File was ${operationType}. Update require statements from ${requirePrefix}${oldFileBasename} to ${requirePrefix}${newFileBasename}?`,
        'Yes', 'No'
    ).then(selection => {
        if (selection !== 'Yes') {
            vscode.window.showInformationMessage('Require update cancelled.');
            if (onComplete) onComplete();
            return;
        }

        updateBasenameRequiresInFiles(oldFileBasename, newFileBasename, workspaceRoot);
        if (onComplete) onComplete();
    });
}

/**
 * Performs the actual updating of basename require statements across all files.
 * Scans all configured directories and updates require statements from old to new basename.
 * 
 * @param {string} oldFileBasename - Original file basename to find in require statements
 * @param {string} newFileBasename - New file basename to replace with
 * @param {string} workspaceRoot - Root directory of the workspace
 */
function updateBasenameRequiresInFiles(oldFileBasename, newFileBasename, workspaceRoot) {
    const config = vscode.workspace.getConfiguration('require-on-rails');
    const directoriesToScan = config.get('directoriesToScan');
    const ignoreDirectories = config.get('ignoreDirectories');
    
    const scanRoots = directoriesToScan.map(dir => path.join(workspaceRoot, dir));

    /**
     * Updates require statements in a single file.
     * 
     * @param {string} filePath - Path to file to update
     */
    function updateRequiresInFile(filePath) {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const updatedContent = fileContent
            .replace(
                new RegExp(`require\\("${requirePrefix}${oldFileBasename}"\\)`, 'g'),
                `require('${requirePrefix}${newFileBasename}')`
            )
            .replace(
                new RegExp(`require\\('${requirePrefix}${oldFileBasename}'\\)`, 'g'),
                `require('${requirePrefix}${newFileBasename}')`
            );
        if (updatedContent === fileContent) return;
        fs.writeFileSync(filePath, updatedContent, 'utf-8');
        vscode.window.showInformationMessage(`Updated require statements in: ${filePath.replace(workspaceRoot + '/', '')}`);
    }

    /**
     * Recursively processes a directory and all its subdirectories.
     * 
     * @param {string} directory - Directory path to process
     */
    function processDirectory(directory) {
        const files = fs.readdirSync(directory);
        for (const file of files) {
            const fullPath = path.join(directory, file);
            if (fs.statSync(fullPath).isDirectory()) {
                if (shouldIgnoreDirectory(path.basename(fullPath), ignoreDirectories)) continue;
                processDirectory(fullPath);
            } else if (supportedExtensions.includes(path.extname(file))) {
                updateRequiresInFile(fullPath);
            }
        }
    }

    for (const root of scanRoots) {
        if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
            processDirectory(root);
        }
    }
}

/**
 * Handles absolute path require updates when files are moved between different alias paths.
 * Analyzes old and new file paths to determine if they map to different absolute aliases
 * and prompts user to update absolute require paths accordingly.
 * 
 * @param {string} newFilePath - New file path after move
 * @param {string} oldFilePath - Original file path before move
 * @param {string} workspaceRoot - Root directory of the workspace
 */
function handleAbsolutePathUpdates(newFilePath, oldFilePath, workspaceRoot) {
    const config = vscode.workspace.getConfiguration('require-on-rails');
    
    // Read manual aliases from VS Code settings
    const manualAliases = config.get('manualAliases', {});

    // Extract relative paths from workspace root
    const oldRelative = path.relative(workspaceRoot, oldFilePath).replace(/\\/g, '/');
    const newRelative = path.relative(workspaceRoot, newFilePath).replace(/\\/g, '/');
    
    // Find matching absolute alias for old and new paths
    let oldAbsolutePath = null;
    let newAbsolutePath = null;
    
    for (const [alias, aliasPath] of Object.entries(manualAliases)) {
        if (alias.startsWith(requirePrefix)) {
            // Check if old path starts with this alias path
            if (oldRelative.startsWith(aliasPath.replace(/\\/g, '/'))) {
                const relativePart = oldRelative.substring(aliasPath.replace(/\\/g, '/').length);
                oldAbsolutePath = alias + relativePart.replace(/\.(luau|lua)$/, '');
                break;
            }
        }
    }
    
    for (const [alias, aliasPath] of Object.entries(manualAliases)) {
        if (alias.startsWith(requirePrefix)) {
            // Check if new path starts with this alias path
            if (newRelative.startsWith(aliasPath.replace(/\\/g, '/'))) {
                const relativePart = newRelative.substring(aliasPath.replace(/\\/g, '/').length);
                newAbsolutePath = alias + relativePart.replace(/\.(luau|lua)$/, '');
                break;
            }
        }
    }

    // If we found both old and new absolute paths and they're different, prompt for update
    if (oldAbsolutePath && newAbsolutePath && oldAbsolutePath !== newAbsolutePath) {
        vscode.window.showInformationMessage(
            `Update absolute require paths from "${oldAbsolutePath}" to "${newAbsolutePath}"?`,
            'Yes', 'No'
        ).then(selection => {
            if (selection === 'Yes') {
                updateAbsoluteRequireInFiles(oldAbsolutePath, newAbsolutePath, workspaceRoot);
            }
        });
    }
}

/**
 * Performs the actual updating of absolute require paths across all files.
 * Scans all configured directories and replaces absolute require paths.
 * 
 * @param {string} oldAbsolutePath - Old absolute path to find (e.g., "@Server/Systems/myFile")
 * @param {string} newAbsolutePath - New absolute path to replace with (e.g., "@Shared/myFile")
 * @param {string} workspaceRoot - Root directory of the workspace
 */
function updateAbsoluteRequireInFiles(oldAbsolutePath, newAbsolutePath, workspaceRoot) {
    const config = vscode.workspace.getConfiguration('require-on-rails');
    const directoriesToScan = config.get('directoriesToScan');
    const ignoreDirectories = config.get('ignoreDirectories');
    
    /**
     * Updates absolute require statements in a single file.
     * 
     * @param {string} filePath - Path to file to update
     */
    function updateAbsoluteRequiresInFile(filePath) {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const escapedOldPath = oldAbsolutePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const updatedContent = fileContent
            .replace(
                new RegExp(`require\\("${escapedOldPath}"\\)`, 'g'),
                `require("${newAbsolutePath}")`
            )
            .replace(
                new RegExp(`require\\('${escapedOldPath}'\\)`, 'g'),
                `require('${newAbsolutePath}')`
            );
        if (updatedContent === fileContent) return;
        fs.writeFileSync(filePath, updatedContent, 'utf-8');
        vscode.window.showInformationMessage(`Updated absolute require paths in: ${filePath.replace(workspaceRoot + '/', '')}`);
    }

    /**
     * Recursively processes a directory and all its subdirectories for absolute path updates.
     * 
     * @param {string} directory - Directory path to process
     */
    function processDirectory(directory) {
        const files = fs.readdirSync(directory);
        for (const file of files) {
            const fullPath = path.join(directory, file);
            if (fs.statSync(fullPath).isDirectory()) {
                if (shouldIgnoreDirectory(path.basename(fullPath), ignoreDirectories)) return;
                processDirectory(fullPath);
            } else if (supportedExtensions.includes(path.extname(file))) {
                updateAbsoluteRequiresInFile(fullPath);
            }
        }
    }

    // Scan all roots
    const scanRoots = directoriesToScan.map(dir => path.join(workspaceRoot, dir));
    for (const root of scanRoots) {
        if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
            processDirectory(root);
        }
    }
}

module.exports = { updateRequireNames, analyzeFileOperation };