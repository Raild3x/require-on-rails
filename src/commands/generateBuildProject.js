const fs = require('fs');
const path = require('path');
// Optional — see updateLuaFileAliases.js. computeBuildProject is pure; only the command
// entry point below touches the editor.
/** @type {typeof import('vscode') | null} */
let vscode = null;
try { vscode = require('vscode'); } catch (e) { /* running outside VS Code */ }
const { print, warn } = require('../core/logger');
const { getCommonConfig, getBuildConversionConfig, requireWorkspaceRoot } = require('../utils/workspaceUtils');

/** @param {string} p */
function normalize(p) {
    return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
}

/**
 * Clones a parsed Rojo project with every string $path that lives inside a scanned directory
 * redirected into the output directory. $path entries outside the scanned directories
 * (Packages, asset folders, ...) are left pointing at the source tree.
 *
 * A $path that *contains* a scanned directory (e.g. "$path": "src" over scanned "src/Shared")
 * cannot be redirected cleanly — the output holds only the scanned subset — so it is left
 * unchanged and reported for the user to restructure or hand-maintain.
 *
 * @param {any} project - Parsed Rojo project JSON
 * @param {string[]} directoriesToScan
 * @param {string} outputDirectory
 * @returns {{project: any, redirected: string[], overlaps: string[]}}
 */
function computeBuildProject(project, directoriesToScan, outputDirectory) {
    const scanned = directoriesToScan.map(normalize);
    /** @type {string[]} */
    const redirected = [];
    /** @type {string[]} */
    const overlaps = [];

    /** @param {any} node */
    function walk(node) {
        if (typeof node !== 'object' || node === null) return;
        const rawPath = node['$path'];
        if (typeof rawPath === 'string') {
            const norm = normalize(rawPath);
            if (scanned.some(dir => norm === dir || norm.startsWith(dir + '/'))) {
                node['$path'] = `${outputDirectory}/${norm}`;
                redirected.push(norm);
            } else if (scanned.some(dir => dir.startsWith(norm + '/'))) {
                overlaps.push(norm);
            }
        }
        for (const [key, child] of Object.entries(node)) {
            if (key.startsWith('$')) continue;
            walk(child);
        }
    }

    const clone = JSON.parse(JSON.stringify(project));
    if (clone && typeof clone.tree === 'object') walk(clone.tree);
    return { project: clone, redirected, overlaps };
}

/**
 * The Generate Build Project File command: clones the user's Rojo project with scanned
 * $path entries redirected into the output directory, prompting before overwriting a file
 * that differs from what would be written.
 */
async function generateBuildProject() {
    if (!vscode) return;
    const workspaceRoot = requireWorkspaceRoot('build project generation');
    if (!workspaceRoot) return;

    const { directoriesToScan, rojoProjectPath } = getCommonConfig();
    const { outputDirectory, buildProjectFile } = getBuildConversionConfig();

    const projectAbs = path.join(workspaceRoot, rojoProjectPath);
    if (!fs.existsSync(projectAbs)) {
        vscode.window.showErrorMessage(`RequireOnRails: Rojo project "${rojoProjectPath}" not found (require-on-rails.rojoProjectPath).`);
        return;
    }

    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(projectAbs, 'utf8'));
    } catch (e) {
        vscode.window.showErrorMessage(`RequireOnRails: could not parse "${rojoProjectPath}" as JSON.`);
        return;
    }

    const { project, redirected, overlaps } = computeBuildProject(parsed, directoriesToScan, outputDirectory);

    if (redirected.length === 0) {
        vscode.window.showWarningMessage(
            `RequireOnRails: no $path entries in "${rojoProjectPath}" fall inside the scanned directories — nothing to redirect. ` +
            `Check require-on-rails.directoriesToScan.`);
        return;
    }
    for (const overlap of overlaps) {
        warn(`generateBuildProject: "$path": "${overlap}" contains a scanned directory but also other content, so it was NOT redirected. ` +
            `Split it into per-directory $path entries, or maintain the build project by hand.`);
    }

    const outAbs = path.join(workspaceRoot, buildProjectFile);
    const serialized = JSON.stringify(project, null, 4) + '\n';

    if (fs.existsSync(outAbs) && fs.readFileSync(outAbs, 'utf8') !== serialized) {
        const overwrite = 'Overwrite';
        const choice = await vscode.window.showWarningMessage(
            `"${buildProjectFile}" already exists and differs from what would be generated. Overwrite it?`,
            { modal: true, detail: `Redirects ${redirected.length} $path entr${redirected.length === 1 ? 'y' : 'ies'} into "${outputDirectory}/". Your existing file will be replaced.` },
            overwrite
        );
        if (choice !== overwrite) return;
    }

    fs.writeFileSync(outAbs, serialized, 'utf8');
    print(`generateBuildProject: wrote ${buildProjectFile} (${redirected.length} $path entries redirected into ${outputDirectory}/).`);
    vscode.window.showInformationMessage(
        `RequireOnRails: wrote ${buildProjectFile}. Point rojo at it (rojo serve ${buildProjectFile}) to consume the converted output.` +
        (overlaps.length > 0 ? ` ${overlaps.length} $path entr${overlaps.length === 1 ? 'y' : 'ies'} could not be redirected — see the output log.` : ''));
}

module.exports = { generateBuildProject, computeBuildProject };
