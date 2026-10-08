// Require rewrites as plans: what to change and what could not be, with no editor
// dependency. Explicit mode's (a Plan, or a RenamePlan split by consent) are applied by
// explicitMode as WorkspaceEdits; dynamic mode's exact-spec rewrites by dynamicRename with
// core/plan.writeEdits, which headless callers use too.

const fs = require('fs');
const path = require('path');
const pathResolver = require('./pathResolver');

/**
 * @typedef {import('./pathResolver').ResolverContext} ResolverContext
 * @typedef {import('../core/plan').Edit} Edit
 * @typedef {import('../core/plan').Plan} Plan
 */

/**
 * How a require string is written: the explicitPathStyle and preferRelativePaths settings.
 * @typedef {{style: 'alias'|'relative'|'game', preferRelative: boolean}} RenderOptions
 */

/**
 * @param {string} targetRel
 * @param {string} fromRel
 * @param {ResolverContext} ctx
 * @param {RenderOptions} render
 * @returns {string}
 */
function renderFor(targetRel, fromRel, ctx, render) {
    return pathResolver.renderRequire(targetRel, fromRel, render.style, render.preferRelative, ctx);
}

// The replacement for a bare "@name" short require, or null when the spec is not eligible:
// already an alias root (or reserved), has path segments, or matches no known module.
/**
 * @param {string} spec
 * @param {string} fromRel
 * @param {ResolverContext} ctx
 * @param {RenderOptions} render
 * @returns {string | null}
 */
function computeReplacement(spec, fromRel, ctx, render) {
    if (!spec.startsWith('@') || spec.includes('/')) return null;
    const name = spec.slice(1);
    if (!name || pathResolver.RESERVED_ALIASES.has(name)) return null;
    if (ctx.aliases[name] !== undefined) return null; // an existing alias wins over rewriting
    const candidates = ctx.targets[name];
    if (!candidates || candidates.length === 0) return null;
    const best = pathResolver.rankByDistance(candidates, fromRel, ctx.pathPriority)[0];
    const rendered = renderFor(best, fromRel, ctx, render);
    return rendered === spec ? null : rendered;
}

/**
 * @param {ResolverContext} ctx
 * @param {string} filePath - Absolute
 */
function toRel(ctx, filePath) {
    return path.relative(ctx.workspaceRoot, filePath).replace(/\\/g, '/');
}

/**
 * @param {string} file
 * @param {import('./pathResolver').RequireOccurrence} found
 * @param {string} newText
 * @returns {Edit}
 */
function requireEdit(file, found, newText) {
    return { file, line: found.line, startColumn: found.startColumn, endColumn: found.endColumn, newText };
}

/**
 * Re-renders every resolvable require to the current style. Serves both dynamic->explicit
 * migration and later style changes. Unresolvable requires are left alone and reported.
 * @param {ResolverContext} ctx
 * @param {Map<string, string>} texts - From pathResolver.readSourceTexts
 * @param {RenderOptions} render
 * @returns {Plan}
 */
function planRewriteAll(ctx, texts, render) {
    /** @type {Plan} */
    const plan = { edits: [], findings: [] };
    for (const [filePath, text] of texts) {
        const fromRel = toRel(ctx, filePath);
        // Reported in the Problems panel's words, since that is where the user is sent next.
        for (const unresolved of pathResolver.findUnresolvedRequires(text, fromRel, ctx)) {
            plan.findings.push({
                file: fromRel, line: unresolved.line, column: unresolved.startColumn, endColumn: unresolved.endColumn,
                code: 'unresolved-require', message: unresolved.message
            });
        }
        for (const found of pathResolver.findRequireStrings(text)) {
            // Bare short names go through the same eligibility rules as auto-replace;
            // everything else is resolved and re-rendered in the current style.
            let newText = computeReplacement(found.spec, fromRel, ctx, render);
            if (newText === null) {
                const resolution = pathResolver.resolveRequire(found.spec, fromRel, ctx);
                if (resolution.status !== 'resolved') continue;
                const rendered = renderFor(resolution.target, fromRel, ctx, render);
                if (rendered === found.spec) continue;
                newText = rendered;
            }
            plan.edits.push(requireEdit(fromRel, found, newText));
        }
    }
    return plan;
}

// Maps a module path under a renamed prefix to its new location, or null if unaffected.
/**
 * @param {string} modulePath
 * @param {string} oldPrefix
 * @param {string} newPrefix
 * @returns {string | null}
 */
function remapModulePath(modulePath, oldPrefix, newPrefix) {
    if (modulePath === oldPrefix) return newPrefix;
    if (modulePath.startsWith(oldPrefix + '/')) return newPrefix + modulePath.slice(oldPrefix.length);
    return null;
}

/**
 * The edits a batch of renames/moves calls for, split by whether applying them needs consent.
 * @typedef {object} RenamePlan
 * @property {Edit[]} outbound - Requires inside a moved item; the move alone broke them
 * @property {Edit[]} inbound - Requires elsewhere pointing at a moved item; confirmable, since
 *   moving a file away and dropping a same-named replacement in its place must be able to
 *   leave them untouched
 * @property {string[]} movedFrom - The moves that concerned modules (Luau files or
 *   directories), in order
 */

/**
 * Call after the moves happened on disk, with a context built after them.
 * @param {ResolverContext} ctx
 * @param {() => Map<string, string>} readTexts - Called only when a move concerns a module, so
 *   renaming an asset reads no source
 * @param {{oldRel: string, newRel: string}[]} moves - Root-relative paths
 * @param {RenderOptions} render
 * @returns {RenamePlan}
 */
function planRename(ctx, readTexts, moves, render) {
    const renames = [];
    for (const { oldRel, newRel } of moves) {
        let isDirectory = false;
        try {
            isDirectory = fs.statSync(path.resolve(ctx.workspaceRoot, newRel)).isDirectory();
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

    /** @type {Edit[]} */
    const outbound = [];
    /** @type {Edit[]} */
    const inbound = [];
    if (renames.length === 0) return { outbound, inbound, movedFrom: [] };

    for (const [filePath, text] of readTexts()) {
        const fileRel = toRel(ctx, filePath);
        const containingRename = renames.find(r =>
            r.isDirectory ? (fileRel === r.newRel || fileRel.startsWith(r.newRel + '/')) : fileRel === r.newRel
        );
        // A file inside a moved subtree wrote its relative requires against its OLD
        // location; resolve them from there.
        const resolveFromRel = containingRename
            ? containingRename.oldRel + fileRel.slice(containingRename.newRel.length)
            : fileRel;

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
            const newText = renderFor(target, fileRel, ctx, render);
            if (newText === found.spec) continue;

            (containingRename ? outbound : inbound).push(requireEdit(fileRel, found, newText));
        }
    }

    return { outbound, inbound, movedFrom: renames.map(r => r.oldRel) };
}

// ---------------------------------------------------------------------------
// Dynamic mode. Requires name aliases ("@Foo", "@Server/Systems/Foo"), so a rename is
// answered with exact spec rewrites, each behind its own setting and prompt.
// ---------------------------------------------------------------------------

/** @typedef {'renamed' | 'moved' | 'moved and renamed'} OperationType */

/**
 * Whether a rename/move changed the directory, the file name, or both.
 * @param {string} newFilePath
 * @param {string} oldFilePath
 * @returns {{operationType: OperationType, isMove: boolean, isRename: boolean, oldFileBasename: string, newFileBasename: string} | null}
 *   Basenames are without extension; null when nothing changed
 */
function analyzeFileOperation(newFilePath, oldFilePath) {
    const isMove = path.dirname(oldFilePath) !== path.dirname(newFilePath);
    const isRename = path.basename(oldFilePath) !== path.basename(newFilePath);

    /** @type {OperationType} */
    let operationType;
    if (isMove && isRename) operationType = 'moved and renamed';
    else if (isMove) operationType = 'moved';
    else if (isRename) operationType = 'renamed';
    else return null;

    return {
        operationType,
        isMove,
        isRename,
        oldFileBasename: path.basename(oldFilePath, path.extname(oldFilePath)),
        newFileBasename: path.basename(newFilePath, path.extname(newFilePath))
    };
}

/**
 * When a renamed module's new name is already another module's — which would make the
 * generated alias ambiguous — the "<name>_Duplicate" rename that keeps it unique.
 * @param {ResolverContext} ctx - Built after the rename
 * @param {string} newRel - Root-relative path of the renamed file or folder
 * @param {string} newBasename
 * @returns {{newRel: string, newBasename: string} | null} null when the name is free
 */
function planCollisionRename(ctx, newRel, newBasename) {
    const others = (ctx.targets[newBasename] || []).filter(target => target !== newRel && !target.startsWith(newRel + '/'));
    if (others.length === 0) return null;
    const renamedBasename = `${newBasename}_Duplicate`;
    const dir = path.posix.dirname(newRel);
    const renamed = `${renamedBasename}${path.posix.extname(newRel)}`;
    return { newRel: dir === '.' ? renamed : `${dir}/${renamed}`, newBasename: renamedBasename };
}

/**
 * The alias paths a move maps a module between, by the '@'-prefixed manualAliases entries:
 * "src/Server/Systems/Foo.luau" under {"@Server": "src/Server"} is "@Server/Systems/Foo".
 * @param {string} oldRel
 * @param {string} newRel
 * @param {Record<string, string>} manualAliases
 * @returns {{oldPath: string, newPath: string} | null} null unless both ends map and differ
 */
function planAbsoluteAliasPaths(oldRel, newRel, manualAliases) {
    /** @param {string} rel */
    const aliasPathOf = rel => {
        for (const [alias, aliasPath] of Object.entries(manualAliases)) {
            if (!alias.startsWith('@')) continue;
            const prefix = aliasPath.replace(/\\/g, '/');
            if (rel.startsWith(prefix)) return alias + rel.substring(prefix.length).replace(/\.(luau|lua)$/, '');
        }
        return null;
    };
    const oldPath = aliasPathOf(oldRel);
    const newPath = aliasPathOf(newRel);
    return oldPath && newPath && oldPath !== newPath ? { oldPath, newPath } : null;
}

/**
 * Rewrites every require whose string is exactly `fromSpec` to `toSpec`, keeping its quotes.
 * @param {ResolverContext} ctx
 * @param {Map<string, string>} texts - From pathResolver.readSourceTexts
 * @param {string} fromSpec - e.g. "@Foo" or "@Server/Systems/Foo"
 * @param {string} toSpec
 * @returns {Edit[]}
 */
function planSpecRewrite(ctx, texts, fromSpec, toSpec) {
    /** @type {Edit[]} */
    const edits = [];
    for (const [filePath, text] of texts) {
        for (const found of pathResolver.findRequireStrings(text)) {
            if (found.spec === fromSpec) edits.push(requireEdit(toRel(ctx, filePath), found, toSpec));
        }
    }
    return edits;
}

module.exports = {
    renderFor,
    computeReplacement,
    planRewriteAll,
    planRename,
    analyzeFileOperation,
    planCollisionRename,
    planAbsoluteAliasPaths,
    planSpecRewrite
};
