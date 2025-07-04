const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const packageAuthor = 'raild3x';
const wallyPackageName = 'requireonrails';
const moduleAccessName = 'RequireOnRails';

async function getLatestVersion() {
    return new Promise((resolve, reject) => {
        exec(`wally search ${wallyPackageName}`, (error, stdout, stderr) => {
            if (error) {
                console.warn('Failed to fetch latest version from wally, using fallback version:', error.message);
                resolve('^1.0.0'); // Fallback version
                return;
            }

            try {
                // Parse wally search output to find the latest version
                const lines = stdout.split('\n');
                for (const line of lines) {
                    if (line.includes(`${packageAuthor}/${wallyPackageName}`)) {
                        // Extract version from line like: "raild3x/requireonrails@1.2.3 - Description"
                        const versionMatch = line.match(/@(\d+\.\d+\.\d+)/);
                        if (versionMatch) {
                            resolve(`^${versionMatch[1]}`);
                            return;
                        }
                    }
                }
                
                // If we can't parse the version, use fallback
                console.warn('Could not parse version from wally search output');
                resolve('^1.0.0');
            } catch (parseError) {
                console.warn('Error parsing wally search output:', parseError.message);
                resolve('^1.0.0');
            }
        });
    });
}

async function downloadLuauModule(context) {
    // Check if workspace is available
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        vscode.window.showErrorMessage(`RequireOnRails: Please open a workspace folder first.`);
        return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;

    // Ask user for installation method
    const installMethod = await vscode.window.showQuickPick([
        {
            label: 'Wally Package Manager',
            description: 'Add to wally.toml and install via Wally',
            detail: 'Recommended for projects using Wally package manager'
        },
        {
            label: 'Raw Module',
            description: 'Download the raw Luau module file',
            detail: 'Copy the module directly into your workspace'
        }
    ], {
        placeHolder: 'How would you like to install RequireOnRails?',
        ignoreFocusOut: true
    });

    if (!installMethod) {
        return; // User cancelled
    }

    if (installMethod.label === 'Wally Package Manager') {
        await installViaWally(workspaceRoot);
    } else {
        await installRawModule(context, workspaceRoot);
    }
}

async function installViaWally(workspaceRoot) {
    const wallyTomlPath = path.join(workspaceRoot, 'wally.toml');

    // Check if wally.toml exists
    if (!fs.existsSync(wallyTomlPath)) {
        const createWally = await vscode.window.showQuickPick(['Yes', 'No'], {
            placeHolder: 'wally.toml not found. Would you like to create one?',
            ignoreFocusOut: true
        });

        if (createWally === 'Yes') {
            await createWallyToml(wallyTomlPath);
        } else {
            vscode.window.showInformationMessage('RequireOnRails: Installation cancelled. wally.toml is required for Wally installation.');
            return;
        }
    }

    try {
        // Read existing wally.toml
        let wallyContent = fs.readFileSync(wallyTomlPath, 'utf8');

        // Check if RequireOnRails is already in dependencies
        if (wallyContent.includes(wallyPackageName)) {
            vscode.window.showInformationMessage(`RequireOnRails: Already exists in wally.toml dependencies.`);
        } else {
            // Add RequireOnRails to dependencies
            const latestVersion = await getLatestVersion();
            const dependencyLine = `${moduleAccessName} = "${packageAuthor}/${wallyPackageName}@${latestVersion}"`;

            if (wallyContent.includes('[dependencies]')) {
                // Add to existing dependencies section
                wallyContent = wallyContent.replace(
                    /(\[dependencies\])/,
                    `$1\n${dependencyLine}`
                );
            } else {
                // Add dependencies section
                wallyContent += `\n[dependencies]\n${dependencyLine}\n`;
            }

            // Write updated wally.toml
            fs.writeFileSync(wallyTomlPath, wallyContent);
            vscode.window.showInformationMessage('RequireOnRails: Added to wally.toml dependencies.');
        }

        // Ask if they want to run wally install
        const runInstall = await vscode.window.showQuickPick(['Yes', 'No'], {
            placeHolder: 'Would you like to run "wally install" now?',
            ignoreFocusOut: true
        });

        if (runInstall === 'Yes') {
            await runWallyInstall(workspaceRoot);
        }

    } catch (error) {
        vscode.window.showErrorMessage(`RequireOnRails: Error updating wally.toml: ${error.message}`);
    }
}

async function createWallyToml(wallyTomlPath) {
    const latestVersion = await getLatestVersion();
    
    const wallyTemplate = `[package]
name = "username/project-name"
version = "0.1.0"
registry = "https://github.com/UpliftGames/wally-index"
realm = "shared"

[dependencies]
${moduleAccessName} = "${packageAuthor}/${wallyPackageName}@${latestVersion}"
`;

    fs.writeFileSync(wallyTomlPath, wallyTemplate);
    vscode.window.showInformationMessage('RequireOnRails: Created wally.toml with RequireOnRails dependency.');
}

async function runWallyInstall(workspaceRoot) {
    return new Promise((resolve) => {
        vscode.window.showInformationMessage('RequireOnRails: Running wally install...');
        
        exec('wally install', { cwd: workspaceRoot }, (error, stdout, stderr) => {
            if (error) {
                vscode.window.showErrorMessage(`RequireOnRails: Wally install failed: ${error.message}`);
                if (stderr) {
                    console.error('Wally stderr:', stderr);
                }
            } else {
                vscode.window.showInformationMessage('RequireOnRails: Wally install completed successfully!');
                if (stdout) {
                    console.log('Wally stdout:', stdout);
                }
            }
            resolve();
        });
    });
}

async function installRawModule(context, workspaceRoot) {
    try {
        // Get the source init.luau file from the wally_package
        const sourceFilePath = path.join(context.extensionPath, 'wally_package', 'src', 'init.luau');
        
        if (!fs.existsSync(sourceFilePath)) {
            vscode.window.showErrorMessage('RequireOnRails: Source module file not found in extension package.');
            return;
        }

        // Ask user where to place the module
        const placementOptions = [
            {
                label: 'Current Directory',
                description: 'Place in the workspace root directory',
                detail: 'Directly in the main folder'
            },
            {
                label: 'Custom Location',
                description: 'Choose a custom directory',
                detail: 'Specify your own location'
            }
        ];

        const placementChoice = await vscode.window.showQuickPick(placementOptions, {
            placeHolder: 'Where would you like to place the RequireOnRails module?',
            ignoreFocusOut: true
        });

        if (!placementChoice) {
            return; // User cancelled
        }

        let targetDir;
        if (placementChoice.label === 'Custom Location') {
            // Let user browse for directory
            const selectedFolder = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                defaultUri: vscode.Uri.file(workspaceRoot),
                openLabel: 'Select Directory'
            });

            if (!selectedFolder || selectedFolder.length === 0) {
                return; // User cancelled
            }

            targetDir = selectedFolder[0].fsPath;
        } else {
            targetDir = workspaceRoot;
        }

        // Ensure target directory exists
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        // Copy and rename the file
        const targetFilePath = path.join(targetDir, 'RequireOnRails.luau');
        const sourceContent = fs.readFileSync(sourceFilePath, 'utf8');
        
        // Check if file already exists
        if (fs.existsSync(targetFilePath)) {
            const overwrite = await vscode.window.showQuickPick(['Yes', 'No'], {
                placeHolder: 'RequireOnRails.luau already exists. Overwrite?',
                ignoreFocusOut: true
            });

            if (overwrite !== 'Yes') {
                vscode.window.showInformationMessage('RequireOnRails: Installation cancelled.');
                return;
            }
        }

        fs.writeFileSync(targetFilePath, sourceContent);

        // Get relative path for display
        const relativePath = path.relative(workspaceRoot, targetFilePath);
        
        vscode.window.showInformationMessage(
            `RequireOnRails: Module installed successfully at ${relativePath}`,
            'Open File'
        ).then(selection => {
            if (selection === 'Open File') {
                vscode.window.showTextDocument(vscode.Uri.file(targetFilePath));
            }
        });

    } catch (error) {
        vscode.window.showErrorMessage(`RequireOnRails: Error installing raw module: ${error.message}`);
    }
}

module.exports = {
    downloadLuauModule
};