import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Unpacks the project template into the workspace directory.
 * Copies the contents of the ProjectTemplate folder into the workspace.
 */
export async function unpackProjectTemplate(context: vscode.ExtensionContext): Promise<void> {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder found. Please open a folder first.');
        return;
    }

    const workspaceRoot: string = vscode.workspace.workspaceFolders[0].uri.fsPath;
    
    // Get the template directory path - it should be in the extension's installation directory
    const extensionPath: string = context.extensionUri.fsPath;
    const templatePath: string = path.join(extensionPath, 'ProjectTemplate');

    console.log('Extension path:', extensionPath);
    console.log('Template path:', templatePath);
    console.log('Template exists:', fs.existsSync(templatePath));
    
    if (!fs.existsSync(templatePath)) {
        vscode.window.showErrorMessage(`Project template not found at: ${templatePath}`);
        return;
    }
    
    // Check if workspace already has some structure at root level only
    const templateContents: string[] = fs.readdirSync(templatePath);
    const existingRootItems: string[] = templateContents.filter(item => 
        fs.existsSync(path.join(workspaceRoot, item))
    );
    
    if (existingRootItems.length > 0) {
        const selection = await vscode.window.showWarningMessage(
            `Some template items already exist at root level (found: ${existingRootItems.join(', ')}). Folders will be merged, files will be prompted individually. Continue?`,
            { modal: true },
            'Yes', 'Cancel'
        );
        
        if (selection === 'Yes') {
            copyTemplateContents(templatePath, workspaceRoot);
        }
    } else {
        copyTemplateContents(templatePath, workspaceRoot);
    }
}

/**
 * Recursively copies all contents from the template directory to the workspace.
 */
function copyTemplateContents(templatePath: string, workspaceRoot: string): void {
    try {
        let copiedItems: number = 0;
        let skippedItems: number = 0;
        let mergedDirs: number = 0;

        /**
         * Recursively copies files and directories with individual file prompting.
         */
        async function copyRecursive(srcDir: string, destDir: string, relativePath: string = ''): Promise<boolean> {
            const items: string[] = fs.readdirSync(srcDir);
            
            for (const item of items) {
                const srcPath: string = path.join(srcDir, item);
                const destPath: string = path.join(destDir, item);
                const itemRelativePath: string = path.join(relativePath, item);
                
                const stats: fs.Stats = fs.statSync(srcPath);
                
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
                            { modal: true },
                            'Merge', 'Force Overwrite', 'Skip', 'Stop All'
                        );

                        if (selection === 'Merge') {
                            if (isJsonFile(srcPath)) {
                                const mergedContent: string | null = await mergeJson(srcPath, destPath, itemRelativePath);
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
                        } else if (selection === 'Stop All') {
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
        (async (): Promise<void> => {
            const completed: boolean = await copyRecursive(templatePath, workspaceRoot);
            
            if (completed) {
                // Show completion message
                let message: string = `Project template unpacked successfully! `;
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

                const selection = await vscode.window.showInformationMessage(
                    message,
                    { modal: true },
                    'Open Explorer', 'Close'
                );
                
                if (selection === 'Open Explorer') {
                    vscode.commands.executeCommand('workbench.view.explorer');
                }
            }
        })();

    } catch (error) {
        console.error('Error copying project template:', error);
        vscode.window.showErrorMessage(`Failed to copy project template: ${(error as Error).message}`);
    }
}

/**
 * Shows a merge conflict resolution interface similar to Git
 */
async function showFileDiff(templateFilePath: string, existingFilePath: string, relativePath: string, mergedContent: string | null = null): Promise<void> {
    try {
        if (mergedContent !== null) {
            // For JSON files, create a Git-style merge conflict file
            await createMergeConflictFile(templateFilePath, existingFilePath, relativePath, mergedContent);
        } else {
            // For regular files, use standard diff view with merge conflict markers
            await createTextMergeConflictFile(templateFilePath, existingFilePath, relativePath);
        }
        
    } catch (error) {
        console.error('Error showing merge conflict editor:', error);
        vscode.window.showErrorMessage(`Failed to show merge conflict editor for ${relativePath}: ${(error as Error).message}`);
    }
}

/**
 * Creates a merge conflict file for JSON with smart merge content
 */
async function createMergeConflictFile(templateFilePath: string, existingFilePath: string, relativePath: string, mergedContent: string): Promise<void> {
    const existingContent: string = fs.readFileSync(existingFilePath, 'utf8');
    const templateContent: string = fs.readFileSync(templateFilePath, 'utf8');
    
    // Create merge conflict content with three sections
    const conflictContent: string = `<<<<<<< Current (Your Changes)
${existingContent}
||||||| Merged (Smart Merge Result)
${mergedContent}
=======
${templateContent}
>>>>>>> Template (Incoming Changes)
`;
    
    // Create temporary merge file
    const tempMergeFile: string = path.join(path.dirname(existingFilePath), `${path.basename(existingFilePath)}.merge`);
    
    // Use the enhanced conflict resolution with inline actions
    const resolved = await resolveConflictsWithInlineActions(tempMergeFile, conflictContent);
    
    if (resolved) {
        // Read the resolved content and apply it
        const resolvedContent: string = fs.readFileSync(tempMergeFile, 'utf8');
        fs.writeFileSync(existingFilePath, resolvedContent, 'utf8');
        vscode.window.showInformationMessage(`Applied merge resolution to ${relativePath}`);
    } else {
        vscode.window.showInformationMessage(`Kept original file ${relativePath}`);
    }
    
    // Clean up temp file
    if (fs.existsSync(tempMergeFile)) {
        fs.unlinkSync(tempMergeFile);
    }
}

/**
 * Creates a merge conflict file for regular text files
 */
async function createTextMergeConflictFile(templateFilePath: string, existingFilePath: string, relativePath: string): Promise<void> {
    const existingContent: string = fs.readFileSync(existingFilePath, 'utf8');
    const templateContent: string = fs.readFileSync(templateFilePath, 'utf8');
    
    // Create merge conflict content
    const conflictContent: string = `<<<<<<< Current (Your File)
${existingContent}
=======
${templateContent}
>>>>>>> Template (Incoming)
`;
    
    // Create temporary merge file
    const tempMergeFile: string = path.join(path.dirname(existingFilePath), `${path.basename(existingFilePath)}.merge`);
    
    // Use the enhanced conflict resolution with inline actions
    const resolved = await resolveConflictsWithInlineActions(tempMergeFile, conflictContent);
    
    if (resolved) {
        // Read the resolved content and apply it
        const resolvedContent: string = fs.readFileSync(tempMergeFile, 'utf8');
        fs.writeFileSync(existingFilePath, resolvedContent, 'utf8');
        vscode.window.showInformationMessage(`Applied merge resolution to ${relativePath}`);
    } else {
        vscode.window.showInformationMessage(`Kept original file ${relativePath}`);
    }
    
    // Clean up temp file
    if (fs.existsSync(tempMergeFile)) {
        fs.unlinkSync(tempMergeFile);
    }
}

/**
 * Enhanced conflict resolution with inline CodeLens actions
 */
async function resolveConflictsWithInlineActions(
    filePath: string,
    newContent: string
): Promise<boolean> {
    const docUri = vscode.Uri.file(filePath);
    await vscode.workspace.fs.writeFile(docUri, Buffer.from(newContent, 'utf8'));
    await vscode.window.showTextDocument(docUri);

    const conflictPattern = /^<<<<<<< |^=======|^>>>>>>> /;

    const codeLensProvider: vscode.CodeLensProvider = {
        provideCodeLenses(document) {
            const lenses: vscode.CodeLens[] = [];

            for (let i = 0; i < document.lineCount; i++) {
                const line = document.lineAt(i);
                if (line.text.match(conflictPattern)) {
                    lenses.push(
                        new vscode.CodeLens(new vscode.Range(i, 0, i, 0), {
                            title: 'Accept Current',
                            command: 'require-on-rails.acceptCurrent',
                            arguments: [docUri, i]
                        }),
                        new vscode.CodeLens(new vscode.Range(i, 0, i, 0), {
                            title: 'Accept Incoming',
                            command: 'require-on-rails.acceptIncoming',
                            arguments: [docUri, i]
                        }),
                        new vscode.CodeLens(new vscode.Range(i, 0, i, 0), {
                            title: 'Accept Both',
                            command: 'require-on-rails.acceptBoth',
                            arguments: [docUri, i]
                        })
                    );
                }
            }

            return lenses;
        }
    };

    const selector: vscode.DocumentSelector = { scheme: 'file', pattern: '**/*' };
    const disposable = vscode.languages.registerCodeLensProvider(selector, codeLensProvider);

    // Override the global commands with our specific handlers
    const currentDisposable = vscode.commands.registerCommand('require-on-rails.acceptCurrent', async (uri: vscode.Uri, line: number) => {
        await applyResolution(uri, line, 'current');
    }, true); // Override existing command

    const incomingDisposable = vscode.commands.registerCommand('require-on-rails.acceptIncoming', async (uri: vscode.Uri, line: number) => {
        await applyResolution(uri, line, 'incoming');
    }, true); // Override existing command

    const bothDisposable = vscode.commands.registerCommand('require-on-rails.acceptBoth', async (uri: vscode.Uri, line: number) => {
        await applyResolution(uri, line, 'both');
    }, true); // Override existing command

    // Show instruction message
    vscode.window.showInformationMessage(
        'Use the "Accept Current", "Accept Incoming", or "Accept Both" buttons above each conflict section to resolve conflicts.',
        { modal: false }
    );

    // Wait until all conflicts are resolved
    try {
        return await waitUntilResolved(docUri, conflictPattern);
    } finally {
        disposable.dispose();
        currentDisposable.dispose();
        incomingDisposable.dispose();
        bothDisposable.dispose();
    }
}

async function applyResolution(uri: vscode.Uri, lineIndex: number, which: 'current' | 'incoming' | 'both'): Promise<void> {
    const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === uri.fsPath);
    if (!editor) return;

    const doc = editor.document;
    const lines = doc.getText().split('\n');

    let start = lineIndex;
    while (start >= 0 && !lines[start].startsWith('<<<<<<<')) start--;
    let end = lineIndex;
    while (end < lines.length && !lines[end].startsWith('>>>>>>>')) end++;

    const currentStart = start + 1;
    const middleMarker = lines.findIndex((line, i) => i > start && line.startsWith('|||||||'));
    const equalMarker = lines.findIndex((line, i) => i > start && line.startsWith('======='));
    const incomingEnd = end;

    let replacementLines: string[] = [];

    if (which === 'current') {
        if (middleMarker !== -1) {
            // Three-way merge (with middle section)
            replacementLines = lines.slice(currentStart, middleMarker);
        } else {
            // Two-way merge
            replacementLines = lines.slice(currentStart, equalMarker);
        }
    } else if (which === 'incoming') {
        replacementLines = lines.slice(equalMarker + 1, incomingEnd);
    } else if (which === 'both') {
        if (middleMarker !== -1) {
            // Three-way merge: combine current + incoming
            const currentLines = lines.slice(currentStart, middleMarker);
            const incomingLines = lines.slice(equalMarker + 1, incomingEnd);
            replacementLines = [...currentLines, ...incomingLines];
        } else {
            // Two-way merge: combine current + incoming
            const currentLines = lines.slice(currentStart, equalMarker);
            const incomingLines = lines.slice(equalMarker + 1, incomingEnd);
            replacementLines = [...currentLines, ...incomingLines];
        }
    }

    const edit = new vscode.WorkspaceEdit();
    const range = new vscode.Range(
        new vscode.Position(start, 0),
        new vscode.Position(end + 1, 0)
    );
    edit.replace(uri, range, replacementLines.join('\n') + (replacementLines.length > 0 ? '\n' : ''));
    await vscode.workspace.applyEdit(edit);
}

function waitUntilResolved(uri: vscode.Uri, conflictPattern: RegExp): Promise<boolean> {
    return new Promise((resolve) => {
        const interval = setInterval(async () => {
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                const hasConflict = doc.getText().split('\n').some(line => conflictPattern.test(line));
                if (!hasConflict) {
                    clearInterval(interval);
                    resolve(true);
                }
            } catch (error) {
                clearInterval(interval);
                resolve(false);
            }
        }, 1000);

        // Add timeout after 5 minutes
        setTimeout(() => {
            clearInterval(interval);
            resolve(false);
        }, 300000);
    });
}

/**
 * Intelligently merges JSON files, preserving existing properties
 */
async function mergeJson(templateFilePath: string, existingFilePath: string, relativePath: string): Promise<string | null> {
    try {
        // Read both JSON files
        const templateContent: string = fs.readFileSync(templateFilePath, 'utf8');
        const existingContent: string = fs.readFileSync(existingFilePath, 'utf8');
        
        let templateJson: any, existingJson: any;
        
        try {
            templateJson = JSON.parse(templateContent);
            existingJson = JSON.parse(existingContent);
        } catch (parseError) {
            console.warn(`Failed to parse JSON files for ${relativePath}, falling back to diff view:`, (parseError as Error).message);
            await showFileDiff(templateFilePath, existingFilePath, relativePath);
            return null;
        }
        
        // Perform deep merge, preserving existing values
        const mergedJson: any = deepMergeJson(existingJson, templateJson);
        
        // Return the merged content as formatted JSON string
        return JSON.stringify(mergedJson, null, 2);
        
    } catch (error) {
        console.error(`Error merging JSON files for ${relativePath}:`, error);
        vscode.window.showErrorMessage(`Failed to merge JSON file ${relativePath}: ${(error as Error).message}`);
        // Fall back to showing diff
        await showFileDiff(templateFilePath, existingFilePath, relativePath);
        return null;
    }
}

/**
 * Deep merges two JSON objects, preserving existing values in the base object
 */
function deepMergeJson(existing: any, template: any): any {
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
    const result: any = { ...existing };
    
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
 */
function isJsonFile(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === '.json';
}
