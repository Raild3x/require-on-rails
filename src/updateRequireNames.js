const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

function updateRequireNames(newFilePath, oldFilePath) {
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;

    const config = vscode.workspace.getConfiguration('require-on-rails');
    const supportedExtensions = config.get('supportedExtensions', ['.lua', '.luau']);
    const requirePrefix = config.get('requirePrefix', '@');
    const directoriesToScan = ['src'] //config.get('directoriesToScan', );
    const ignoreDirectories = config.get('ignoreDirectories', []);

    // Compose scan roots
    const scanRoots = directoriesToScan.map(dir => path.join(workspaceRoot, dir));

    // Infer file names from paths
    const oldFileBasename = path.basename(oldFilePath, path.extname(oldFilePath));
    const newFileName = path.basename(newFilePath);
    let newFileBasename = path.basename(newFileName, path.extname(newFileName));

    // Check for filename collision
    function checkForCollision(dir) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            if (fullPath === newFilePath) continue;
            if (fs.statSync(fullPath).isDirectory()) {
                // Check if directory name matches newFileBasename and contains an init file
                if (path.basename(fullPath) === newFileBasename) {
                    for (const ext of supportedExtensions) {
                        if (fs.existsSync(path.join(fullPath, `init${ext}`))) {
                            return true;
                        }
                    }
                }
                if (ignoreDirectories.includes(path.basename(fullPath))) continue;
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
        newFileBasename = renamedFileBasename;
        newFilePath = renamedFilePath;
    }

    // Prompt user before updating requires
    vscode.window.showInformationMessage(
        `Update require statements from ${requirePrefix}${oldFileBasename} to ${requirePrefix}${newFileBasename}?`,
        'Yes', 'No'
    ).then(selection => {
        if (selection !== 'Yes') {
            vscode.window.showInformationMessage('Require update cancelled.');
            return;
        }

        // Update requires in files
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

        function processDirectory(directory) {
            const files = fs.readdirSync(directory);
            for (const file of files) {
                const fullPath = path.join(directory, file);
                if (fs.statSync(fullPath).isDirectory()) {
                    if (ignoreDirectories.includes(path.basename(fullPath))) continue;
                    processDirectory(fullPath);
                } else if (supportedExtensions.includes(path.extname(file))) {
                    updateRequiresInFile(fullPath);
                }
            }
        }

        // Scan all roots
        for (const root of scanRoots) {
            if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
                processDirectory(root);
            }
        }
    });
}

module.exports = { updateRequireNames };