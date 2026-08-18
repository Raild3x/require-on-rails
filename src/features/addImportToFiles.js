const fs = require('fs');
const path = require('path');
// Optional — see updateLuaFileAliases.js. The template-matching helpers are pure and shared
// with the headless build; only the command entry points below touch the editor.
/** @type {typeof import('vscode') | null} */
let vscode = null;
try { vscode = require('vscode'); } catch (e) { /* running outside VS Code */ }
const { print, warn, errMsg } = require('../core/logger');
const {
    DEFAULT_CONTEXTUAL_IMPORT_TEMPLATE,
    getCommonConfig,
    scanDirectory,
    requireWorkspaceRoot
} = require('../utils/workspaceUtils');

/**
 * Main function to add import require definitions to files using custom aliases
 */
function addImportToAllFiles() {
    if (!vscode) return;
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

    /** @type {string[]} */
    const filesToProcess = [];

    // Scan all directories for files that need the import
    directoriesToScan.forEach(dir => {
        const dirPath = path.join(workspaceRoot, dir);
        if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
            scanDirectory(dirPath, config.supportedExtensions, ignoreDirectories, (/** @type {string} */ filePath) => {
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
 * @param {string} dir - Directory to scan
 * @param {string|string[]} importModulePaths - Configured import module path(s)
 * @param {string[]} ignoreDirectories - Directory name patterns to skip
 * @param {string[]} filesToProcess - Accumulator that receives matching file paths
 * @returns {void}
 */
function scanForFilesNeedingImport(dir, importModulePaths, ignoreDirectories, filesToProcess) {
    const config = getCommonConfig();
    scanDirectory(dir, config.supportedExtensions, ignoreDirectories, (/** @type {string} */ filePath) => {
        if (fileNeedsImport(filePath, importModulePaths)) {
            filesToProcess.push(filePath);
        }
    });
}

/**
 * Escapes regex metacharacters so configured import paths can be safely matched.
 * @param {string} text
 * @returns {string}
 */
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalizes configured import paths into a clean string array.
 * @param {string|string[]} importModulePaths
 * @returns {string[]}
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
 * @param {string} importPath
 * @returns {RegExp}
 */
function createSingleLineImportRegex(importPath) {
    const escapedPath = escapeRegExp(importPath);
    return new RegExp(
        `^\\s*require\\s*=\\s*require\\s*\\(\\s*${escapedPath}\\s*\\)\\s*\\(\\s*script\\s*\\)(?:\\s*::.*)?(?:\\s*--.*)?\\s*$`
    );
}

/**
 * Matches the first line of split imports, capturing the assigned local variable name.
 * @param {string} importPath
 * @returns {RegExp}
 */
function createImportAssignmentRegex(importPath) {
    const escapedPath = escapeRegExp(importPath);
    return new RegExp(
        `^\\s*(?:local\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*require\\s*\\(\\s*${escapedPath}\\s*\\)(?:\\s*::.*)?(?:\\s*--.*)?\\s*$`
    );
}

/**
 * Matches the second line of split imports: require = <capturedVar>(script).
 * @param {string} varName
 * @returns {RegExp}
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
 * @param {string} content - Full file text
 * @param {string|string[]} importModulePaths - Configured import module path(s)
 * @returns {number[]} - Matching line indexes, ascending
 */
function getImportRequireLineIndexes(content, importModulePaths) {
    const lines = content.split('\n');
    /** @type {Set<number>} */
    const matchedLineIndexes = new Set();
    /** @type {{ lineIndex: number, variableName: string }[]} */
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
        // Restrict the search to the next non-empty line after the assignment.
        // Scanning the whole file risks pairing with an unrelated
        // `require = <var>(script)` that happens to share the same variable name.
        let overwriteLineIndex = -1;
        for (let i = candidate.lineIndex + 1; i < lines.length; i++) {
            if (lines[i].trim() === '') continue;  // skip blank lines
            if (overwriteRegex.test(lines[i])) {
                overwriteLineIndex = i;
            }
            break; // stop after the first non-empty line regardless of match
        }

        if (overwriteLineIndex !== -1) {
            matchedLineIndexes.add(candidate.lineIndex);
            matchedLineIndexes.add(overwriteLineIndex);
        }
    });

    return Array.from(matchedLineIndexes).sort((a, b) => a - b);
}

/**
 * Builds the contextual import snippet from a template for easier customization.
 * @param {string} importModulePath
 * @returns {string}
 */
function createContextualImportSnippet(importModulePath) {
    const { contextualImportTemplate } = getCommonConfig();
    return createContextualImportSnippetFromTemplate(importModulePath, contextualImportTemplate);
}

/**
 * Builds the contextual import snippet from a template, falling back when invalid.
 * @param {string} importModulePath
 * @param {string|undefined} template - Template containing `{IMPORT_MODULE_PATH}`; falls back to the default when absent or malformed
 * @returns {string}
 */
function createContextualImportSnippetFromTemplate(importModulePath, template) {
    const templateToUse =
        typeof template === 'string' && template.includes('{IMPORT_MODULE_PATH}')
            ? template
            : DEFAULT_CONTEXTUAL_IMPORT_TEMPLATE;

    return templateToUse.replaceAll('{IMPORT_MODULE_PATH}', importModulePath);
}

/**
 * Checks if a file has a valid import require definition
 * @param {string} content - Full file text
 * @param {string|string[]} importModulePaths - Configured import module path(s)
 * @returns {boolean}
 */
function hasValidImportRequire(content, importModulePaths) {
    return getImportRequireLineIndexes(content, importModulePaths).length > 0;
}

/**
 * Checks if a file uses custom aliases but lacks the import require definition
 * @param {string} filePath
 * @param {string|string[]} importModulePaths - Configured import module path(s)
 * @returns {boolean}
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
        warn(`Error reading file ${filePath}:`, errMsg(error));
        return false;
    }
}

/**
 * Helper function to check if directory should be ignored
 * @param {string} dirName
 * @param {string[]} ignorePatterns
 * @returns {boolean}
 */
function shouldIgnoreDirectory(dirName, ignorePatterns) {
    // This is now handled by workspaceUtils.shouldIgnoreDirectory
    // Keeping this function for backwards compatibility
    const { shouldIgnoreDirectory: utilsShouldIgnore } = require('../utils/workspaceUtils');
    return utilsShouldIgnore(dirName, ignorePatterns);
}

/**
 * Shows a preview of files that will be modified
 * @param {string[]} filesToProcess
 * @param {string} defaultImportModulePath
 * @param {string|undefined} contextualImportTemplate
 * @returns {void}
 */
function showFilesPreview(filesToProcess, defaultImportModulePath, contextualImportTemplate) {
    if (!vscode) return;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
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
 * @param {string[]} filesToProcess
 * @param {string} defaultImportModulePath
 * @param {string} workspaceRoot
 * @param {string|undefined} contextualImportTemplate
 * @returns {void}
 */
function addImportToFiles(filesToProcess, defaultImportModulePath, workspaceRoot, contextualImportTemplate) {
    if (!vscode) return;
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
            warn(`Failed to add import to ${filePath}:`, errMsg(error));
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
 * @param {string} filePath
 * @param {string} defaultImportModulePath
 * @param {string} preferredImportPlacement - One of `TopOfFile`, `BeforeFirstRequire`, `AfterDefiningRobloxServices`
 * @param {string|undefined} contextualImportTemplate
 * @returns {boolean}
 */
function addImportToSingleFile(filePath, defaultImportModulePath, preferredImportPlacement, contextualImportTemplate) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const contextualImportLineIndexes = new Set(
        getImportRequireLineIndexes(content, [defaultImportModulePath])
    );
    
    const importRequire = createContextualImportSnippetFromTemplate(defaultImportModulePath, contextualImportTemplate);

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
    textToInsert += importRequire + '\n';
    
    // Insert the text
    lines.splice(insertLine, 0, ...textToInsert.split('\n').slice(0, -1)); // Remove last empty line
    
    const updatedContent = lines.join('\n');
    fs.writeFileSync(filePath, updatedContent, 'utf8');
    
    return true;
}

// The selene suppression that conventionally rides along with the boilerplate (hideLines
// dims it too); orphaned copies are removed together with the block they annotated.
const SELENE_ALLOW_RE = /^\s*--\s*selene:\s*allow\(incorrect_standard_library_use\)\s*$/;

/**
 * Removes the Import boilerplate from one file's text: the matched template lines, any
 * selene-allow comment directly above a removed line, and one blank line left behind by
 * each removed block. Pure, shared by the editor command and the headless build.
 * @param {string} content
 * @param {string|string[]} importModulePaths
 * @returns {{text: string, removed: number}}
 */
function stripImportLines(content, importModulePaths) {
    const indexes = getImportRequireLineIndexes(content, importModulePaths);
    if (indexes.length === 0) return { text: content, removed: 0 };

    const lines = content.split('\n');
    const toRemove = new Set(indexes);
    for (const index of indexes) {
        if (index > 0 && SELENE_ALLOW_RE.test(lines[index - 1])) toRemove.add(index - 1);
    }
    // One trailing blank per removed block, so "template + blank + code" collapses cleanly.
    for (const index of [...toRemove]) {
        const next = index + 1;
        if (!toRemove.has(next) && next < lines.length && lines[next].trim() === '') toRemove.add(next);
    }

    return {
        text: lines.filter((_, index) => !toRemove.has(index)).join('\n'),
        removed: indexes.length
    };
}

/**
 * One-time migration for adopting Build conversion: strips the Import boilerplate from every
 * scanned file, after a confirmation listing how many files are affected.
 */
function removeImportFromAllFiles() {
    if (!vscode) return;
    const workspaceRoot = requireWorkspaceRoot('boilerplate removal');
    if (!workspaceRoot) return;

    const config = getCommonConfig();
    const { directoriesToScan, ignoreDirectories, importModulePaths } = config;

    /** @type {{filePath: string, stripped: {text: string, removed: number}}[]} */
    const pending = [];
    directoriesToScan.forEach(dir => {
        const dirPath = path.join(workspaceRoot, dir);
        if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return;
        scanDirectory(dirPath, config.supportedExtensions, ignoreDirectories, (/** @type {string} */ filePath) => {
            let content;
            try {
                content = fs.readFileSync(filePath, 'utf8');
            } catch (e) {
                warn(`Error reading file ${filePath}:`, errMsg(e));
                return;
            }
            const stripped = stripImportLines(content, importModulePaths);
            if (stripped.removed > 0) pending.push({ filePath, stripped });
        });
    });

    if (pending.length === 0) {
        vscode.window.showInformationMessage('RequireOnRails: no files contain the Import boilerplate.');
        return;
    }

    // Modal: this edits many files at once and is not undoable from a notification toast.
    vscode.window.showInformationMessage(
        `Remove the Import boilerplate from ${pending.length} file(s)?`,
        {
            modal: true,
            detail: 'With Build conversion enabled the RequireOnRails Luau module is no longer used, ' +
                'so the "require = Import(script)" lines serve no purpose. This rewrites the files on disk.'
        },
        'Remove'
    ).then(choice => {
        if (choice !== 'Remove') return;
        let success = 0;
        let failed = 0;
        for (const { filePath, stripped } of pending) {
            try {
                fs.writeFileSync(filePath, stripped.text, 'utf8');
                success++;
                print(`Removed import boilerplate from: ${path.relative(workspaceRoot, filePath).replace(/\\/g, '/')}`);
            } catch (e) {
                failed++;
                warn(`Failed to strip import from ${filePath}:`, errMsg(e));
            }
        }
        const message = `RequireOnRails: removed the Import boilerplate from ${success} file(s).` +
            (failed > 0 ? ` ${failed} file(s) failed.` : '');
        if (failed > 0) vscode?.window.showWarningMessage(message);
        else vscode?.window.showInformationMessage(message);
    });
}

module.exports = {
    addImportToAllFiles,
    addImportToSingleFile,
    hasValidImportRequire,
    getImportRequireLineIndexes,
    createContextualImportSnippet,
    createContextualImportSnippetFromTemplate,
    stripImportLines,
    removeImportFromAllFiles
};
