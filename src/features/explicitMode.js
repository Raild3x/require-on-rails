const path = require('path');
const vscode = require('vscode');
const { print, debug } = require('../core/logger');
const pathResolver = require('./pathResolver');
const { getSettings, getContext, refreshContext, openDocumentTexts, toWorkspaceEdit } = require('../utils/workspaceUtils');
const { renderOptions } = require('../core/settings');
const planner = require('./requirePlanner');
const { planRename, planRewriteAll } = planner;

const LANGUAGES = ['luau', 'lua'];

/**
 * Resolution context from pathResolver. Taken from createContext's return type so this stays
 * in step with pathResolver rather than duplicating its shape.
 * @typedef {ReturnType<typeof pathResolver.createContext>} ResolverContext
 */

/** @param {import('vscode').TextDocument} document */
function isLuaDoc(document) {
    return LANGUAGES.includes(document.languageId) && document.uri.scheme === 'file';
}

function getWorkspaceRoot() {
    return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
        ? vscode.workspace.workspaceFolders[0].uri.fsPath
        : null;
}

/**
 * @param {string} workspaceRoot
 * @param {string} fsPath
 * @returns {string}
 */
function toRel(workspaceRoot, fsPath) {
    return path.relative(workspaceRoot, fsPath).replace(/\\/g, '/');
}

/** @returns {ResolverContext | null} */
function getCtx() {
    return getContext();
}

function currentRender() {
    return renderOptions(getSettings());
}

/**
 * @param {string} targetRel
 * @param {string} fromRel
 * @param {ResolverContext} ctx
 * @returns {string}
 */
function renderFor(targetRel, fromRel, ctx) {
    return planner.renderFor(targetRel, fromRel, ctx, currentRender());
}

/**
 * The planner's short-name rewrite, rendered in the current settings' style.
 * @param {string} spec
 * @param {string} fromRel
 * @param {ResolverContext} ctx
 * @returns {string | null}
 */
function computeReplacement(spec, fromRel, ctx) {
    return planner.computeReplacement(spec, fromRel, ctx, currentRender());
}

// ---------------------------------------------------------------------------
// Completion: bare module names -> full rendered path. Directory-segment browsing
// (@Shared/Sub/...) is left to luau-lsp, so anything containing '/' is ignored.
// ---------------------------------------------------------------------------

const REQUIRE_TYPING_RE = /require\s*\(\s*(['"])([^'"]*)$/;

/** @type {import('vscode').CompletionItemProvider} */
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

        /** @type {{basename: string, target: string}[]} */
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
/** @type {Map<string, Set<number>>} */
const _editedLines = new Map();
// editor -> Position[] of the previous selection, to detect "cursor left the string".
/** @type {WeakMap<import('vscode').TextEditor, import('vscode').Position[]>} */
const _prevSelections = new WeakMap();

/** @param {import('vscode').TextDocumentChangeEvent} event */
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

/**
 * @param {import('vscode').TextDocument} document
 * @param {number} line
 * @returns {{spec: string, range: import('vscode').Range}[]}
 */
function requireMatchesOnLine(document, line) {
    if (line >= document.lineCount) return [];
    const text = document.lineAt(line).text;
    /** @type {{spec: string, range: import('vscode').Range}[]} */
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

/**
 * @param {import('vscode').TextDocument} document
 * @param {import('vscode').Range} range
 */
function selectionsIntersect(document, range) {
    for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document !== document) continue;
        for (const selection of editor.selections) {
            if (range.intersection(selection) !== undefined || range.contains(selection.active)) return true;
        }
    }
    return false;
}

/** @param {import('vscode').TextEditorSelectionChangeEvent} event */
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

/**
 * @param {import('vscode').TextDocument} document
 * @returns {import('vscode').TextEdit[]}
 */
function computeSweepEdits(document) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return [];
    const ctx = getCtx();
    if (!ctx) return [];

    const fromRel = toRel(workspaceRoot, document.uri.fsPath);
    /** @type {import('vscode').TextEdit[]} */
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

/** @param {import('vscode').TextDocumentWillSaveEvent} event */
function onWillSave(event) {
    if (!isLuaDoc(event.document)) return;
    event.waitUntil(Promise.resolve(computeSweepEdits(event.document)));
    _editedLines.delete(event.document.uri.toString());
}

// ---------------------------------------------------------------------------
// Renames/moves: the planner splits the broken requires; outbound ones (inside the moved
// item) are fixed automatically, inbound ones (elsewhere, pointing at it) are PROMPTED.
// ---------------------------------------------------------------------------

/** @param {import('vscode').FileRenameEvent['files']} files */
async function handleRenameEventExplicit(files) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    // Renames already happened on disk, so a fresh context sees the new world; where a
    // require *used* to point is recovered by the planner without existence probing.
    const ctx = refreshContext();
    if (!ctx) return;

    const moves = files.map(file => ({
        oldRel: toRel(workspaceRoot, file.oldUri.fsPath),
        newRel: toRel(workspaceRoot, file.newUri.fsPath)
    }));
    const plan = planRename(ctx, () => pathResolver.readSourceTexts(ctx, openDocumentTexts()), moves, currentRender());

    if (plan.outbound.length > 0) {
        await vscode.workspace.applyEdit(toWorkspaceEdit(workspaceRoot, plan.outbound));
        print(`explicit mode: fixed ${plan.outbound.length} require(s) inside moved file(s)`);
    }

    if (plan.inbound.length > 0) {
        const inboundFiles = new Set(plan.inbound.map(e => e.file));
        // Modal on purpose. Non-modal notifications auto-purge after ~15s no matter what
        // buttons they carry (only Error severity stays), and an unanswered prompt here
        // silently leaves every inbound require pointing at the old path. This fires once
        // per rename batch, and only when other files actually reference what moved.
        const choice = await vscode.window.showInformationMessage(
            `Update ${plan.inbound.length} require(s) in ${inboundFiles.size} file(s) that point at ${plan.movedFrom.join(', ')}?`,
            {
                modal: true,
                detail: `RequireOnRails rewrites them to the new location.\n\n` +
                    `Choose No if you are replacing "${plan.movedFrom[0]}" with a different file of the same name ` +
                    `and want existing requires to keep resolving to that path.`
            },
            'Yes'
        );
        if (choice === 'Yes') {
            await vscode.workspace.applyEdit(toWorkspaceEdit(workspaceRoot, plan.inbound));
            print(`explicit mode: updated ${plan.inbound.length} inbound require(s)`);
        } else {
            print('explicit mode: inbound require update declined');
        }
    }
}

// ---------------------------------------------------------------------------
// Bulk rewrite: re-render every resolvable require to the current style.
// ---------------------------------------------------------------------------

async function rewriteAllRequires() {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        vscode.window.showWarningMessage('RequireOnRails: Please open a folder first.');
        return;
    }

    const ctx = refreshContext();
    if (!ctx) return;

    const plan = planRewriteAll(ctx, pathResolver.readSourceTexts(ctx, openDocumentTexts()), currentRender());
    if (plan.edits.length > 0) await vscode.workspace.applyEdit(toWorkspaceEdit(workspaceRoot, plan.edits));

    const summary = plan.edits.length === 0
        ? 'RequireOnRails: all requires already match the current style.'
        : `RequireOnRails: rewrote ${plan.edits.length} require(s) in ${new Set(plan.edits.map(e => e.file)).size} file(s).`;

    // Requires left behind need acting on, so this is announced as a warning with an
    // action button: VS Code auto-purges plain notifications after ~15s, but one with
    // buttons stays until the user answers it.
    if (plan.findings.length > 0) {
        const showProblems = 'Show Problems';
        vscode.window.showWarningMessage(
            `${summary} ${plan.findings.length} require(s) could not be resolved and were left untouched.`,
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
