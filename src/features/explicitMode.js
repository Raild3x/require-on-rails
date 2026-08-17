const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { print, debug } = require('../core/logger');
const pathResolver = require('./pathResolver');
const { getExplicitPathStyle, getExtensionConfig } = require('../utils/workspaceUtils');

const LANGUAGES = ['luau', 'lua'];

function isLuaDoc(document) {
    return LANGUAGES.includes(document.languageId) && document.uri.scheme === 'file';
}

function getWorkspaceRoot() {
    return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
        ? vscode.workspace.workspaceFolders[0].uri.fsPath
        : null;
}

function toRel(workspaceRoot, fsPath) {
    return path.relative(workspaceRoot, fsPath).replace(/\\/g, '/');
}

function getCtx() {
    return pathResolver.getContext() || pathResolver.refreshContext();
}

function renderFor(targetRel, fromRel, ctx) {
    const config = getExtensionConfig();
    return pathResolver.renderRequire(
        targetRel,
        fromRel,
        getExplicitPathStyle(),
        config.get('preferRelativePaths', false),
        ctx
    );
}

// The replacement for a bare "@name" short require, or null when the spec is not eligible:
// already an alias root (or reserved), has path segments, or matches no known module.
function computeReplacement(spec, fromRel, ctx) {
    if (!spec.startsWith('@') || spec.includes('/')) return null;
    const name = spec.slice(1);
    if (!name || pathResolver.RESERVED_ALIASES.has(name)) return null;
    if (ctx.aliases[name] !== undefined) return null; // an existing alias wins over rewriting
    const candidates = ctx.targets[name];
    if (!candidates || candidates.length === 0) return null;
    const best = pathResolver.rankByDistance(candidates, fromRel, ctx.pathPriority)[0];
    const rendered = renderFor(best, fromRel, ctx);
    return rendered === spec ? null : rendered;
}

// ---------------------------------------------------------------------------
// Completion: bare module names -> full rendered path. Directory-segment browsing
// (@Shared/Sub/...) is left to luau-lsp, so anything containing '/' is ignored.
// ---------------------------------------------------------------------------

const REQUIRE_TYPING_RE = /require\s*\(\s*(['"])([^'"]*)$/;

const completionProvider = {
    provideCompletionItems(document, position) {
        if (!isLuaDoc(document)) return undefined;
        const workspaceRoot = getWorkspaceRoot();
        if (!workspaceRoot) return undefined;

        const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
        const match = REQUIRE_TYPING_RE.exec(linePrefix);
        if (!match) return undefined;

        const typed = match[2];
        if (!typed.startsWith('@') || typed.includes('/')) return undefined;

        const ctx = getCtx();
        if (!ctx) return undefined;

        const fromRel = toRel(workspaceRoot, document.uri.fsPath);
        const fragment = typed.slice(1).toLowerCase();

        const candidates = [];
        for (const [basename, targets] of Object.entries(ctx.targets)) {
            if (!basename.toLowerCase().startsWith(fragment)) continue;
            for (const target of targets) {
                if (target === fromRel) continue; // a module requiring itself is never the intent
                candidates.push({ basename, target });
            }
        }
        if (candidates.length === 0) return undefined;

        const ranked = pathResolver.rankByDistance(candidates.map(c => c.target), fromRel, ctx.pathPriority);
        const rankOf = new Map(ranked.map((target, index) => [target, index]));
        const replaceRange = new vscode.Range(position.translate(0, -typed.length), position);

        return candidates.map(({ basename, target }) => {
            const rendered = renderFor(target, fromRel, ctx);
            // A label object's `description` renders greyed-out on every visible row,
            // so same-named candidates are distinguishable without focusing each one.
            const item = new vscode.CompletionItem(
                { label: basename, description: rendered },
                vscode.CompletionItemKind.Module
            );
            item.documentation = target;
            item.insertText = rendered;
            item.range = replaceRange;
            item.filterText = `@${basename}`;
            item.sortText = String(rankOf.get(target)).padStart(5, '0');
            return item;
        });
    }
};

// ---------------------------------------------------------------------------
// Auto-replace: a just-typed bare "@name" is rewritten to the closest module's full path
// when the cursor leaves the string, with an on-save sweep as the catch-all. The sweep
// skips any require string containing a cursor, so an autosave that fires mid-word
// (files.autoSave: afterDelay) can never rewrite a half-typed name.
// ---------------------------------------------------------------------------

// doc uri string -> Set of line numbers edited since the last sweep. Only requires on
// these lines are auto-replaced by the cursor-leave trigger, so merely moving the caret
// through pre-existing short requires never rewrites them.
const _editedLines = new Map();
// editor -> Position[] of the previous selection, to detect "cursor left the string".
const _prevSelections = new WeakMap();

function noteEditedLines(event) {
    if (!isLuaDoc(event.document)) return;
    let lines = _editedLines.get(event.document.uri.toString());
    if (!lines) {
        lines = new Set();
        _editedLines.set(event.document.uri.toString(), lines);
    }
    for (const change of event.contentChanges) {
        const added = (change.text.match(/\n/g) || []).length;
        for (let line = change.range.start.line; line <= change.range.start.line + added; line++) {
            lines.add(line);
        }
    }
}

function requireMatchesOnLine(document, line) {
    if (line >= document.lineCount) return [];
    const text = document.lineAt(line).text;
    const matches = [];
    pathResolver.REQUIRE_STRING.lastIndex = 0;
    let match;
    while ((match = pathResolver.REQUIRE_STRING.exec(text)) !== null) {
        const spec = match[2];
        const startColumn = match.index + match[0].indexOf(spec);
        matches.push({
            spec,
            range: new vscode.Range(line, startColumn, line, startColumn + spec.length)
        });
    }
    return matches;
}

function selectionsIntersect(document, range) {
    for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document !== document) continue;
        for (const selection of editor.selections) {
            if (range.intersection(selection) !== undefined || range.contains(selection.active)) return true;
        }
    }
    return false;
}

function onSelectionChanged(event) {
    const editor = event.textEditor;
    const document = editor.document;
    if (!isLuaDoc(document)) return;

    const previous = _prevSelections.get(editor);
    _prevSelections.set(editor, event.selections.map(s => s.active));
    if (!previous) return;

    const edited = _editedLines.get(document.uri.toString());
    if (!edited || edited.size === 0) return;

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    for (const prevPos of previous) {
        if (!edited.has(prevPos.line)) continue;
        for (const { spec, range } of requireMatchesOnLine(document, prevPos.line)) {
            if (!range.contains(prevPos)) continue;
            // Still inside (any cursor)? Not "finished typing" yet.
            if (selectionsIntersect(document, range)) continue;

            const ctx = getCtx();
            if (!ctx) return;
            const newText = computeReplacement(spec, toRel(workspaceRoot, document.uri.fsPath), ctx);
            if (!newText) continue;

            const workspaceEdit = new vscode.WorkspaceEdit();
            workspaceEdit.replace(document.uri, range, newText);
            vscode.workspace.applyEdit(workspaceEdit);
            edited.delete(prevPos.line);
            print(`explicit mode: rewrote "${spec}" -> "${newText}"`);
        }
    }
}

function computeSweepEdits(document) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return [];
    const ctx = getCtx();
    if (!ctx) return [];

    const fromRel = toRel(workspaceRoot, document.uri.fsPath);
    const edits = [];
    for (const found of pathResolver.findRequireStrings(document.getText())) {
        const range = new vscode.Range(found.line, found.startColumn, found.line, found.endColumn);
        if (selectionsIntersect(document, range)) continue; // mid-typing guard (autosave)
        const newText = computeReplacement(found.spec, fromRel, ctx);
        if (newText) edits.push(vscode.TextEdit.replace(range, newText));
    }
    if (edits.length > 0) print(`explicit mode: on-save sweep rewrote ${edits.length} require(s) in ${fromRel}`);
    return edits;
}

function onWillSave(event) {
    if (!isLuaDoc(event.document)) return;
    event.waitUntil(Promise.resolve(computeSweepEdits(event.document)));
    _editedLines.delete(event.document.uri.toString());
}

// ---------------------------------------------------------------------------
// Renames/moves. Inbound requires (elsewhere, pointing at the moved item) are collected and
// PROMPTED — moving a file away and dropping a same-named replacement in its place must be
// able to leave old requires untouched. Outbound requires (inside the moved item) broke
// unconditionally by the move itself, so they are fixed automatically.
// ---------------------------------------------------------------------------

// Maps a module path under a renamed prefix to its new location, or null if unaffected.
function remapModulePath(modulePath, oldPrefix, newPrefix) {
    if (modulePath === oldPrefix) return newPrefix;
    if (modulePath.startsWith(oldPrefix + '/')) return newPrefix + modulePath.slice(oldPrefix.length);
    return null;
}

async function handleRenameEventExplicit(files) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    // Renames already happened on disk, so a fresh context sees the new world; where a
    // require *used* to point is recovered with resolveModulePath (no existence probing).
    const ctx = pathResolver.refreshContext();
    if (!ctx) return;

    const renames = [];
    for (const file of files) {
        const newRel = toRel(workspaceRoot, file.newUri.fsPath);
        const oldRel = toRel(workspaceRoot, file.oldUri.fsPath);
        let isDirectory = false;
        try {
            isDirectory = fs.statSync(file.newUri.fsPath).isDirectory();
        } catch (e) {
            continue;
        }
        if (!isDirectory && !['.lua', '.luau'].includes(path.extname(newRel))) continue;
        renames.push({
            // Module-path prefixes: a directory is its own prefix, a file collapses per
            // modulePathOf (extension stripped, init -> folder).
            oldPrefix: isDirectory ? oldRel : pathResolver.modulePathOf(oldRel),
            newPrefix: isDirectory ? newRel : pathResolver.modulePathOf(newRel),
            oldRel,
            newRel,
            isDirectory
        });
    }
    if (renames.length === 0) return;

    const config = getExtensionConfig();
    const texts = pathResolver.readSourceTexts(workspaceRoot, config);

    const inboundEdit = new vscode.WorkspaceEdit();
    const outboundEdit = new vscode.WorkspaceEdit();
    let inboundCount = 0;
    const inboundFiles = new Set();
    let outboundCount = 0;

    for (const [filePath, text] of texts) {
        const fileRel = toRel(workspaceRoot, filePath);
        const containingRename = renames.find(r =>
            r.isDirectory ? (fileRel === r.newRel || fileRel.startsWith(r.newRel + '/')) : fileRel === r.newRel
        );
        // A file inside a moved subtree wrote its relative requires against its OLD
        // location; resolve them from there.
        const resolveFromRel = containingRename
            ? containingRename.oldRel + fileRel.slice(containingRename.newRel.length)
            : fileRel;
        const uri = vscode.Uri.file(filePath);

        for (const found of pathResolver.findRequireStrings(text)) {
            const resolution = pathResolver.resolveModulePath(found.spec, resolveFromRel, ctx);
            if (resolution.status !== 'path') continue;

            let modulePath = resolution.modulePath;
            let touched = false;
            for (const rename of renames) {
                const remapped = remapModulePath(modulePath, rename.oldPrefix, rename.newPrefix);
                if (remapped !== null) {
                    modulePath = remapped;
                    touched = true;
                    break;
                }
            }
            // Outbound relative requires break by the move alone, even when the target
            // did not move — every resolvable spec in a moved file gets re-rendered.
            if (!touched && !containingRename) continue;

            const target = pathResolver.probeModulePath(modulePath, ctx);
            if (!target) continue;
            const newText = renderFor(target, fileRel, ctx);
            if (newText === found.spec) continue;

            const range = new vscode.Range(found.line, found.startColumn, found.line, found.endColumn);
            if (containingRename) {
                outboundEdit.replace(uri, range, newText);
                outboundCount++;
            } else {
                inboundEdit.replace(uri, range, newText);
                inboundCount++;
                inboundFiles.add(fileRel);
            }
        }
    }

    if (outboundCount > 0) {
        await vscode.workspace.applyEdit(outboundEdit);
        print(`explicit mode: fixed ${outboundCount} require(s) inside moved file(s)`);
    }

    if (inboundCount > 0) {
        const oldNames = renames.map(r => r.oldRel).join(', ');
        // Modal on purpose. Non-modal notifications auto-purge after ~15s no matter what
        // buttons they carry (only Error severity stays), and an unanswered prompt here
        // silently leaves every inbound require pointing at the old path. This fires once
        // per rename batch, and only when other files actually reference what moved.
        const choice = await vscode.window.showInformationMessage(
            `Update ${inboundCount} require(s) in ${inboundFiles.size} file(s) that point at ${oldNames}?`,
            {
                modal: true,
                detail: `RequireOnRails rewrites them to the new location.\n\n` +
                    `Choose No if you are replacing "${renames[0].oldRel}" with a different file of the same name ` +
                    `and want existing requires to keep resolving to that path.`
            },
            'Yes'
        );
        if (choice === 'Yes') {
            await vscode.workspace.applyEdit(inboundEdit);
            print(`explicit mode: updated ${inboundCount} inbound require(s)`);
        } else {
            print('explicit mode: inbound require update declined');
        }
    }
}

// ---------------------------------------------------------------------------
// Bulk rewrite: re-render every resolvable require to the current style. Serves both
// dynamic->explicit migration and later style changes.
// ---------------------------------------------------------------------------

async function rewriteAllRequires() {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        vscode.window.showWarningMessage('RequireOnRails: Please open a folder first.');
        return;
    }

    const ctx = pathResolver.refreshContext();
    if (!ctx) return;

    const config = getExtensionConfig();
    const workspaceEdit = new vscode.WorkspaceEdit();
    let count = 0;
    const filesTouched = new Set();
    let unresolvable = 0;

    for (const [filePath, text] of pathResolver.readSourceTexts(workspaceRoot, config)) {
        const fromRel = toRel(workspaceRoot, filePath);
        const uri = vscode.Uri.file(filePath);

        for (const found of pathResolver.findRequireStrings(text)) {
            // Bare short names go through the same eligibility rules as auto-replace;
            // everything else is resolved and re-rendered in the current style.
            let newText = computeReplacement(found.spec, fromRel, ctx);
            if (newText === null) {
                const resolution = pathResolver.resolveRequire(found.spec, fromRel, ctx);
                if (resolution.status === 'unresolved') unresolvable++;
                if (resolution.status !== 'resolved') continue;
                const rendered = renderFor(resolution.target, fromRel, ctx);
                if (rendered === found.spec) continue;
                newText = rendered;
            }
            workspaceEdit.replace(uri, new vscode.Range(found.line, found.startColumn, found.line, found.endColumn), newText);
            count++;
            filesTouched.add(fromRel);
        }
    }

    if (count > 0) await vscode.workspace.applyEdit(workspaceEdit);

    const summary = count === 0
        ? 'RequireOnRails: all requires already match the current style.'
        : `RequireOnRails: rewrote ${count} require(s) in ${filesTouched.size} file(s).`;

    // Requires left behind need acting on, so this is announced as a warning with an
    // action button: VS Code auto-purges plain notifications after ~15s, but one with
    // buttons stays until the user answers it.
    if (unresolvable > 0) {
        const showProblems = 'Show Problems';
        vscode.window.showWarningMessage(
            `${summary} ${unresolvable} require(s) could not be resolved and were left untouched.`,
            showProblems,
            'Dismiss'
        ).then(choice => {
            if (choice === showProblems) vscode.commands.executeCommand('workbench.actions.view.problems');
        });
        return;
    }

    vscode.window.showInformationMessage(summary);
}

// ---------------------------------------------------------------------------

// Registers everything explicit mode adds to the editor. Returned disposables belong in
// eventListenerDisposables so disableEventListeners() tears explicit mode down with the rest.
function registerExplicitFeatures() {
    debug('explicit mode: registering completion, auto-replace, and save sweep');
    return [
        vscode.languages.registerCompletionItemProvider(LANGUAGES, completionProvider, '@', '"', "'"),
        vscode.workspace.onDidChangeTextDocument(noteEditedLines),
        vscode.window.onDidChangeTextEditorSelection(onSelectionChanged),
        vscode.workspace.onWillSaveTextDocument(onWillSave),
        { dispose: () => _editedLines.clear() }
    ];
}

module.exports = {
    registerExplicitFeatures,
    handleRenameEventExplicit,
    rewriteAllRequires,
    // Exported for tests
    computeReplacement,
    computeSweepEdits
};
