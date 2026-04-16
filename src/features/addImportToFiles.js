const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { print, warn } = require('../core/logger');
const { getCommonConfig, scanDirectory, requireWorkspaceRoot } = require('../utils/workspaceUtils');

const DEFAULT_CONTEXTUAL_IMPORT_TEMPLATE = [
    'local Import = require({IMPORT_MODULE_PATH})',
    'require = Import(script)'
].join('\n');

/**
 * Main function to add import require definitions to files using custom aliases
 */
function addImportToAllFiles() {
    const workspaceRoot = requireWorkspaceRoot('import management');
    if (!workspaceRoot) return;

    const config = getCommonConfig();
    const { directoriesToScan, ignoreDirectories, importModulePaths, contextualImportTemplate } = config;
    const pathsArray = Array.isArray(importModulePaths) ? importModulePaths : [importModulePaths];
    const defaultImportModulePath = pathsArray[0];
    
    if (!defaultImportModulePath) {
        vscode.window.showErrorMessage('RequireOnRails: No import module path configured.');
        return;
    }

    const filesToProcess = [];
    
    // Scan all directories for files that need the import
    directoriesToScan.forEach(dir => {
        const dirPath = path.join(workspaceRoot, dir);
        if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
            scanDirectory(dirPath, config.supportedExtensions, ignoreDirectories, (filePath) => {
                if (fileNeedsImport(filePath, importModulePaths)) {
                    filesToProcess.push(filePath);
                }
            });
        }
    });

    if (filesToProcess.length === 0) {
        vscode.window.showInformationMessage('RequireOnRails: No files found that need the import require definition.');
        return;
    }

    // Show confirmation dialog
    vscode.window.showInformationMessage(
        `Found ${filesToProcess.length} file(s) using custom aliases without import require definition. Add import to all?`,
        'Yes', 'No', 'Show Files'
    ).then(selection => {
        if (selection === 'Show Files') {
            showFilesPreview(filesToProcess, defaultImportModulePath, contextualImportTemplate);
        } else if (selection === 'Yes') {
            addImportToFiles(filesToProcess, defaultImportModulePath, workspaceRoot, contextualImportTemplate);
        }
    });
}

/**
 * Recursively scans directories for files that use custom aliases but lack import definition
 */
function scanForFilesNeedingImport(dir, importModulePaths, ignoreDirectories, filesToProcess) {
    const config = getCommonConfig();
    scanDirectory(dir, config.supportedExtensions, ignoreDirectories, (filePath) => {
        if (fileNeedsImport(filePath, importModulePaths)) {
            filesToProcess.push(filePath);
        }
    });
}

/**
 * Escapes regex metacharacters so configured import paths can be safely matched.
 */
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalizes configured import paths into a clean string array.
 */
function getImportPathsArray(importModulePaths) {
    const pathsArray = Array.isArray(importModulePaths) ? importModulePaths : [importModulePaths];
    return pathsArray
        .filter(path => typeof path === 'string')
        .map(path => path.trim())
        .filter(path => path.length > 0);
}

/**
 * Matches the legacy single-line override form: require = require(path)(script).
 */
function createSingleLineImportRegex(importPath) {
    const escapedPath = escapeRegExp(importPath);
    return new RegExp(
        `^\\s*require\\s*=\\s*require\\s*\\(\\s*${escapedPath}\\s*\\)\\s*\\(\\s*script\\s*\\)(?:\\s*::.*)?(?:\\s*--.*)?\\s*$`
    );
}

/**
 * Matches the first line of split imports, capturing the assigned local variable name.
 */
function createImportAssignmentRegex(importPath) {
    const escapedPath = escapeRegExp(importPath);
    return new RegExp(
        `^\\s*(?:local\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*require\\s*\\(\\s*${escapedPath}\\s*\\)(?:\\s*::.*)?(?:\\s*--.*)?\\s*$`
    );
}

/**
 * Matches the second line of split imports: require = <capturedVar>(script).
 */
function createRequireOverwriteRegex(varName) {
    const escapedVarName = escapeRegExp(varName);
    return new RegExp(
        `^\\s*require\\s*=\\s*${escapedVarName}\\s*\\(\\s*script\\s*\\)(?:\\s*::.*)?(?:\\s*--.*)?\\s*$`
    );
}

/**
 * Matches core single-line override form without requiring a specific module path.
 */
function createGenericSingleLineImportRegex() {
    return /^\s*require\s*=\s*require\s*\(.+\)\s*\(\s*script\s*\)(?:\s*::.*)?(?:\s*--.*)?\s*$/;
}

/**
 * Matches core split import assignment form without requiring a specific module path.
 */
function createGenericImportAssignmentRegex() {
    return /^\s*(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*require\s*\(.+\)(?:\s*::.*)?(?:\s*--.*)?\s*$/;
}

/**
 * Returns line indexes for valid import override definitions in single-line or split form.
 */
function getImportRequireLineIndexes(content, importModulePaths) {
    const lines = content.split('\n');
    const matchedLineIndexes = new Set();
    const assignmentCandidates = [];
    const importPaths = getImportPathsArray(importModulePaths);

    lines.forEach((line, lineIndex) => {
        importPaths.forEach(importPath => {
            if (createSingleLineImportRegex(importPath).test(line)) {
                matchedLineIndexes.add(lineIndex);
            }

            const assignmentMatch = line.match(createImportAssignmentRegex(importPath));
            if (assignmentMatch) {
                assignmentCandidates.push({
                    lineIndex,
                    variableName: assignmentMatch[1]
                });
            }
        });

        // Fallback to core usage detection for cases where configured path text differs.
        if (createGenericSingleLineImportRegex().test(line)) {
            matchedLineIndexes.add(lineIndex);
        }

        const genericAssignmentMatch = line.match(createGenericImportAssignmentRegex());
        if (genericAssignmentMatch) {
            assignmentCandidates.push({
                lineIndex,
                variableName: genericAssignmentMatch[1]
            });
        }
    });

    assignmentCandidates.forEach(candidate => {
        const overwriteRegex = createRequireOverwriteRegex(candidate.variableName);
        const overwriteLineIndex = lines.findIndex(line => overwriteRegex.test(line));

        if (overwriteLineIndex !== -1) {
            matchedLineIndexes.add(candidate.lineIndex);
            matchedLineIndexes.add(overwriteLineIndex);
        }
    });

    return Array.from(matchedLineIndexes).sort((a, b) => a - b);
}

/**
 * Builds the contextual import snippet from a template for easier customization.
 */
function createContextualImportSnippet(importModulePath) {
    const { contextualImportTemplate } = getCommonConfig();
    return createContextualImportSnippetFromTemplate(importModulePath, contextualImportTemplate);
}

/**
 * Builds the contextual import snippet from a template, falling back when invalid.
 */
function createContextualImportSnippetFromTemplate(importModulePath, template) {
    const templateToUse =
        typeof template === 'string' && template.includes('{IMPORT_MODULE_PATH}')
            ? template
            : DEFAULT_CONTEXTUAL_IMPORT_TEMPLATE;

    return templateToUse.replace('{IMPORT_MODULE_PATH}', importModulePath);
}

/**
 * Checks if a file has a valid import require definition
 */
function hasValidImportRequire(content, importModulePaths) {
    return getImportRequireLineIndexes(content, importModulePaths).length > 0;
}

/**
 * Checks if a file uses custom aliases but lacks the import require definition
 */
function fileNeedsImport(filePath, importModulePaths) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        
        // Check if file has any require statements with '@' symbol
        const requireWithAtPattern = /require\s*\(\s*["']([^"']*@[^"']*)["']\s*\)/;
        const hasCustomAliases = requireWithAtPattern.test(content);
        
        if (!hasCustomAliases) {
            return false;
        }
        
        // Use the centralized function to check for valid import require definitions
        return !hasValidImportRequire(content, importModulePaths);
    } catch (error) {
        warn(`Error reading file ${filePath}:`, error.message);
        return false;
    }
}

/**
 * Helper function to check if directory should be ignored
 */
function shouldIgnoreDirectory(dirName, ignorePatterns) {
    // This is now handled by workspaceUtils.shouldIgnoreDirectory
    // Keeping this function for backwards compatibility
    const { shouldIgnoreDirectory: utilsShouldIgnore } = require('../utils/workspaceUtils');
    return utilsShouldIgnore(dirName, ignorePatterns);
}

/**
 * Shows a preview of files that will be modified
 */
function showFilesPreview(filesToProcess, defaultImportModulePath, contextualImportTemplate) {
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const relativePaths = filesToProcess.map(file => 
        path.relative(workspaceRoot, file).replace(/\\/g, '/')
    );
    
    const importPreview = createContextualImportSnippetFromTemplate(defaultImportModulePath, contextualImportTemplate);
    const message = `Files that will receive the import require definition:\n\n${relativePaths.join('\n')}\n\nImport to add:\n${importPreview}`;
    
    vscode.window.showInformationMessage(
        `${filesToProcess.length} files will be modified.`,
        'Proceed', 'Cancel'
    ).then(selection => {
        if (selection === 'Proceed') {
            addImportToFiles(filesToProcess, defaultImportModulePath, workspaceRoot, contextualImportTemplate);
        }
    });
}

/**
 * Adds the import require definition to all specified files
 */
function addImportToFiles(filesToProcess, defaultImportModulePath, workspaceRoot, contextualImportTemplate) {
    const config = getCommonConfig();
    const { preferredImportPlacement } = config;
    
    let successCount = 0;
    let errorCount = 0;
    
    filesToProcess.forEach(filePath => {
        try {
            if (addImportToSingleFile(filePath, defaultImportModulePath, preferredImportPlacement, contextualImportTemplate)) {
                successCount++;
                const relativePath = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
                print(`Added import require to: ${relativePath}`);
            }
        } catch (error) {
            errorCount++;
            warn(`Failed to add import to ${filePath}:`, error.message);
        }
    });
    
    const message = `Import require definition added to ${successCount} file(s).` + 
                   (errorCount > 0 ? ` ${errorCount} file(s) failed.` : '');
    
    if (errorCount > 0) {
        vscode.window.showWarningMessage(message);
    } else {
        vscode.window.showInformationMessage(message);
    }
}

/**
 * Adds import require definition to a single file
 */
function addImportToSingleFile(filePath, defaultImportModulePath, preferredImportPlacement, contextualImportTemplate) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const contextualImportLineIndexes = new Set(
        getImportRequireLineIndexes(content, [defaultImportModulePath])
    );
    
    const config = getCommonConfig();
    const { addSeleneCommentToImport } = config;
    
    // Check if selene.toml exists in workspace
    const workspaceFolder = vscode.workspace.workspaceFolders[0];
    const hasSeleneConfig = workspaceFolder && 
        fs.existsSync(path.join(workspaceFolder.uri.fsPath, 'selene.toml'));
    
    const seleneComment = '-- selene: allow(incorrect_standard_library_use)';
    const importRequire = createContextualImportSnippetFromTemplate(defaultImportModulePath, contextualImportTemplate);
    
    // Check if selene comment already exists
    const hasSeleneComment = lines.some(line => 
        line.trim() === seleneComment
    );
    
    let insertLine = 0;

    print("Pref Import:", preferredImportPlacement)
    
    // Determine insertion line based on preference
    switch (preferredImportPlacement) {
        case "TopOfFile":
            insertLine = 0;
            break;
            
        case "BeforeFirstRequire":
            // Look for existing 'require(' on global scope
            let foundRequire = false;
            for (let i = 0; i < lines.length; i++) {
                if (contextualImportLineIndexes.has(i)) {
                    continue;
                }

                const line = lines[i].trim();
                // Match various require patterns:
                // - require(...)
                // - variable = require(...)
                // - local variable = require(...)
                if (line.startsWith('require(') || 
                    /^(local\s+)?[a-zA-Z_][a-zA-Z0-9_]*\s*=\s*require\(/.test(line) ||
                    /require\s*\(/.test(line)) {
                    insertLine = i;
                    foundRequire = true;
                    break;
                }
            }
            // If no require statement found, default to top of file
            if (!foundRequire) {
                insertLine = 0;
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
    
    // Prepare the text to insert
    let textToInsert = '';
    if (addSeleneCommentToImport && hasSeleneConfig && !hasSeleneComment) {
        textToInsert += seleneComment + '\n';
    }
    textToInsert += importRequire + '\n';
    
    // Insert the text
    lines.splice(insertLine, 0, ...textToInsert.split('\n').slice(0, -1)); // Remove last empty line
    
    const updatedContent = lines.join('\n');
    fs.writeFileSync(filePath, updatedContent, 'utf8');
    
    return true;
}

module.exports = {
    addImportToAllFiles,
    addImportToSingleFile,
    hasValidImportRequire,
    getImportRequireLineIndexes,
    createContextualImportSnippet,
    createContextualImportSnippetFromTemplate
};
