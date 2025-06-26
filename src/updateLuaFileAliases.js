const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

// Helper function to get the absolute path of a directory or file
function getDirPath(workspaceRoot, filePath) {
    return path.join(workspaceRoot, filePath);
}

// Main function to generate file aliases
function generateFileAliases() {
    const config = vscode.workspace.getConfiguration('require-on-rails');
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;

    // Get directories to scan from config, default fallback
    const directoriesToScan = config.get('directoriesToScan');
    // Get ignore directories from config, default fallback
    const ignoreDirectories = config.get('ignoreDirectories');

    // Supported file extensions for alias generation
    const supportedExtensions = ['.lua', '.luau', '.json'];
    // List of substrings to ignore in file basenames
    const ignoreList = ['.server', '.client'];

    // List of root directories to scan for files
    const rootDirs = directoriesToScan
        .map(dir => getDirPath(workspaceRoot, dir))
        .filter(dir => fs.existsSync(dir) && fs.statSync(dir).isDirectory());

    // Path to the .luaurc configuration file
    const luaurcPath = getDirPath(workspaceRoot, '.luaurc');

    // Check if any parent directories contain an init file
    const hasInitInParentDirs = (filePath, rootDir) => {
        let currentDir = path.dirname(filePath);
        while (currentDir !== rootDir) {
            for (const ext of supportedExtensions) {
                if (fs.existsSync(path.join(currentDir, `init${ext}`))) {
                    return true;
                }
            }
            currentDir = path.dirname(currentDir);
        }
        return false;
    };

    // Check if the file is located under a directory named in ignoreDirectories
    const isUnderIgnoredDir = (filePath, rootDir) => {
        let currentDir = path.dirname(filePath);
        while (currentDir !== rootDir) {
            if (ignoreDirectories.some(ignored => path.basename(currentDir).toLowerCase() === ignored.toLowerCase())) {
                return true;
            }
            currentDir = path.dirname(currentDir);
        }
        return false;
    };

    // Helper function to check if a file should be ignored
    const shouldIgnoreFile = (fileName) => {
        return ignoreList.some(substring => fileName.includes(substring));
    };

    let aliases = {};

    // Recursive function to scan a directory and generate aliases
    const scanDir = (dir, rootDir) => {
        // If this directory or any of its parents (up to rootDir) is in ignoreDirectories, skip entirely
        let skip = false;
        let checkDir = dir;
        while (checkDir !== rootDir && checkDir !== path.dirname(checkDir)) {
            if (ignoreDirectories.some(ignored => path.basename(checkDir).toLowerCase() === ignored.toLowerCase())) {
                skip = true;
                break;
            }
            checkDir = path.dirname(checkDir);
        }
        if (skip) return;

        const files = fs.readdirSync(dir, { withFileTypes: true });
        let containsInit = false;

        // Check for init files in the current directory
        for (const ext of supportedExtensions) {
            const initFilePath = path.join(dir, `init${ext}`);
            if (fs.existsSync(initFilePath)) {
                containsInit = true;
                const folderName = path.basename(dir);
                if (!isUnderIgnoredDir(initFilePath, rootDir) && !hasInitInParentDirs(dir, rootDir)) {
                    aliases[folderName] = initFilePath.replace(workspaceRoot + '\\', '').replace(/\\/g, '/');
                }
            }
        }

        files.forEach(file => {
            const filePath = path.join(dir, file.name);
            if (file.isDirectory()) {
                scanDir(filePath, rootDir);
            } else if (file.isFile() && supportedExtensions.includes(path.extname(file.name))) {
                if (shouldIgnoreFile(file.name)) {
                    return;
                }
                if (!hasInitInParentDirs(filePath, rootDir) && !isUnderIgnoredDir(filePath, rootDir)) {
                    const aliasKey = path.parse(file.name).name;
                    aliases[aliasKey] = filePath.replace(workspaceRoot + '\\', '').replace(/\\/g, '/');
                }
            }
        });
    };

    rootDirs.forEach(rootDir => {
        scanDir(rootDir, rootDir);
    });

    // Read and update the .luaurc file with generated aliases
    let luaurc = {};
    if (fs.existsSync(luaurcPath)) {
        const rawData = fs.readFileSync(luaurcPath, 'utf8');
        luaurc = rawData ? JSON.parse(rawData) : {};
    }

    // Clean up and update aliases: keep only valid user aliases, add/replace generated ones if missing or invalid
    let currentAliases = (luaurc.aliases && typeof luaurc.aliases === 'object') ? { ...luaurc.aliases } : {};
    // Remove any aliases with invalid paths
    for (const [key, value] of Object.entries(currentAliases)) {
        if (typeof value !== 'string' || !fs.existsSync(getDirPath(workspaceRoot, value))) {
            delete currentAliases[key];
        }
    }
    // Add or update generated aliases if missing or invalid
    for (const [key, value] of Object.entries(aliases)) {
        if (
            !currentAliases[key] ||
            typeof currentAliases[key] !== 'string' ||
            !fs.existsSync(getDirPath(workspaceRoot, currentAliases[key]))
        ) {
            currentAliases[key] = value;
        }
    }
    luaurc.aliases = currentAliases;

    fs.writeFileSync(luaurcPath, JSON.stringify(luaurc, null, 4));
    console.log('Updated .luaurc aliases');
}

module.exports = { generateFileAliases };