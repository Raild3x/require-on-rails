#!/usr/bin/env node
// Regenerates schemas/requireonrails.schema.json from the tool's schema module, taking the
// hover descriptions from the extension manifest so a hand-edited settings file and the
// Settings UI say the same thing. Run after changing src/core/settingsSchema.js:
//
//   node scripts/generate-settings-schema.js
//
// test/cli/settings.test.js fails when the committed artifact is stale.

const fs = require('fs');
const path = require('path');
const { buildProjectJsonSchema } = require('../src/core/settingsSchema');

const REPO_ROOT = path.join(__dirname, '..');
const OUTPUT_PATH = path.join(REPO_ROOT, 'schemas', 'requireonrails.schema.json');

/** @returns {Record<string, string>} Dotted key -> description */
function manifestDescriptions() {
    const manifest = require('../package.json');
    const properties = manifest.contributes.configuration.properties;
    /** @type {Record<string, string>} */
    const out = {};
    for (const [key, property] of Object.entries(properties)) {
        const bare = key.replace(/^require-on-rails\./, '');
        const description = /** @type {{description?: string}} */ (property).description;
        if (description) out[bare] = description;
    }
    return out;
}

function render() {
    return `${JSON.stringify(buildProjectJsonSchema(manifestDescriptions()), null, 4)}\n`;
}

if (require.main === module) {
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, render());
    console.log(`Wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)}`);
}

module.exports = { render, OUTPUT_PATH };
