#!/usr/bin/env node
//
// The requireonrails command: what the extension does to a project, for CI, other editors,
// and scripts. Each verb reads the same resolved settings the editor does (requireonrails.json
// > .vscode/settings.json > defaults) and refuses to run when they have errors. Output is text
// for people, or the full result as JSON with --json.
//
// Hook commands (onAliasesRegenerated, buildConversion.hooks.*) never run from here: they are
// gated on per-workspace approval in the editor, and a script can run its own next step.

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');

const settings = require('../core/settings');
const { writeEdits } = require('../core/plan');
const { classifyBasenames, readLuaurc, renderLuaurc } = require('../core/projectIndex');
const pathResolver = require('../features/pathResolver');
const { runBuild } = require('../features/buildProject');
const { planRewriteAll, planRename } = require('../features/requirePlanner');
const { renameDynamic } = require('../features/dynamicRename');
const { runChecks, summarize, ConfigError } = require('./check');

const USAGE = `Usage: requireonrails <command> [options]

Commands:
  check                    Report ambiguous aliases, requires that do not resolve, and .luaurc drift
  build                    Write the Build conversion output (needs buildConversion.enabled)
  generate-aliases         Regenerate .luaurc from the file tree (dynamic mode)
  rewrite                  Re-render every resolvable require in the current style (explicit mode)
  rename <from> <to>       Move a file or folder and fix the requires it breaks

Options:
  -C, --working-directory <dir>  Project root, and what rename paths are relative to (default: the current directory)
  --dry-run                      Report what would change without writing (build, generate-aliases, rewrite)
  --json                         Print the result as JSON
  --warn-only                    check: exit 0 even with findings
  --verify-build                 check: also dry-run the Build conversion
  --skip-inbound                 rename (explicit mode): leave requires elsewhere that point at the moved item
  -h, --help                     Show this help

Exit codes: 0 done, 1 findings or refused, 2 usage error or unusable path, 3 failed unexpectedly.`;

/**
 * What a verb produced: the exit code, the result for --json, and the lines for people.
 * @typedef {{code: 0 | 1 | 2, result: any, lines: string[]}} Outcome
 */

/** @typedef {import('../core/plan').Finding} Finding */

/**
 * @param {Finding} finding
 * @returns {string}
 */
function findingLine(finding) {
    return `${finding.file}:${finding.line + 1}:${finding.column + 1}  ${finding.message}`;
}

/**
 * @param {0 | 1 | 2} code
 * @param {string} message
 * @returns {Outcome}
 */
function failure(code, message) {
    return { code, result: { error: message }, lines: [`requireonrails: ${message}`] };
}

/**
 * The resolved settings, or the Outcome that stops the verb.
 * @param {string} root
 * @returns {{settings: Record<string, any>} | {stop: Outcome}}
 */
function loadSettings(root) {
    const resolved = settings.resolveSettings(root);
    if (!settings.hasErrorFindings(resolved.findings)) return { settings: resolved.settings };
    return {
        stop: {
            code: 1,
            result: { error: 'settings could not be resolved', findings: resolved.findings },
            lines: ['requireonrails: settings could not be resolved; nothing was done.', ...resolved.findings.map(f => findingLine(f))]
        }
    };
}

/**
 * @param {Object<string, string[]>} ambiguousAliases
 * @returns {string[]}
 */
function ambiguityLines(ambiguousAliases) {
    return Object.keys(ambiguousAliases).sort().map(name =>
        `requireonrails: alias "${name}" is ambiguous and was not generated: ${ambiguousAliases[name].join(', ')}`);
}

/**
 * The dynamic-mode .luaurc, regenerated from the file tree. Shared by generate-aliases and
 * rename, which has to leave the alias set matching the moved files.
 * @param {string} root
 * @param {Record<string, any>} s
 * @param {boolean} dryRun
 * @returns {{aliases: Object<string, string>, ambiguousAliases: Object<string, string[]>, changed: boolean, written: boolean}}
 */
function regenerateLuaurc(root, s, dryRun) {
    const ctx = pathResolver.createContext(root, settings.resolverOptions(s));
    if (ctx.luaurcError) throw new ConfigError(`could not parse .luaurc: ${ctx.luaurcError}`);
    const { aliases, ambiguousAliases } = classifyBasenames(ctx.basenameMap, {
        pathPriority: s['pathPriority'] || [],
        manualAliases: s['manualAliases'] || {}
    });
    const luaurcPath = path.join(root, '.luaurc');
    const content = renderLuaurc(readLuaurc(root) ?? {}, aliases);
    const changed = !fs.existsSync(luaurcPath) || fs.readFileSync(luaurcPath, 'utf8') !== content;
    if (changed && !dryRun) fs.writeFileSync(luaurcPath, content);
    return { aliases, ambiguousAliases, changed, written: changed && !dryRun };
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

/**
 * @param {string} root
 * @param {{warnOnly: boolean, verifyBuild: boolean}} options
 * @returns {Outcome}
 */
function check(root, { warnOnly, verifyBuild }) {
    const findings = runChecks(root, { verifyBuild });
    const lines = findings.map(findingLine);
    lines.push(findings.length === 0
        ? 'requireonrails: no issues found.'
        : `requireonrails: ${findings.length} finding(s) — ${summarize(findings)}.`);
    return { code: findings.length > 0 && !warnOnly ? 1 : 0, result: { findings }, lines };
}

/**
 * @param {string} root
 * @param {{dryRun: boolean}} options
 * @returns {Outcome}
 */
function build(root, { dryRun }) {
    const loaded = loadSettings(root);
    if ('stop' in loaded) return loaded.stop;
    if (!loaded.settings['buildConversion.enabled']) {
        return failure(1, 'Build conversion is off; set buildConversion.enabled in requireonrails.json.');
    }
    const result = runBuild(root, settings.buildOptions(loaded.settings, { dryRun }));
    const lines = result.findings.map(findingLine);
    if (result.findings.length > 0) {
        lines.push(`requireonrails: build stopped — ${result.findings.length} finding(s); nothing was written.`);
    } else {
        lines.push(`requireonrails: ${dryRun ? 'would convert' : 'converted'} ${result.filesConverted} file(s) ` +
            `(${result.requiresConverted} require(s)) and ${dryRun ? 'copy' : 'copied'} ${result.filesCopied} asset(s) ` +
            `into ${loaded.settings['buildConversion.outputDirectory']}/.`);
    }
    return { code: result.findings.length > 0 ? 1 : 0, result, lines };
}

/**
 * @param {string} root
 * @param {{dryRun: boolean}} options
 * @returns {Outcome}
 */
function generateAliases(root, { dryRun }) {
    const loaded = loadSettings(root);
    if ('stop' in loaded) return loaded.stop;
    if (loaded.settings['mode'] === 'explicit') {
        return failure(1, 'explicit mode never writes .luaurc; it is yours to maintain.');
    }
    const result = regenerateLuaurc(root, loaded.settings, dryRun);
    const lines = ambiguityLines(result.ambiguousAliases);
    const count = Object.keys(result.aliases).length;
    lines.push(!result.changed
        ? `requireonrails: .luaurc is up to date (${count} alias(es)).`
        : `requireonrails: ${dryRun ? 'would write' : 'wrote'} ${count} alias(es) to .luaurc.`);
    return { code: 0, result, lines };
}

/**
 * @param {string} root
 * @param {{dryRun: boolean}} options
 * @returns {Outcome}
 */
function rewrite(root, { dryRun }) {
    const loaded = loadSettings(root);
    if ('stop' in loaded) return loaded.stop;
    if (loaded.settings['mode'] !== 'explicit') {
        return failure(1, 'rewrite is an explicit-mode command; set mode to "explicit" first.');
    }
    const ctx = pathResolver.createContext(root, settings.resolverOptions(loaded.settings));
    const plan = planRewriteAll(ctx, pathResolver.readSourceTexts(ctx), settings.renderOptions(loaded.settings));
    const files = new Set(plan.edits.map(e => e.file)).size;
    if (!dryRun) writeEdits(root, plan.edits);
    const lines = plan.findings.map(findingLine);
    lines.push(plan.edits.length === 0
        ? 'requireonrails: all requires already match the current style.'
        : `requireonrails: ${dryRun ? 'would rewrite' : 'rewrote'} ${plan.edits.length} require(s) in ${files} file(s).`);
    if (plan.findings.length > 0) lines.push(`requireonrails: ${plan.findings.length} require(s) could not be resolved and were left untouched.`);
    return { code: 0, result: { ...plan, written: !dryRun && plan.edits.length > 0 }, lines };
}

/**
 * Moves the item, then fixes requires as the editor would after the same move: explicit mode
 * applies the rename plan (inbound edits unless skipped), dynamic mode runs the rename flow
 * with every enabled update accepted and regenerates .luaurc.
 * @param {string} root
 * @param {string} fromArg
 * @param {string} toArg
 * @param {{skipInbound: boolean}} options
 * @returns {Promise<Outcome>}
 */
async function rename(root, fromArg, toArg, { skipInbound }) {
    const loaded = loadSettings(root);
    if ('stop' in loaded) return loaded.stop;
    const s = loaded.settings;

    // Paths are relative to the project root, as if run from it (git -C style). On a
    // case-insensitive filesystem the typed casing may not be the real one, and module names
    // are case-sensitive, so both ends are taken from the filesystem where they exist.
    const canonicalRoot = fs.realpathSync.native(root);
    const fromTyped = path.resolve(root, fromArg);
    if (!fs.existsSync(fromTyped)) return failure(2, `"${fromArg}" does not exist.`);
    // Moving a link would move whatever it points at.
    if (fs.lstatSync(fromTyped).isSymbolicLink()) return failure(2, `"${fromArg}" is a link; move what it points at instead.`);
    const from = fs.realpathSync.native(fromTyped);
    const toTyped = path.resolve(root, toArg);
    // The part of the destination that exists already has a real casing; the rest is new.
    let toBase = path.dirname(toTyped);
    /** @type {string[]} */
    const toNew = [path.basename(toTyped)];
    while (!fs.existsSync(toBase) && path.dirname(toBase) !== toBase) {
        toNew.unshift(path.basename(toBase));
        toBase = path.dirname(toBase);
    }
    const to = path.join(fs.realpathSync.native(toBase), ...toNew);

    /** @param {string} p */
    const toRel = p => path.relative(canonicalRoot, p).replace(/\\/g, '/');
    const oldRel = toRel(from);
    const newRel = toRel(to);
    for (const rel of [oldRel, newRel]) {
        if (rel === '' || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
            return failure(2, `"${rel || '.'}" is not inside the project root ${canonicalRoot}.`);
        }
    }
    if (newRel.startsWith(oldRel + '/')) return failure(2, `cannot move "${oldRel}" into itself.`);
    // A case-only rename names the same file, so "exists" is expected there.
    if (fs.existsSync(to) && fs.realpathSync.native(to) !== from) return failure(2, `"${newRel}" already exists.`);
    if (s['mode'] !== 'explicit') {
        // Dynamic mode rewrites .luaurc after the move; a file it cannot parse would stop the
        // run halfway, so find out first.
        try {
            readLuaurc(root);
        } catch (e) {
            return failure(1, `could not parse .luaurc: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    /** @type {string[]} */
    const lines = [];

    if (s['mode'] === 'explicit') {
        const ctx = pathResolver.createContext(root, settings.resolverOptions(s));
        const plan = planRename(ctx, () => pathResolver.readSourceTexts(ctx), [{ oldRel, newRel }], settings.renderOptions(s));
        const edits = skipInbound ? plan.outbound : [...plan.outbound, ...plan.inbound];
        const filesWritten = writeEdits(root, edits);
        lines.push(`requireonrails: moved ${oldRel} -> ${newRel}.`);
        lines.push(`requireonrails: fixed ${plan.outbound.length} require(s) inside the moved item and ` +
            (skipInbound ? `left ${plan.inbound.length} pointing at it untouched.` : `${plan.inbound.length} pointing at it.`));
        return { code: 0, result: { mode: 'explicit', moved: { from: oldRel, to: newRel }, ...plan, filesWritten }, lines };
    }

    /** @type {string[]} */
    const messages = [];
    const { finalRel, filesWritten } = await renameDynamic(root, s, oldRel, newRel, {
        confirm: async () => true,
        info: message => messages.push(message),
        warn: message => messages.push(message)
    });
    lines.push(`requireonrails: moved ${oldRel} -> ${finalRel}.`, ...messages.map(m => `requireonrails: ${m}`));
    // The moved file's alias has a new name or path, as the editor's post-rename regeneration does.
    const luaurc = regenerateLuaurc(root, s, false);
    if (luaurc.written) lines.push('requireonrails: regenerated .luaurc.');
    lines.push(...ambiguityLines(luaurc.ambiguousAliases));
    return {
        code: 0,
        result: {
            mode: 'dynamic',
            moved: { from: oldRel, to: finalRel },
            filesWritten,
            messages,
            luaurcWritten: luaurc.written,
            ambiguousAliases: luaurc.ambiguousAliases
        },
        lines
    };
}

// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {Promise<{code: number, output: string}>}
 */
async function run(argv) {
    /** @type {ReturnType<typeof parseArgs>} */
    let parsed;
    try {
        parsed = parseArgs({
            args: argv,
            allowPositionals: true,
            options: {
                'working-directory': { type: 'string', short: 'C' },
                'dry-run': { type: 'boolean' },
                json: { type: 'boolean' },
                'warn-only': { type: 'boolean' },
                'verify-build': { type: 'boolean' },
                'skip-inbound': { type: 'boolean' },
                help: { type: 'boolean', short: 'h' }
            }
        });
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { code: 2, output: argv.includes('--json') ? JSON.stringify({ error: message }, null, 2) : `requireonrails: ${message}\n\n${USAGE}` };
    }
    const { values, positionals } = parsed;
    const [verb, ...rest] = positionals;
    if (values.help || !verb) return { code: values.help ? 0 : 2, output: USAGE };
    /** @param {string} message */
    const usageError = message => ({
        code: 2,
        output: values.json ? JSON.stringify({ error: message }, null, 2) : `requireonrails: ${message}\n\n${USAGE}`
    });

    const root = path.resolve(/** @type {string | undefined} */ (values['working-directory']) || '.');
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return usageError(`working directory "${root}" is not a directory.`);
    const dryRun = !!values['dry-run'];

    /** @type {Outcome} */
    let outcome;
    try {
        switch (verb) {
            case 'check':
                outcome = check(root, { warnOnly: !!values['warn-only'], verifyBuild: !!values['verify-build'] });
                break;
            case 'build':
                outcome = build(root, { dryRun });
                break;
            case 'generate-aliases':
                outcome = generateAliases(root, { dryRun });
                break;
            case 'rewrite':
                outcome = rewrite(root, { dryRun });
                break;
            case 'rename':
                if (rest.length !== 2) return usageError('rename takes <from> <to>.');
                if (dryRun) return usageError('rename has no --dry-run; it plans against the moved tree.');
                outcome = await rename(root, rest[0], rest[1], { skipInbound: !!values['skip-inbound'] });
                break;
            default:
                return usageError(`unknown command "${verb}".`);
        }
    } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        outcome = failure(1, e.message);
    }

    return {
        code: outcome.code,
        output: values.json ? JSON.stringify(outcome.result, null, 2) : outcome.lines.join('\n')
    };
}

if (require.main === module) {
    // The shared modules log progress with console.log; stdout carries only the result, so
    // that --json output stays parseable.
    console.log = console.error;
    run(process.argv.slice(2)).then(({ code, output }) => {
        process.stdout.write(output + '\n');
        process.exitCode = code;
    }, e => {
        console.error(`requireonrails: failed unexpectedly: ${e instanceof Error ? e.stack || e.message : String(e)}`);
        process.exitCode = 3;
    });
}

module.exports = { run };
