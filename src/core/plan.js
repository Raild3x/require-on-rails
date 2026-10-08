// A Plan is what an operation decided, kept apart from how it is applied: the editor turns
// one into a WorkspaceEdit (after any prompt), headless callers write it to disk or print it.

const fs = require('fs');
const path = require('path');

/**
 * One text replacement. Positions are 0-based. The replaced range lies on one line (an
 * insertion is an empty range); newText may span lines.
 * @typedef {object} Edit
 * @property {string} file - Workspace-root-relative, forward-slashed
 * @property {number} line
 * @property {number} startColumn
 * @property {number} endColumn
 * @property {string} newText
 */

/**
 * A problem the operation found and left alone, positioned like an Edit.
 * @typedef {object} Finding
 * @property {string} file
 * @property {number} line
 * @property {number} column
 * @property {number} endColumn
 * @property {string} code
 * @property {string} message
 */

/**
 * @typedef {object} Plan
 * @property {Edit[]} edits
 * @property {Finding[]} findings
 */

/**
 * Applies edits to one file's text. Edits must not overlap. At a shared start, as in a
 * WorkspaceEdit, an insertion lands before a replacement and equal ranges keep the given
 * order. A position outside the text throws rather than corrupting it, since a plan may be
 * applied after the file changed.
 * @param {string} text
 * @param {Omit<Edit, 'file'>[]} edits - Edits for this text only
 * @returns {string}
 */
function applyEdits(text, edits) {
    /** @type {number[]} */
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') lineStarts.push(i + 1);
    }
    /** @param {number} line @param {number} column */
    const offset = (line, column) => {
        if (line < 0 || line >= lineStarts.length) throw new Error(`edit line ${line} is outside the text`);
        const lineEnd = line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : text.length;
        if (column < 0 || column > lineEnd - lineStarts[line]) throw new Error(`edit column ${column} is outside line ${line}`);
        return lineStarts[line] + column;
    };
    // Back to front, so the offsets of edits not yet applied stay valid. At a shared start,
    // the wider edit and then the later one go first, which leaves them in the given order.
    const sorted = edits
        .map((edit, index) => ({ edit, index, start: offset(edit.line, edit.startColumn), end: offset(edit.line, edit.endColumn) }))
        .sort((a, b) => (b.start - a.start) || (b.end - a.end) || (b.index - a.index));
    for (const { start, end, edit } of sorted) {
        if (start > end) throw new Error(`edit range on line ${edit.line} ends before it starts`);
    }
    let out = text;
    for (const { edit, start, end } of sorted) {
        out = out.slice(0, start) + edit.newText + out.slice(end);
    }
    return out;
}

/**
 * Applies edits to the files on disk.
 * @param {string} workspaceRoot
 * @param {Edit[]} edits
 * @returns {string[]} Root-relative files written
 */
function writeEdits(workspaceRoot, edits) {
    /** @type {Map<string, Edit[]>} */
    const byFile = new Map();
    for (const edit of edits) {
        const fileEdits = byFile.get(edit.file);
        if (fileEdits) fileEdits.push(edit);
        else byFile.set(edit.file, [edit]);
    }
    for (const [file, fileEdits] of byFile) {
        const absolute = path.join(workspaceRoot, file);
        fs.writeFileSync(absolute, applyEdits(fs.readFileSync(absolute, 'utf8'), fileEdits), 'utf8');
    }
    return [...byFile.keys()];
}

module.exports = { applyEdits, writeEdits };
