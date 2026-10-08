// Headless tests for Plans: the require planners decide edits without an editor, and
// core/plan applies them. The editor applies the same edits as a WorkspaceEdit.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyEdits, writeEdits } = require('../../src/core/plan');
const {
    planRewriteAll,
    planRename,
    planCollisionRename,
    planAbsoluteAliasPaths,
    planSpecRewrite
} = require('../../src/features/requirePlanner');
const pathResolver = require('../../src/features/pathResolver');
const {
    planAddImport,
    textNeedsImport,
    importLinesToDim,
    createContextualImportSnippetFromTemplate
} = require('../../src/features/addImportToFiles');

/** @type {import('../../src/features/requirePlanner').RenderOptions} */
const RELATIVE = { style: 'relative', preferRelative: false };

/**
 * @param {Object<string, string>} files - Relative path -> content
 * @returns {string} Fixture root
 */
function makeFixture(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ror-plan-'));
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), content, 'utf8');
    }
    return root;
}

/** @param {string} root */
function indexOf(root) {
    const ctx = pathResolver.createContext(root, { directoriesToScan: ['src'] });
    return { ctx, texts: pathResolver.readSourceTexts(ctx) };
}

suite('Plan: applying edits', () => {
    const edit = (/** @type {number} */ line, /** @type {number} */ startColumn, /** @type {number} */ endColumn, /** @type {string} */ newText) =>
        ({ line, startColumn, endColumn, newText });

    test('Applies several edits on one line regardless of the order given', () => {
        assert.strictEqual(applyEdits('aa bb cc\n', [edit(0, 6, 8, 'CCC'), edit(0, 0, 2, 'A')]), 'A bb CCC\n');
    });

    test('Edits starting at the same point apply in the order given', () => {
        assert.strictEqual(applyEdits('abc', [edit(0, 1, 1, 'X'), edit(0, 1, 1, 'Y')]), 'aXYbc');
        assert.strictEqual(applyEdits('abcdef', [edit(0, 1, 1, 'X'), edit(0, 1, 3, 'Z')]), 'aXZdef');
    });

    test('An empty range inserts, and newText may span lines', () => {
        assert.strictEqual(applyEdits('one\r\ntwo', [edit(1, 0, 0, 'x\ny\n')]), 'one\r\nx\ny\ntwo');
    });

    test('A position outside the text is an error, not a silent corruption', () => {
        assert.throws(() => applyEdits('one', [edit(3, 0, 0, 'x')]));
        assert.throws(() => applyEdits('ab\ncd', [edit(0, 1, 5, 'Q')]));
        assert.throws(() => applyEdits('abc', [edit(0, -1, 0, 'Q')]));
        assert.throws(() => applyEdits('abc', [edit(0, 2, 1, 'Q')]));
    });
});

suite('Plan: rewrite all requires', () => {
    /** @type {string} */
    let root;
    suiteSetup(() => {
        root = makeFixture({
            '.luaurc': JSON.stringify({ aliases: { Shared: 'src/Shared' } }),
            'src/Shared/Util.luau': 'return {}\n',
            // CRLF, so the planner's columns are checked against what the applier writes.
            'src/Server/Main.luau': [
                'local U = require("@Util")',
                'local S = require("@Shared/Util")',
                'local M = require("@Shared/Missing")',
                'local G = require("@game/ReplicatedStorage/Thing")',
                ''
            ].join('\r\n')
        });
    });
    suiteTeardown(() => fs.rmSync(root, { recursive: true, force: true }));

    test('Re-renders resolvable requires and reports the rest without touching them', () => {
        const { ctx, texts } = indexOf(root);
        const plan = planRewriteAll(ctx, texts, RELATIVE);
        assert.deepStrictEqual(plan.edits.map(e => [e.file, e.line, e.newText]), [
            ['src/Server/Main.luau', 0, '../Shared/Util'],
            ['src/Server/Main.luau', 1, '../Shared/Util']
        ]);
        // @game with no Rojo mapping is unverifiable: neither rewritten nor reported.
        assert.deepStrictEqual(plan.findings, [{
            file: 'src/Server/Main.luau', line: 2, column: 19, endColumn: 34, code: 'unresolved-require',
            message: 'RequireOnRails: "@Shared/Missing" does not resolve — no module found at "src/Shared/Missing".'
        }]);
    });

    test('Writing the plan produces the rewritten file, and a second plan is empty', () => {
        const { ctx, texts } = indexOf(root);
        assert.deepStrictEqual(writeEdits(root, planRewriteAll(ctx, texts, RELATIVE).edits), ['src/Server/Main.luau']);
        assert.strictEqual(fs.readFileSync(path.join(root, 'src/Server/Main.luau'), 'utf8'), [
            'local U = require("../Shared/Util")',
            'local S = require("../Shared/Util")',
            'local M = require("@Shared/Missing")',
            'local G = require("@game/ReplicatedStorage/Thing")',
            ''
        ].join('\r\n'));
        const again = indexOf(root);
        assert.deepStrictEqual(planRewriteAll(again.ctx, again.texts, RELATIVE).edits, []);
    });
});

suite('Plan: adding the Import boilerplate', () => {
    const IMPORT = 'game:GetService("ReplicatedStorage").Import';
    const SNIPPET = createContextualImportSnippetFromTemplate(IMPORT, undefined);
    /** @param {string} content @param {string} placement */
    const added = (content, placement) => applyEdits(content, [planAddImport(content, IMPORT, placement, undefined)]);

    test('TopOfFile inserts ahead of everything', () => {
        assert.strictEqual(added('local x = 1\n', 'TopOfFile'), `${SNIPPET}\nlocal x = 1\n`);
    });

    test('BeforeFirstRequire inserts ahead of the first require line, or at the top without one', () => {
        assert.strictEqual(added('print(1)\r\nlocal A = require("@A")\r\n', 'BeforeFirstRequire'),
            `print(1)\r\n${SNIPPET}\nlocal A = require("@A")\r\n`);
        assert.strictEqual(added('print(1)\n', 'BeforeFirstRequire'), `${SNIPPET}\nprint(1)\n`);
    });

    test('AfterDefiningRobloxServices uses the blank line after the services', () => {
        assert.strictEqual(added('local RS = game:GetService("ReplicatedStorage")\n\nlocal A = require("@A")\n', 'AfterDefiningRobloxServices'),
            `local RS = game:GetService("ReplicatedStorage")\n${SNIPPET}\n\nlocal A = require("@A")\n`);
    });

    test('A service line ending the file without a newline gets the snippet on new lines', () => {
        assert.strictEqual(added('local RS = game:GetService("ReplicatedStorage")', 'AfterDefiningRobloxServices'),
            `local RS = game:GetService("ReplicatedStorage")\n${SNIPPET}`);
    });

    test('A file needs the import while it has @ requires and no boilerplate', () => {
        assert.strictEqual(textNeedsImport('local A = require("@A")\n', [IMPORT]), true);
        assert.strictEqual(textNeedsImport('local A = require(script.A)\n', [IMPORT]), false);
        assert.strictEqual(textNeedsImport(added('local A = require("@A")\n', 'TopOfFile'), [IMPORT]), false);
    });

    test('The boilerplate and its selene comment are the lines to dim', () => {
        const text = `-- selene: allow(incorrect_standard_library_use)\n${added('local A = require("@A")\n', 'TopOfFile')}`;
        assert.deepStrictEqual(importLinesToDim(text, [IMPORT]), [0, 1, 2]);
    });
});

suite('Plan: dynamic-mode renames', () => {
    test('A name already taken by another module gets a _Duplicate rename beside it', () => {
        const root = makeFixture({
            'src/Utilities/Util.luau': 'return {}\n',
            'src/Shared/Util/init.luau': 'return {}\n'
        });
        try {
            const { ctx } = indexOf(root);
            // The folder named like the file must not be rewritten: only the basename changes.
            assert.deepStrictEqual(planCollisionRename(ctx, 'src/Utilities/Util.luau', 'Util'),
                { newRel: 'src/Utilities/Util_Duplicate.luau', newBasename: 'Util_Duplicate' });
            assert.strictEqual(planCollisionRename(ctx, 'src/Utilities/Util.luau', 'Free'), null);
            // A renamed folder does not collide with its own init file.
            assert.strictEqual(planCollisionRename(ctx, 'src/Shared/Util', 'Util')?.newRel, 'src/Shared/Util_Duplicate');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test("A move maps between the '@' manualAliases it falls under", () => {
        const aliases = { '@Server': 'src/Server', '@Shared': 'src/Shared', Bare: 'src/Bare' };
        assert.deepStrictEqual(planAbsoluteAliasPaths('src/Server/Systems/Foo.luau', 'src/Shared/Foo.luau', aliases),
            { oldPath: '@Server/Systems/Foo', newPath: '@Shared/Foo' });
        assert.strictEqual(planAbsoluteAliasPaths('src/Bare/Foo.luau', 'src/Shared/Foo.luau', aliases), null, 'bare keys are not absolute aliases');
        assert.strictEqual(planAbsoluteAliasPaths('src/Shared/Foo.luau', 'src/Shared/Foo.luau', aliases), null);
    });

    test('Exact spec rewrites leave longer specs and comments alone', () => {
        const root = makeFixture({
            'src/Main.luau': 'local A = require("@Old")\nlocal B = require(\'@Old\')\nlocal C = require("@Old/Child")\n-- require("@Old")\n'
        });
        try {
            const { ctx, texts } = indexOf(root);
            writeEdits(root, planSpecRewrite(ctx, texts, '@Old', '@New'));
            assert.strictEqual(fs.readFileSync(path.join(root, 'src/Main.luau'), 'utf8'),
                'local A = require("@New")\nlocal B = require(\'@New\')\nlocal C = require("@Old/Child")\n-- require("@Old")\n');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

suite('Plan: renames', () => {
    /**
     * Applies the moves on disk, then plans against a context built after them, as the
     * editor's rename event does.
     * @param {Object<string, string>} files
     * @param {{oldRel: string, newRel: string}[]} moves
     */
    function planMoves(files, moves) {
        const root = makeFixture(files);
        try {
            for (const { oldRel, newRel } of moves) {
                fs.mkdirSync(path.dirname(path.join(root, newRel)), { recursive: true });
                fs.renameSync(path.join(root, oldRel), path.join(root, newRel));
            }
            const { ctx, texts } = indexOf(root);
            let reads = 0;
            const plan = planRename(ctx, () => { reads++; return texts; }, moves, RELATIVE);
            return { plan, reads };
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }

    test('Splits the requires a file move breaks into inbound and outbound', () => {
        const { plan } = planMoves({
            'src/Shared/Util.luau': 'local Sibling = require("./Sibling")\nreturn {}\n',
            'src/Shared/Sibling.luau': 'return {}\n',
            'src/Server/Main.luau': 'local U = require("../Shared/Util")\n'
        }, [{ oldRel: 'src/Shared/Util.luau', newRel: 'src/Shared/Lib/Util.luau' }]);
        assert.deepStrictEqual(plan.movedFrom, ['src/Shared/Util.luau']);
        assert.deepStrictEqual(plan.inbound.map(e => [e.file, e.newText]), [['src/Server/Main.luau', '../Shared/Lib/Util']]);
        assert.deepStrictEqual(plan.outbound.map(e => [e.file, e.newText]), [['src/Shared/Lib/Util.luau', '../Sibling']]);
    });

    test('A directory move remaps nested modules and fixes requires inside the subtree', () => {
        const { plan } = planMoves({
            // An init file resolves relative requires from its folder's parent.
            'src/Shared/Kit/init.luau': 'local Part = require("@self/Part")\nlocal Other = require("./Other")\nreturn {}\n',
            'src/Shared/Kit/Part.luau': 'return {}\n',
            'src/Shared/Other.luau': 'return {}\n',
            'src/Server/Main.luau': 'local Kit = require("../Shared/Kit")\nlocal Part = require("../Shared/Kit/Part")\n'
        }, [{ oldRel: 'src/Shared/Kit', newRel: 'src/Shared/Tools/Kit' }]);
        assert.deepStrictEqual(plan.inbound.map(e => [e.line, e.newText]), [
            [0, '../Shared/Tools/Kit'],
            [1, '../Shared/Tools/Kit/Part']
        ]);
        // Every resolvable require inside the moved subtree is re-rendered in the current style.
        assert.deepStrictEqual(plan.outbound.map(e => [e.file, e.line, e.newText]), [
            ['src/Shared/Tools/Kit/init.luau', 0, './Kit/Part'],
            ['src/Shared/Tools/Kit/init.luau', 1, '../Other']
        ]);
    });

    test('Moving a non-module file plans nothing and reads no source', () => {
        const { plan, reads } = planMoves({ 'src/a.txt': 'hi', 'src/Main.luau': 'return {}\n' },
            [{ oldRel: 'src/a.txt', newRel: 'src/b.txt' }]);
        assert.deepStrictEqual(plan, { outbound: [], inbound: [], movedFrom: [] });
        assert.strictEqual(reads, 0);
    });
});
