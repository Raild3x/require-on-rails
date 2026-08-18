const fs = require('fs');
const path = require('path');
const { print, debug, errMsg } = require('../core/logger');
const pathResolver = require('./pathResolver');
const { stripImportLines } = require('./addImportToFiles');

/**
 * Build conversion: produce a runtime-module-free copy of the scanned directories by
 * rewriting every require into a form Roblox resolves natively — relative / @game string
 * requires, or instance-expression chains (FindFirstChild / WaitForChild / property).
 *
 * Pure Node (no vscode dependency), so the CI checker runs the exact same conversion.
 *
 * @typedef {ReturnType<typeof pathResolver.createContext>} ResolverContext
 *
 * One problem found during conversion, 0-based like the CI checker's findings.
 * @typedef {object} BuildFinding
 * @property {string} file
 * @property {number} line
 * @property {number} column
 * @property {number} endColumn
 * @property {string} code
 * @property {string} message
 *
 * @typedef {'string'|'find_first_child'|'wait_for_child'|'property'} OutputRequireStyle
 *
 * @typedef {object} BuildOptions
 * @property {string[]} directoriesToScan
 * @property {string[]} [ignoreDirectories]
 * @property {string[]} [pathPriority]
 * @property {string} [rojoProjectPath]
 * @property {string} [sourcemapPath]
 * @property {string|string[]} [importModulePaths]
 * @property {string} outputDirectory
 * @property {OutputRequireStyle} [outputRequireStyle]
 * @property {boolean} [dryRun] - Convert and report findings without writing anything
 */

const LUA_EXTENSIONS = ['.lua', '.luau'];

// Containers whose contents are CLONED to a different location at runtime (StarterGui ->
// PlayerGui, StarterPlayerScripts -> PlayerScripts, ...). A path that stays inside one of
// these travels with the clone, so it must be requirer-relative; a path that crosses out
// must be game-rooted, because the script's runtime ancestors are not its edit-time ones.
const CLONED_CONTAINER_ROOTS = [
    'StarterPlayer/StarterPlayerScripts',
    'StarterPlayer/StarterCharacterScripts',
    'StarterGui',
    'StarterPack'
];

/**
 * @param {string | null} dmPath
 * @returns {string | null} The cloned-container root this DataModel path lives in, if any
 */
function clonedContainerOf(dmPath) {
    if (!dmPath) return null;
    for (const root of CLONED_CONTAINER_ROOTS) {
        if (dmPath === root || dmPath.startsWith(root + '/')) return root;
    }
    return null;
}

// Longest-fsPath-prefix lookup, the same matching renderGame uses: where does this module
// path land in the DataModel?
/**
 * @param {string} modulePath
 * @param {ResolverContext} ctx
 * @returns {string | null}
 */
function dmPathOf(modulePath, ctx) {
    if (!ctx.rojoMap) return null;
    /** @type {{fsPath: string, dmPath: string} | null} */
    let best = null;
    for (const entry of ctx.rojoMap) {
        if (modulePath === entry.fsPath || modulePath.startsWith(entry.fsPath + '/')) {
            if (!best || entry.fsPath.length > best.fsPath.length) best = entry;
        }
    }
    if (!best) return null;
    const remainder = modulePath.slice(best.fsPath.length).replace(/^\//, '');
    return remainder ? `${best.dmPath}/${remainder}` : best.dmPath;
}

// ---------------------------------------------------------------------------
// Instance-expression rendering
// ---------------------------------------------------------------------------

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** @param {string} name */
function quoteName(name) {
    return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * One indexing step onto `base` for the given style.
 * @param {string} base
 * @param {string} name
 * @param {OutputRequireStyle} style
 */
function indexStep(base, name, style) {
    if (style === 'find_first_child') return `${base}:FindFirstChild(${quoteName(name)})`;
    if (style === 'wait_for_child') return `${base}:WaitForChild(${quoteName(name)})`;
    return IDENTIFIER_RE.test(name) ? `${base}.${name}` : `${base}[${quoteName(name)}]`;
}

/**
 * game-rooted instance chain: game:GetService("Svc") then one indexing step per segment.
 * @param {string[]} dmSegments
 * @param {OutputRequireStyle} style
 */
function renderGameChain(dmSegments, style) {
    let expression = `game:GetService(${quoteName(dmSegments[0])})`;
    for (const segment of dmSegments.slice(1)) {
        expression = indexStep(expression, segment, style);
    }
    return expression;
}

/**
 * script-relative instance chain, used inside cloned containers where the runtime location
 * differs from the edit-time one: script.Parent^n then descend.
 * @param {string[]} fromDmSegments - DataModel path of the requiring script instance
 * @param {string[]} targetDmSegments
 * @param {OutputRequireStyle} style
 */
function renderScriptChain(fromDmSegments, targetDmSegments, style) {
    let common = 0;
    while (common < fromDmSegments.length && common < targetDmSegments.length
        && fromDmSegments[common] === targetDmSegments[common]) common++;
    let expression = 'script' + '.Parent'.repeat(fromDmSegments.length - common);
    for (const segment of targetDmSegments.slice(common)) {
        expression = indexStep(expression, segment, style);
    }
    return expression;
}

// ---------------------------------------------------------------------------
// Per-require conversion
// ---------------------------------------------------------------------------

/**
 * @param {string} file
 * @param {import('./pathResolver').RequireOccurrence} occurrence
 * @param {string} code
 * @param {string} message
 * @returns {BuildFinding}
 */
function makeFinding(file, occurrence, code, message) {
    return {
        file,
        line: occurrence.line,
        column: occurrence.startColumn,
        endColumn: occurrence.endColumn,
        code,
        message
    };
}

/**
 * The replacement for one require occurrence, or null to leave it untouched.
 * @param {import('./pathResolver').RequireOccurrence} occurrence
 * @param {string} fromRel
 * @param {ResolverContext} ctx
 * @param {OutputRequireStyle} style
 * @param {string} fileLabel - Path used in findings
 * @param {BuildFinding[]} findings
 * @returns {{kind: 'string', text: string} | {kind: 'expression', text: string} | null}
 */
function convertRequire(occurrence, fromRel, ctx, style, fileLabel, findings) {
    const spec = occurrence.spec;

    // Bare "@Name" shorthand (dynamic mode's staple). An alias in .luaurc resolves below;
    // otherwise a unique known module is accepted, and anything ambiguous or unknown is a
    // finding — a build must never guess.
    if (spec.startsWith('@') && !spec.includes('/')) {
        const name = spec.slice(1);
        if (!pathResolver.RESERVED_ALIASES.has(name) && ctx.aliases[name] === undefined) {
            const candidates = ctx.targets[name] || [];
            if (candidates.length === 1) {
                return renderTarget(candidates[0], occurrence, fromRel, ctx, style, fileLabel, findings);
            }
            findings.push(makeFinding(fileLabel, occurrence, candidates.length > 1 ? 'ambiguous-require' : 'unresolved-require',
                candidates.length > 1
                    ? `RequireOnRails build: "${spec}" is ambiguous — ${candidates.length} modules share that name (${candidates.join(', ')}).`
                    : `RequireOnRails build: "${spec}" matches no known module or alias.`));
            return null;
        }
    }

    const resolution = pathResolver.resolveRequire(spec, fromRel, ctx);

    if (resolution.status === 'unresolved') {
        findings.push(makeFinding(fileLabel, occurrence, 'unresolved-require',
            `RequireOnRails build: "${spec}" does not resolve — ${resolution.message}.`));
        return null;
    }

    if (resolution.status === 'unverifiable') {
        // @self from a non-init file: its children exist only in the DataModel. The string
        // form is already native; instance styles chain directly off `script`.
        if (spec.startsWith('@self/') && style !== 'string') {
            let expression = 'script';
            for (const segment of spec.slice('@self/'.length).split('/')) {
                if (segment === '' || segment === '.') continue;
                expression = indexStep(expression, segment, style);
            }
            return { kind: 'expression', text: expression };
        }
        // Everything else unverifiable (@game without a Rojo mapping, bare @self) passes
        // through: Roblox resolves these strings natively.
        if (spec.startsWith('@game/') && style !== 'string') {
            findings.push(makeFinding(fileLabel, occurrence, 'no-rojo-mapping',
                `RequireOnRails build: "${spec}" cannot be converted to an instance path — no Rojo sourcemap or project mapping covers it.`));
        }
        return null;
    }

    return renderTarget(resolution.target, occurrence, fromRel, ctx, style, fileLabel, findings);
}

/**
 * Renders a resolved target per the output style and container rules.
 * @param {string} targetRel
 * @param {import('./pathResolver').RequireOccurrence} occurrence
 * @param {string} fromRel
 * @param {ResolverContext} ctx
 * @param {OutputRequireStyle} style
 * @param {string} fileLabel
 * @param {BuildFinding[]} findings
 * @returns {{kind: 'string', text: string} | {kind: 'expression', text: string} | null}
 */
function renderTarget(targetRel, occurrence, fromRel, ctx, style, fileLabel, findings) {
    const targetModulePath = pathResolver.modulePathOf(targetRel);
    const fromModulePath = pathResolver.modulePathOf(fromRel);
    const targetDm = dmPathOf(targetModulePath, ctx);
    const fromDm = dmPathOf(fromModulePath, ctx);
    const fromContainer = clonedContainerOf(fromDm);
    const targetContainer = clonedContainerOf(targetDm);
    const sameClonedContainer = fromContainer !== null && targetContainer === fromContainer;

    if (style === 'string') {
        if (fromContainer && !sameClonedContainer) {
            // The requiring script runs from a clone, so a relative path out of the
            // container walks the wrong runtime tree — only a game-rooted path is stable.
            const gameForm = pathResolver.renderRequire(targetRel, fromRel, 'game', false, ctx);
            if (!gameForm.startsWith('@game/')) {
                findings.push(makeFinding(fileLabel, occurrence, 'no-rojo-mapping',
                    `RequireOnRails build: "${occurrence.spec}" crosses out of cloned container "${fromContainer}" ` +
                    `and must be game-rooted, but no Rojo sourcemap or project mapping covers the target.`));
                return null;
            }
            return gameForm === occurrence.spec ? null : { kind: 'string', text: gameForm };
        }
        const relativeForm = pathResolver.renderRequire(targetRel, fromRel, 'relative', false, ctx);
        return relativeForm === occurrence.spec ? null : { kind: 'string', text: relativeForm };
    }

    // Instance-expression styles need the DataModel location of the target.
    if (!targetDm) {
        findings.push(makeFinding(fileLabel, occurrence, 'no-rojo-mapping',
            `RequireOnRails build: "${occurrence.spec}" cannot be converted to an instance path — ` +
            `no Rojo sourcemap or project mapping covers "${targetModulePath}".`));
        return null;
    }
    if (sameClonedContainer && fromDm) {
        return { kind: 'expression', text: renderScriptChain(fromDm.split('/'), targetDm.split('/'), style) };
    }
    return { kind: 'expression', text: renderGameChain(targetDm.split('/'), style) };
}

/**
 * Converts one file's text: boilerplate stripped, every require rewritten.
 * @param {string} text
 * @param {string} fromRel
 * @param {ResolverContext} ctx
 * @param {OutputRequireStyle} style
 * @param {string|string[]} importModulePaths
 * @param {BuildFinding[]} findings
 * @returns {{text: string, converted: number}}
 */
function convertFileText(text, fromRel, ctx, style, importModulePaths, findings) {
    // Convert BEFORE stripping, so finding positions match the source file the user opens.
    // Replacements never change line counts, so positions stay valid throughout.
    const lines = text.split('\n');
    let converted = 0;

    // Right-to-left within each line keeps earlier columns valid across replacements.
    const occurrences = pathResolver.findRequireStrings(text)
        .sort((a, b) => b.line - a.line || b.startColumn - a.startColumn);

    for (const occurrence of occurrences) {
        const replacement = convertRequire(occurrence, fromRel, ctx, style, fromRel, findings);
        if (!replacement) continue;
        const line = lines[occurrence.line];
        // The occurrence span covers the spec inside its quotes; an expression replaces the
        // quotes as well.
        const start = replacement.kind === 'expression' ? occurrence.startColumn - 1 : occurrence.startColumn;
        const end = replacement.kind === 'expression' ? occurrence.endColumn + 1 : occurrence.endColumn;
        lines[occurrence.line] = line.slice(0, start) + replacement.text + line.slice(end);
        converted++;
    }

    const stripped = stripImportLines(lines.join('\n'), importModulePaths);
    return { text: stripped.text, converted };
}

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

/**
 * Converts (Lua) or reads (anything else) one file for the output tree. Returns the data to
 * write at the mirrored path, or null when the file could not be read (finding appended).
 * Shared by the full build and the incremental watch.
 * @param {string} workspaceRoot
 * @param {string} fileRel - Workspace-relative, forward-slashed
 * @param {ResolverContext} ctx
 * @param {{outputRequireStyle: OutputRequireStyle, importModulePaths: string|string[]}} options
 * @param {BuildFinding[]} findings
 * @returns {{data: string | Buffer, converted: number} | null}
 */
function convertOrCopyFile(workspaceRoot, fileRel, ctx, options, findings) {
    const absolutePath = path.join(workspaceRoot, fileRel);
    if (!LUA_EXTENSIONS.includes(path.extname(absolutePath))) {
        try {
            return { data: fs.readFileSync(absolutePath), converted: 0 };
        } catch (e) {
            findings.push({
                file: fileRel, line: 0, column: 0, endColumn: 0, code: 'read-error',
                message: `RequireOnRails build: could not read "${fileRel}" (${errMsg(e)}).`
            });
            return null;
        }
    }
    let text;
    try {
        text = fs.readFileSync(absolutePath, 'utf8');
    } catch (e) {
        findings.push({
            file: fileRel, line: 0, column: 0, endColumn: 0, code: 'read-error',
            message: `RequireOnRails build: could not read "${fileRel}" (${errMsg(e)}).`
        });
        return null;
    }
    const result = convertFileText(text, fileRel, ctx, options.outputRequireStyle, options.importModulePaths, findings);
    return { data: result.text, converted: result.converted };
}

/**
 * Walks one directory tree, calling back with every file (no ignore pruning: everything in
 * a scanned directory ships, whether or not it is aliased).
 * @param {string} dir
 * @param {(absolutePath: string) => void} callback
 */
function walkAllFiles(dir, callback) {
    /** @type {fs.Dirent[]} */
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        debug(`build: could not read "${dir}" (${errMsg(e)})`);
        return;
    }
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) walkAllFiles(fullPath, callback);
        else if (entry.isFile()) callback(fullPath);
    }
}

/**
 * Runs the conversion over every scanned directory. All output is buffered and written only
 * when there are zero findings, so a broken build never produces a partially-converted tree
 * (string requires left behind would break silently at runtime — the failure mode darklua's
 * exit-0 warnings have).
 *
 * @param {string} workspaceRoot
 * @param {BuildOptions} options
 * @returns {{findings: BuildFinding[], filesConverted: number, filesCopied: number, requiresConverted: number, written: boolean}}
 */
function runBuild(workspaceRoot, options) {
    const {
        directoriesToScan = [],
        importModulePaths = [],
        outputDirectory,
        outputRequireStyle = 'string',
        dryRun = false
    } = options;

    const ctx = pathResolver.createContext(workspaceRoot, {
        directoriesToScan,
        ignoreDirectories: options.ignoreDirectories || [],
        pathPriority: options.pathPriority || [],
        sourcemapPath: options.sourcemapPath || 'sourcemap.json',
        rojoProjectPath: options.rojoProjectPath || 'default.project.json'
    });

    /** @type {BuildFinding[]} */
    const findings = [];

    if (outputRequireStyle !== 'string' && !ctx.rojoMap) {
        findings.push({
            file: options.rojoProjectPath || 'default.project.json', line: 0, column: 0, endColumn: 0,
            code: 'no-rojo-mapping',
            message: `RequireOnRails build: outputRequireStyle "${outputRequireStyle}" emits instance paths, ` +
                `which need a Rojo sourcemap (sourcemapPath) or project file (rojoProjectPath) to map files to the DataModel.`
        });
        return { findings, filesConverted: 0, filesCopied: 0, requiresConverted: 0, written: false };
    }
    if (outputRequireStyle === 'string' && !ctx.rojoMap) {
        print('build: no Rojo sourcemap or project mapping found — cloned-container detection is off, all requires render relative.');
    }

    /** @type {{outPath: string, data: string | Buffer}[]} */
    const outputs = [];
    let filesConverted = 0;
    let filesCopied = 0;
    let requiresConverted = 0;

    for (const dirRel of directoriesToScan) {
        const dirAbs = path.join(workspaceRoot, dirRel);
        if (!fs.existsSync(dirAbs) || !fs.statSync(dirAbs).isDirectory()) {
            debug(`build: skipping "${dirRel}" — not an existing directory`);
            continue;
        }
        walkAllFiles(dirAbs, (absolutePath) => {
            const fileRel = path.relative(workspaceRoot, absolutePath).replace(/\\/g, '/');
            const outPath = path.join(workspaceRoot, outputDirectory, fileRel);
            const result = convertOrCopyFile(workspaceRoot, fileRel, ctx,
                { outputRequireStyle, importModulePaths }, findings);
            if (!result) return;
            outputs.push({ outPath, data: result.data });
            if (LUA_EXTENSIONS.includes(path.extname(absolutePath))) {
                filesConverted++;
                requiresConverted += result.converted;
            } else {
                filesCopied++;
            }
        });
    }

    if (findings.length > 0 || dryRun) {
        return { findings, filesConverted, filesCopied, requiresConverted, written: false };
    }

    // Replace each mirrored subtree wholesale so deleted source files do not linger in the
    // output; anything else the user keeps in the output directory is left alone.
    for (const dirRel of directoriesToScan) {
        fs.rmSync(path.join(workspaceRoot, outputDirectory, dirRel), { recursive: true, force: true });
    }
    for (const { outPath, data } of outputs) {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, data);
    }

    print(`build: converted ${filesConverted} file(s) (${requiresConverted} require(s)), copied ${filesCopied} asset(s) into ${outputDirectory}/.`);
    return { findings, filesConverted, filesCopied, requiresConverted, written: true };
}

module.exports = {
    runBuild,
    convertOrCopyFile,
    LUA_EXTENSIONS,
    // Exported for tests
    convertFileText,
    clonedContainerOf,
    dmPathOf,
    renderGameChain,
    renderScriptChain
};
