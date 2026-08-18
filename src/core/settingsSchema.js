// The canonical registry of every RequireOnRails setting: type, default, and scope.
// This module — not the extension manifest — is the source of truth for what an unset
// setting means (ADR 0004). The manifest's contributes block is hand-maintained for the
// marketplace UI and guarded by a drift test; the project file's JSON Schema is generated
// from here (scripts/generate-settings-schema.js).
//
// scope 'project': project configuration — may live in the Project settings file
//                  (requireonrails.json) and is read headless.
// scope 'editor':  a preference about the person, not the project — VS Code settings only,
//                  never read headless, never written to the project file.

/**
 * @typedef {object} SettingSpec
 * @property {'string'|'boolean'|'number'|'array'|'object'} type - array = string[], object = Record<string,string>
 * @property {any} default
 * @property {'project'|'editor'} scope
 * @property {string[]} [enum] - Allowed values, for string settings with a fixed vocabulary
 */

/** @type {Record<string, SettingSpec>} */
const SCHEMA = {
    'mode': { type: 'string', default: 'dynamic', scope: 'project', enum: ['dynamic', 'explicit'] },
    'explicitPathStyle': { type: 'string', default: 'alias', scope: 'project', enum: ['alias', 'relative', 'game'] },
    'preferRelativePaths': { type: 'boolean', default: false, scope: 'project' },
    'rojoProjectPath': { type: 'string', default: 'default.project.json', scope: 'project' },
    'sourcemapPath': { type: 'string', default: 'sourcemap.json', scope: 'project' },
    'startsImmediately': { type: 'boolean', default: false, scope: 'editor' },
    'tryToAddImportRequire': { type: 'boolean', default: true, scope: 'editor' },
    'enableAbsolutePathUpdates': { type: 'boolean', default: false, scope: 'project' },
    'enableFileNameCollisionResolution': { type: 'boolean', default: false, scope: 'project' },
    'enableBasenameUpdates': { type: 'boolean', default: true, scope: 'project' },
    'importOpacity': { type: 'number', default: 0.45, scope: 'editor' },
    'importModulePaths': {
        type: 'array',
        default: [
            'game.ReplicatedStorage.src.Import',
            'ReplicatedStorage.src.Import',
            'game:GetService("ReplicatedStorage").src.Import',
            'game:GetService("ReplicatedStorage"):FindFirstChild("Import", true)',
            'ReplicatedStorage:FindFirstChild("Import", true)'
        ],
        scope: 'project'
    },
    'contextualImportTemplate': {
        type: 'string',
        default: 'local Import = require({IMPORT_MODULE_PATH})\nrequire = Import(script)',
        scope: 'project'
    },
    'preferredImportPlacement': {
        type: 'string',
        default: 'TopOfFile',
        scope: 'project',
        enum: ['TopOfFile', 'BeforeFirstRequire', 'AfterDefiningRobloxServices']
    },
    'directoriesToScan': { type: 'array', default: ['src/Server', 'src/Client', 'src/Shared'], scope: 'project' },
    'ignoreDirectories': { type: 'array', default: ['^_.*'], scope: 'project' },
    'manualAliases': {
        type: 'object',
        default: { Server: 'src/Server', Client: 'src/Client', Shared: 'src/Shared' },
        scope: 'project'
    },
    'pathPriority': { type: 'array', default: [], scope: 'project' },
    'skipUpdateNotificationForVersion': { type: 'string', default: '', scope: 'editor' },
    'onAliasesRegenerated': { type: 'array', default: [], scope: 'project' },
    'buildConversion.enabled': { type: 'boolean', default: false, scope: 'project' },
    'buildConversion.outputDirectory': { type: 'string', default: 'dist', scope: 'project' },
    'buildConversion.outputRequireStyle': {
        type: 'string',
        default: 'string',
        scope: 'project',
        enum: ['string', 'find_first_child', 'wait_for_child', 'property']
    },
    'buildConversion.buildProjectFile': { type: 'string', default: 'build.project.json', scope: 'project' },
    'buildConversion.hooks.onBuildCompleted': { type: 'array', default: [], scope: 'project' },
    'buildConversion.hooks.onWatchConverted': { type: 'array', default: [], scope: 'project' }
};

// The $schema URL users get autocomplete from. Points at the committed generated artifact.
const PROJECT_SCHEMA_URL = 'https://raw.githubusercontent.com/Raild3x/require-on-rails/master/schemas/requireonrails.schema.json';

/** @param {string} key */
function isProjectKey(key) {
    return SCHEMA[key] !== undefined && SCHEMA[key].scope === 'project';
}

/**
 * The JSON Schema type/shape for one setting, shared by the generator below.
 * @param {SettingSpec} spec
 * @param {string} [description]
 * @returns {Record<string, any>}
 */
function jsonSchemaFor(spec, description) {
    /** @type {Record<string, any>} */
    const out = {};
    if (spec.type === 'array') {
        out.type = 'array';
        out.items = { type: 'string' };
    } else if (spec.type === 'object') {
        out.type = 'object';
        out.additionalProperties = { type: 'string' };
    } else {
        out.type = spec.type;
    }
    if (spec.enum) out.enum = spec.enum.slice();
    out.default = spec.default;
    if (description) out.description = description;
    return out;
}

/**
 * Generates the JSON Schema for requireonrails.json: project-scope keys only, nested the way
 * the file is written ({"buildConversion": {"enabled": ...}}), unknown keys rejected so a
 * $schema-aware editor squiggles typos the same way resolveSettings reports them.
 * @param {Record<string, string>} [descriptions] - dotted key -> hover text (from the manifest)
 * @returns {Record<string, any>}
 */
function buildProjectJsonSchema(descriptions = {}) {
    /** @type {Record<string, any>} */
    const root = {
        $schema: 'http://json-schema.org/draft-07/schema#',
        title: 'RequireOnRails project settings',
        description: 'Project-level settings for RequireOnRails (requireonrails.json). Keys set here win over .vscode/settings.json; unset keys fall back to it, then to the shipped defaults.',
        type: 'object',
        additionalProperties: false,
        properties: {
            $schema: { type: 'string' }
        }
    };

    for (const [key, spec] of Object.entries(SCHEMA)) {
        if (spec.scope !== 'project') continue;
        const segments = key.split('.');
        let node = root;
        for (const segment of segments.slice(0, -1)) {
            if (!node.properties[segment]) {
                node.properties[segment] = { type: 'object', additionalProperties: false, properties: {} };
            }
            node = node.properties[segment];
        }
        node.properties[segments[segments.length - 1]] = jsonSchemaFor(spec, descriptions[key]);
    }

    return root;
}

module.exports = { SCHEMA, PROJECT_SCHEMA_URL, isProjectKey, buildProjectJsonSchema };
