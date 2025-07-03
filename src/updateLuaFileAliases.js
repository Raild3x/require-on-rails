const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const extenionName = 'require-on-rails';
const supportedExtensions = ['.lua', '.luau'];

// Helper function to get the absolute path of a directory or file
function getDirPath(workspaceRoot, filePath) {
    return path.join(workspaceRoot, filePath);
}

// Helper to check if any parent directories contain an init file
function hasInitInParentDirs(filePath, rootDir, supportedExtensions) {
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
}

// Modify the .luaurc json into a string with blank lines separating user and extension aliases, and group extension aliases by root
function adjustLuaurcWithSeparation(userAliases, extensionAliases, restConfig) {
    console.log("Adjusting .luaurc with aliases separated");

    // Group auto-generated aliases for pretty writing
    const config = vscode.workspace.getConfiguration(extenionName);
    const rootNames = config.get('directoriesToScan')
    function getRoot(path) {
        for (const root of rootNames) {
            if (path.startsWith(root + "/") || path === root) {
                return root;
            }
        }
        return "Other";
    }

    // Group extension aliases
    const grouped = {};
    for (const root of rootNames.concat("Other")) {
        grouped[root] = [];
    }
    for (const [alias, filePath] of Object.entries(extensionAliases)) {
        const group = getRoot(filePath);
        grouped[group].push({ alias, filePath });
    }
    for (const group of Object.values(grouped)) {
        group.sort((a, b) => a.alias.localeCompare(b.alias));
    }

    // Compose the aliases object with user aliases first, then extension aliases grouped
    let aliasLines = [];
    for (const [k, v] of Object.entries(userAliases)) {
        aliasLines.push(`        "${k}": "${v}",`);
    }
    if (aliasLines.length > 0 && Object.values(grouped).some(g => g.length > 0)) {
        aliasLines.push(""); // blank line between user and extension aliases
    }
    let firstGroup = true;
    for (const root of rootNames.concat("Other")) {
        const group = grouped[root] || [];
        if (group.length > 0) {
            if (!firstGroup) aliasLines.push(""); // blank line between groups
            firstGroup = false;
            for (const { alias, filePath } of group) {
                aliasLines.push(`        "${alias}": "${filePath}",`);
            }
        }
    }
    // Remove trailing comma from last alias
    if (aliasLines.length > 0) {
        let lastIdx = aliasLines.length - 1;
        while (lastIdx >= 0 && aliasLines[lastIdx].trim() === "") lastIdx--;
        if (lastIdx >= 0) aliasLines[lastIdx] = aliasLines[lastIdx].replace(/,$/, "");
    }
    let rest = { ...restConfig };
    delete rest.aliases;
    let restStr = Object.keys(rest).length > 0 ? (",\n" + JSON.stringify(rest, null, 4).slice(1, -1)) : "";
    return `{
    "aliases": {
${aliasLines.join('\n')}
    }${restStr}
}`;
}

// Helper to check if the file is located under a directory that matches any ignore pattern
function isUnderIgnoredDir(filePath, rootDir, ignorePatterns) {
    let currentDir = path.dirname(filePath);
    while (currentDir !== rootDir) {
        const dirName = path.basename(currentDir);
        if (ignorePatterns.some(pattern => {
            try {
                return new RegExp(pattern).test(dirName);
            } catch (e) {
                // If regex is invalid, fall back to exact string matching
                console.warn(`Invalid regex pattern: ${pattern}, falling back to exact match`);
                return dirName.toLowerCase() === pattern.toLowerCase();
            }
        })) {
            return true;
        }
        currentDir = path.dirname(currentDir);
    }
    return false;
}

// Helper function to check if a file should be ignored
function shouldIgnoreFile(fileName, ignoreList) {
    return ignoreList.some(substring => fileName.includes(substring));
}


// Recursive function to scan a directory and collect files by basename
function scanDir(dir, rootDir, supportedExtensions, ignorePatterns, ignoreList, basenameMap, workspaceRoot) {
    // If this directory or any of its parents (up to rootDir) matches any ignore pattern, skip entirely
    let skip = false;
    let checkDir = dir;
    while (checkDir !== rootDir && checkDir !== path.dirname(checkDir)) {
        const dirName = path.basename(checkDir);
        if (ignorePatterns.some(pattern => {
            try {
                return new RegExp(pattern).test(dirName);
            } catch (e) {
                // If regex is invalid, fall back to exact string matching
                console.warn(`Invalid regex pattern: ${pattern}, falling back to exact match`);
                return dirName.toLowerCase() === pattern.toLowerCase();
            }
        })) {
            skip = true;
            break;
        }
        checkDir = path.dirname(checkDir);
    }
    if (skip) return;

    const files = fs.readdirSync(dir, { withFileTypes: true });

    // Check for init files in the current directory
    let foundInit = null;
    for (const ext of supportedExtensions) {
        const initFilePath = path.join(dir, `init${ext}`);
        if (fs.existsSync(initFilePath)) {
            foundInit = initFilePath;
            const folderName = path.basename(dir);
            if (!isUnderIgnoredDir(initFilePath, rootDir, ignorePatterns)) {
                if (!basenameMap[folderName]) basenameMap[folderName] = [];
                basenameMap[folderName].push({
                    path: initFilePath.replace(workspaceRoot + '\\', '').replace(/\\/g, '/')
                });
            }
        }
    }

    files.forEach(file => {
        const filePath = path.join(dir, file.name);
        if (file.isDirectory()) {
            scanDir(filePath, rootDir, supportedExtensions, ignorePatterns, ignoreList, basenameMap, workspaceRoot);
        } else if (file.isFile() && supportedExtensions.includes(path.extname(file.name))) {
            if (shouldIgnoreFile(file.name, ignoreList)) {
                return;
            }
            // If this is an init file and we've already aliased the containing directory, skip aliasing "init"
            if (foundInit && file.name.startsWith('init.')) {
                return;
            }
            if (!isUnderIgnoredDir(filePath, rootDir, ignorePatterns)) {
                const aliasKey = path.parse(file.name).name;
                if (!basenameMap[aliasKey]) basenameMap[aliasKey] = [];
                basenameMap[aliasKey].push({
                    path: filePath.replace(workspaceRoot + '\\', '').replace(/\\/g, '/')
                });
            }
        }
    });
}


// Main function to generate file aliases
function generateFileAliases() {
    const config = vscode.workspace.getConfiguration(extenionName);
    
    // Check if workspace folders exist
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        console.log('No workspace folder found. Skipping alias generation.');
        return;
    }
    
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;

    const directoriesToScan = config.get('directoriesToScan') || [];
    const ignoreDirectories = config.get('ignoreDirectories') || [];
    const ignoreList = ['.server', '.client'];
    const rootDirs = directoriesToScan
        .map(dir => getDirPath(workspaceRoot, dir))
        .filter(dir => fs.existsSync(dir) && fs.statSync(dir).isDirectory());
    const luaurcPath = getDirPath(workspaceRoot, '.luaurc');
    const extensionAliasPath = getDirPath(workspaceRoot, '.requireonrails.json');

    // Read and update the .luaurc file with generated aliases
    let luaurc = {};
    if (fs.existsSync(luaurcPath)) {
        const rawData = fs.readFileSync(luaurcPath, 'utf8');
        try {
            luaurc = rawData ? JSON.parse(rawData) : {};
        } catch (e) {
            console.warn("Failed to parse .luaurc as JSON:", e);
            vscode.window.showErrorMessage("RequireOnRails: Failed to parse .luaurc as JSON. Please fix or delete the file.");
            return
        }
    }

    // Map of basename -> array of { path }
    const basenameMap = {};
    rootDirs.forEach(rootDir => {
        console.log(`Scanning directory: ${rootDir}`);
        scanDir(rootDir, rootDir, supportedExtensions, ignoreDirectories, ignoreList, basenameMap, workspaceRoot);
    });

    // console.log("Finished scanning directories. Found basenames:", Object.keys(basenameMap));

    // Read the extension's alias tracker file (now with ManualAliases and AutoGeneratedAliases)
    let extensionAliases = { manualAliases: {}, autoGeneratedAliases: {} };
    if (fs.existsSync(extensionAliasPath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(extensionAliasPath, 'utf8')) || {};
            extensionAliases = parsed
            extensionAliases.manualAliases = extensionAliases.manualAliases || {};
            extensionAliases.autoGeneratedAliases = {};
        } catch (e) {
            console.warn(`Failed to read or parse extension alias tracker at ${extensionAliasPath}:`, e);
            vscode.window.showErrorMessage(`RequireOnRails: Failed to read or parse extension alias tracker at ${extensionAliasPath}. Please fix or delete the file.`);
            return
        }
    }

    // Merge manual and auto-generated aliases for currentAliases, manual takes precedence
    let compiledAliases = {};

    // Add manual aliases from extensionAliasPath (these take precedence)
    for (const [k, v] of Object.entries(extensionAliases.manualAliases)) {
        compiledAliases[k] = v;
    }

    // Track which aliases are ambiguous (multiple files with same basename)
    const ambiguousAliases = new Set();
    // Track which aliases are unique (only one file with that basename)
    const uniqueAliases = {};
    for (const [basename, arr] of Object.entries(basenameMap)) {
        if (arr.length === 1) {
            uniqueAliases[basename] = arr[0].path;
            // console.log(`Unique alias: "${basename}" -> "${arr[0].path}"`);
        } else {
            ambiguousAliases.add(basename);
            console.log(`Ambiguous alias: "${basename}" found in:`, arr.map(x => x.path));
        }
    }

    // Add or update unique aliases (auto-generated)
    for (const [key, value] of Object.entries(uniqueAliases)) {
        if (!extensionAliases.manualAliases[key]) { // don't overwrite manual
            compiledAliases[key] = value;
            extensionAliases.autoGeneratedAliases[key] = value;
        }
    }

    // console.log("Current aliases after processing:", JSON.stringify(currentAliases, null, 2));
    luaurc.aliases = compiledAliases;

    // Create a proper JSON structure ensuring aliases is always an object
    const finalLuaurc = {
        aliases: compiledAliases || {},
        ...Object.fromEntries(Object.entries(luaurc).filter(([key]) => key !== 'aliases'))
    };

    // Write with proper JSON formatting
    const luaurcString = JSON.stringify(finalLuaurc, null, 4);
    fs.writeFileSync(luaurcPath, luaurcString);

    // Write updated extension alias tracker file
    const newExtensionJsonContent = JSON.stringify(extensionAliases, null, 4)
    fs.writeFileSync(extensionAliasPath, newExtensionJsonContent);
    // console.log('Updated .luaurc aliases:', JSON.stringify(luaurc.aliases, null, 2));
    // console.log('Updated extension alias tracker:', newExtensionJsonContent);
}

module.exports = { generateFileAliases };