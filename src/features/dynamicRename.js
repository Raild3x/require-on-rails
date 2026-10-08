// Dynamic mode's answer to a rename/move, in the editor: the requirePlanner decides, this
// prompts per the three enable* settings and writes. Edits go straight to disk rather than
// through a WorkspaceEdit, so files nobody has open are not left dirty.

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { print } = require('../core/logger');
const { writeEdits } = require('../core/plan');
const pathResolver = require('./pathResolver');
const { analyzeFileOperation, planCollisionRename, planAbsoluteAliasPaths, planSpecRewrite } = require('./requirePlanner');
const { getWorkspaceRoot, getSettings, settingsHaveErrors, refreshContext } = require('../utils/workspaceUtils');

/**
 * Rewrites every require that is exactly `oldSpec`, against a fresh index.
 * @param {string} workspaceRoot
 * @param {string} oldSpec
 * @param {string} newSpec
 * @returns {number} Files written
 */
function rewriteSpec(workspaceRoot, oldSpec, newSpec) {
    const ctx = refreshContext();
    if (!ctx) return 0;
    return writeEdits(workspaceRoot, planSpecRewrite(ctx, pathResolver.readSourceTexts(ctx), oldSpec, newSpec)).length;
}

/**
 * @param {string} workspaceRoot
 * @param {string} oldRel
 * @param {string} newRel
 * @returns {Promise<void>}
 */
async function offerAbsolutePathUpdate(workspaceRoot, oldRel, newRel) {
    const paths = planAbsoluteAliasPaths(oldRel, newRel, getSettings()['manualAliases'] || {});
    if (!paths) return;
    const selection = await vscode.window.showInformationMessage(
        `Update absolute require paths from "${paths.oldPath}" to "${paths.newPath}"?`,
        'Yes', 'No'
    );
    if (selection !== 'Yes') return;
    const files = rewriteSpec(workspaceRoot, paths.oldPath, paths.newPath);
    if (files > 0) vscode.window.showInformationMessage(`Updated absolute require paths in ${files} file(s).`);
}

/**
 * One rename/move, after it happened on disk. In order: the collision rename (applied, with a
 * warning), the basename update prompt, then the absolute path update prompt.
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
    const operation = analyzeFileOperation(newFilePath, oldFilePath);
    if (!operation) return;
    // Rewrites refuse to run on settings that did not resolve (ADR 0004).
    if (settingsHaveErrors()) return;

    const settings = getSettings();
    /** @param {string} p */
    const toRel = p => path.relative(workspaceRoot, p).replace(/\\/g, '/');
    const oldRel = toRel(oldFilePath);
    let newRel = toRel(newFilePath);
    const absoluteUpdates = operation.isMove && settings['enableAbsolutePathUpdates'];

    if (operation.oldFileBasename === operation.newFileBasename) {
        print(`File was ${operation.operationType} but basename unchanged, no require updates needed`);
        if (absoluteUpdates) await offerAbsolutePathUpdate(workspaceRoot, oldRel, newRel);
        return;
    }

    let newBasename = operation.newFileBasename;
    if (settings['enableFileNameCollisionResolution']) {
        const ctx = refreshContext();
        const collision = ctx && planCollisionRename(ctx, newRel, newBasename);
        if (collision && fs.existsSync(path.join(workspaceRoot, collision.newRel))) {
            // Renaming onto it would overwrite that file, so the clash is left for the user.
            vscode.window.showWarningMessage(`Filename collision detected, but ${collision.newRel} already exists. Rename it yourself to keep "${newBasename}" unambiguous.`);
        } else if (collision) {
            fs.renameSync(path.join(workspaceRoot, newRel), path.join(workspaceRoot, collision.newRel));
            vscode.window.showWarningMessage(`Filename collision detected. Renaming to ${collision.newBasename}`);
            newRel = collision.newRel;
            newBasename = collision.newBasename;
        }
    }

    if (settings['enableBasenameUpdates']) {
        const oldSpec = `@${operation.oldFileBasename}`;
        const newSpec = `@${newBasename}`;
        const selection = await vscode.window.showInformationMessage(
            `File was ${operation.operationType}. Update require statements from ${oldSpec} to ${newSpec}?`,
            'Yes', 'No'
        );
        if (selection === 'Yes') {
            const files = rewriteSpec(workspaceRoot, oldSpec, newSpec);
            if (files > 0) vscode.window.showInformationMessage(`Updated require statements in ${files} file(s).`);
        } else {
            vscode.window.showInformationMessage('Require update cancelled.');
        }
    }

    if (absoluteUpdates) await offerAbsolutePathUpdate(workspaceRoot, oldRel, newRel);
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

module.exports = { handleRenameEventDynamic, handleDynamicRename };
