// Dynamic mode's answer to a rename/move: the requirePlanner decides, the flow here asks per
// the three enable* settings and writes. The asking is passed in, so the editor prompts and
// the CLI answers yes to whatever the settings enable. Edits go straight to disk rather than
// through a WorkspaceEdit, so files nobody has open are not left dirty.

const fs = require('fs');
const path = require('path');
// Optional — see updateLuaFileAliases.js. Only the editor entry points dereference it.
/** @type {typeof import('vscode') | null} */
let vscode = null;
try { vscode = require('vscode'); } catch (e) { /* running outside VS Code */ }
const { print } = require('../core/logger');
const { writeEdits } = require('../core/plan');
const { resolverOptions } = require('../core/settings');
const pathResolver = require('./pathResolver');
const { analyzeFileOperation, planCollisionRename, planAbsoluteAliasPaths, planSpecRewrite } = require('./requirePlanner');
const { getWorkspaceRoot, getSettings, settingsHaveErrors } = require('../utils/workspaceUtils');

/**
 * How the flow talks to whoever runs it.
 * @typedef {object} RenameUI
 * @property {(message: string) => Promise<boolean>} confirm
 * @property {(message: string) => void} info
 * @property {(message: string) => void} warn
 */

/**
 * Rewrites every require that is exactly `oldSpec`, against a fresh index.
 * @param {string} workspaceRoot
 * @param {Record<string, any>} settings
 * @param {string} oldSpec
 * @param {string} newSpec
 * @returns {string[]} Root-relative files written
 */
function rewriteSpec(workspaceRoot, settings, oldSpec, newSpec) {
    const ctx = pathResolver.createContext(workspaceRoot, resolverOptions(settings));
    return writeEdits(workspaceRoot, planSpecRewrite(ctx, pathResolver.readSourceTexts(ctx), oldSpec, newSpec));
}

/**
 * @param {string} workspaceRoot
 * @param {Record<string, any>} settings
 * @param {string} oldRel
 * @param {string} newRel
 * @param {RenameUI} ui
 * @returns {Promise<string[]>} Files written
 */
async function offerAbsolutePathUpdate(workspaceRoot, settings, oldRel, newRel, ui) {
    const paths = planAbsoluteAliasPaths(oldRel, newRel, settings['manualAliases'] || {});
    if (!paths) return [];
    if (!await ui.confirm(`Update absolute require paths from "${paths.oldPath}" to "${paths.newPath}"?`)) return [];
    const files = rewriteSpec(workspaceRoot, settings, paths.oldPath, paths.newPath);
    if (files.length > 0) ui.info(`Updated absolute require paths in ${files.length} file(s).`);
    return files;
}

/**
 * One rename/move, after it happened on disk. In order: the collision rename (applied, with a
 * warning), the basename update, then the absolute path update — each per its setting.
 * @param {string} workspaceRoot
 * @param {Record<string, any>} settings - Resolved settings
 * @param {string} oldRel - Root-relative
 * @param {string} newRel - Root-relative
 * @param {RenameUI} ui
 * @returns {Promise<{finalRel: string, filesWritten: string[]}>} finalRel differs from newRel
 *   after a collision rename
 */
async function renameDynamic(workspaceRoot, settings, oldRel, newRel, ui) {
    /** @type {string[]} */
    const filesWritten = [];
    const operation = analyzeFileOperation(newRel, oldRel);
    if (!operation) return { finalRel: newRel, filesWritten };
    // Only a module — a Luau file, or a folder with an init file — has an alias to rewrite.
    // Renaming docs/Util.md, or a plain folder named Util, must not touch @Util.
    const index = pathResolver.createContext(workspaceRoot, resolverOptions(settings));
    if (![newRel, `${newRel}/init.luau`, `${newRel}/init.lua`].some(target => index.targetSet.has(target))) {
        print(`${newRel} is not a module under directoriesToScan, no require updates needed`);
        return { finalRel: newRel, filesWritten };
    }
    const absoluteUpdates = operation.isMove && settings['enableAbsolutePathUpdates'];

    if (operation.oldFileBasename === operation.newFileBasename) {
        print(`File was ${operation.operationType} but basename unchanged, no require updates needed`);
        if (absoluteUpdates) filesWritten.push(...await offerAbsolutePathUpdate(workspaceRoot, settings, oldRel, newRel, ui));
        return { finalRel: newRel, filesWritten };
    }

    let newBasename = operation.newFileBasename;
    if (settings['enableFileNameCollisionResolution']) {
        const collision = planCollisionRename(index, newRel, newBasename);
        if (collision && fs.existsSync(path.join(workspaceRoot, collision.newRel))) {
            // Renaming onto it would overwrite that file, so the clash is left for the user.
            ui.warn(`Filename collision detected, but ${collision.newRel} already exists. Rename it yourself to keep "${newBasename}" unambiguous.`);
        } else if (collision) {
            fs.renameSync(path.join(workspaceRoot, newRel), path.join(workspaceRoot, collision.newRel));
            ui.warn(`Filename collision detected. Renaming to ${collision.newBasename}`);
            newRel = collision.newRel;
            newBasename = collision.newBasename;
        }
    }

    // After the move, another module still answering to the old name owns @Old (the moved
    // file was a same-named duplicate, or came from outside the scan), so its requires stay.
    const oldNameTaken = (index.targets[operation.oldFileBasename] || []).length > 0;
    if (oldNameTaken) {
        print(`@${operation.oldFileBasename} still names another module, so its requires are left as they are`);
    } else if (settings['enableBasenameUpdates']) {
        const oldSpec = `@${operation.oldFileBasename}`;
        const newSpec = `@${newBasename}`;
        if (await ui.confirm(`File was ${operation.operationType}. Update require statements from ${oldSpec} to ${newSpec}?`)) {
            const files = rewriteSpec(workspaceRoot, settings, oldSpec, newSpec);
            filesWritten.push(...files);
            if (files.length > 0) ui.info(`Updated require statements in ${files.length} file(s).`);
        } else {
            ui.info('Require update cancelled.');
        }
    }

    if (absoluteUpdates) filesWritten.push(...await offerAbsolutePathUpdate(workspaceRoot, settings, oldRel, newRel, ui));
    return { finalRel: newRel, filesWritten };
}

// ---------------------------------------------------------------------------
// Editor entry points
// ---------------------------------------------------------------------------

/** @returns {RenameUI} */
function editorUI() {
    if (!vscode) throw new Error('dynamicRename: the editor UI requires VS Code.');
    const window = vscode.window;
    return {
        confirm: message => Promise.resolve(window.showInformationMessage(message, 'Yes', 'No')).then(choice => choice === 'Yes'),
        info: message => { window.showInformationMessage(message); },
        warn: message => { window.showWarningMessage(message); }
    };
}

/**
 * @param {string} newFilePath - Absolute
 * @param {string} oldFilePath - Absolute
 * @returns {Promise<void>}
 */
async function handleDynamicRename(newFilePath, oldFilePath) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        print('No workspace folder found. Skipping require name updates.');
        return;
    }
    // Rewrites refuse to run on settings that did not resolve (ADR 0004).
    if (settingsHaveErrors()) return;
    /** @param {string} p */
    const toRel = p => path.relative(workspaceRoot, p).replace(/\\/g, '/');
    await renameDynamic(workspaceRoot, getSettings(), toRel(oldFilePath), toRel(newFilePath), editorUI());
}

/**
 * @param {import('vscode').FileRenameEvent['files']} files
 * @returns {Promise<void>}
 */
async function handleRenameEventDynamic(files) {
    for (const file of files) {
        await handleDynamicRename(file.newUri.fsPath, file.oldUri.fsPath);
    }
}

module.exports = { renameDynamic, handleRenameEventDynamic, handleDynamicRename };
