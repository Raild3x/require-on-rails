/**
 * Shared constants for the RequireOnRails extension
 */

// Package information
const PACKAGE_AUTHOR = 'raild3x';
const PACKAGE_NAME = 'requireonrails';
const MODULE_ACCESS_NAME = 'RequireOnRails';

// Extension information
const EXTENSION_ID = 'Raild3x.require-on-rails';

// File paths
const EXTENSION_WALLY_TOML_PATH = 'wally_package/wally.toml';

// Regular expressions
const VERSION_REGEX = /^\s*version\s*=\s*["'](.+?)["']/m;

// Default values
const FALLBACK_VERSION = '^0.1';

module.exports = {
    PACKAGE_AUTHOR,
    PACKAGE_NAME,
    MODULE_ACCESS_NAME,
    EXTENSION_ID,
    EXTENSION_WALLY_TOML_PATH,
    VERSION_REGEX,
    FALLBACK_VERSION
};
