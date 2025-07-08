const { warn, error } = require('./logger');

/* EXAMPLE USAGE
const { parse, stringify } = require('./parseTOML');

// Parse TOML
const config = parse(`
title = "My App"
debug = true

[database]
host = "localhost"
port = 5432
`);

// Stringify to TOML
const tomlStr = stringify({
    title: "My App",
    debug: true,
    database: {
        host: "localhost",
        port: 5432
    }
});
*/

/**
 * Simple TOML parser that converts TOML strings to JavaScript objects
 * Supports basic TOML features: strings, numbers, booleans, arrays, tables
 */
class TOMLParser {
    constructor() {
        this.result = {};
        this.currentSection = this.result;
        this.currentPath = [];
    }

    /**
     * Parse a TOML string into a JavaScript object
     * @param {string} tomlString - The TOML content to parse
     * @returns {object} - Parsed JavaScript object
     */
    parse(tomlString) {
        this.result = {};
        this.currentSection = this.result;
        this.currentPath = [];

        const lines = tomlString.split('\n').map(line => line.trim());
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            // Skip empty lines and comments
            if (!line || line.startsWith('#')) {
                continue;
            }

            try {
                // Handle table headers [section]
                if (line.startsWith('[') && line.endsWith(']')) {
                    this.parseTableHeader(line);
                }
                // Handle key-value pairs
                else if (line.includes('=')) {
                    this.parseKeyValue(line);
                }
            } catch (err) {
                warn(`Error parsing TOML line ${i + 1}: "${line}" - ${err.message}`);
            }
        }

        return this.result;
    }

    /**
     * Parse table headers like [section] or [section.subsection]
     */
    parseTableHeader(line) {
        const header = line.slice(1, -1).trim();
        this.currentPath = header.split('.');
        
        // Navigate to or create the nested section
        this.currentSection = this.result;
        for (const part of this.currentPath) {
            if (!this.currentSection[part]) {
                this.currentSection[part] = {};
            }
            this.currentSection = this.currentSection[part];
        }
    }

    /**
     * Parse key-value pairs
     */
    parseKeyValue(line) {
        const equalIndex = line.indexOf('=');
        const key = line.slice(0, equalIndex).trim();
        const valueStr = line.slice(equalIndex + 1).trim();
        
        const value = this.parseValue(valueStr);
        this.currentSection[key] = value;
    }

    /**
     * Parse various TOML value types
     */
    parseValue(valueStr) {
        valueStr = valueStr.trim();

        // Boolean values
        if (valueStr === 'true') return true;
        if (valueStr === 'false') return false;

        // Numbers
        if (/^-?\d+$/.test(valueStr)) {
            return parseInt(valueStr, 10);
        }
        if (/^-?\d+\.\d+$/.test(valueStr)) {
            return parseFloat(valueStr);
        }

        // Arrays
        if (valueStr.startsWith('[') && valueStr.endsWith(']')) {
            return this.parseArray(valueStr);
        }

        // Strings (quoted or unquoted)
        if ((valueStr.startsWith('"') && valueStr.endsWith('"')) ||
            (valueStr.startsWith("'") && valueStr.endsWith("'"))) {
            return valueStr.slice(1, -1);
        }

        // Unquoted string (fallback)
        return valueStr;
    }

    /**
     * Parse array values
     */
    parseArray(arrayStr) {
        const content = arrayStr.slice(1, -1).trim();
        if (!content) return [];

        const items = [];
        let current = '';
        let inQuotes = false;
        let quoteChar = '';
        let depth = 0;

        for (let i = 0; i < content.length; i++) {
            const char = content[i];

            if (!inQuotes && (char === '"' || char === "'")) {
                inQuotes = true;
                quoteChar = char;
                current += char;
            } else if (inQuotes && char === quoteChar) {
                inQuotes = false;
                current += char;
            } else if (!inQuotes && char === '[') {
                depth++;
                current += char;
            } else if (!inQuotes && char === ']') {
                depth--;
                current += char;
            } else if (!inQuotes && char === ',' && depth === 0) {
                items.push(this.parseValue(current.trim()));
                current = '';
            } else {
                current += char;
            }
        }

        if (current.trim()) {
            items.push(this.parseValue(current.trim()));
        }

        return items;
    }
}

/**
 * Simple TOML stringifier that converts JavaScript objects to TOML strings
 */
class TOMLStringifier {
    constructor() {
        this.output = [];
    }

    /**
     * Convert a JavaScript object to TOML string
     * @param {object} obj - The object to convert
     * @returns {string} - TOML formatted string
     */
    stringify(obj) {
        this.output = [];
        this.stringifyObject(obj, []);
        return this.output.join('\n');
    }

    /**
     * Recursively stringify an object
     */
    stringifyObject(obj, path) {
        const simpleKeys = [];
        const tableKeys = [];

        // Separate simple values from nested objects
        for (const [key, value] of Object.entries(obj)) {
            if (this.isSimpleValue(value)) {
                simpleKeys.push(key);
            } else if (typeof value === 'object' && value !== null) {
                tableKeys.push(key);
            }
        }

        // Write simple key-value pairs first
        for (const key of simpleKeys) {
            const value = obj[key];
            this.output.push(`${key} = ${this.stringifyValue(value)}`);
        }

        // Add spacing if we have both simple values and tables
        if (simpleKeys.length > 0 && tableKeys.length > 0) {
            this.output.push('');
        }

        // Write nested tables
        for (const key of tableKeys) {
            const value = obj[key];
            const newPath = [...path, key];
            
            if (this.output.length > 0 && !this.output[this.output.length - 1].startsWith('[')) {
                this.output.push('');
            }
            
            this.output.push(`[${newPath.join('.')}]`);
            this.stringifyObject(value, newPath);
        }
    }

    /**
     * Check if a value is simple (not an object or array of objects)
     */
    isSimpleValue(value) {
        if (value === null || value === undefined) return true;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
        if (Array.isArray(value)) {
            return value.every(item => this.isSimpleValue(item));
        }
        return false;
    }

    /**
     * Convert a value to its TOML string representation
     */
    stringifyValue(value) {
        if (value === null || value === undefined) {
            return '""';
        }
        
        if (typeof value === 'string') {
            // Quote strings that contain special characters or start with numbers
            if (/[\s\[\]{}",=]/.test(value) || /^\d/.test(value) || value === 'true' || value === 'false') {
                return `"${value.replace(/"/g, '\\"')}"`;
            }
            return value;
        }
        
        if (typeof value === 'number' || typeof value === 'boolean') {
            return String(value);
        }
        
        if (Array.isArray(value)) {
            const items = value.map(item => this.stringifyValue(item));
            return `[${items.join(', ')}]`;
        }
        
        return '""';
    }
}

/**
 * Parse TOML string to JavaScript object
 * @param {string} tomlString - The TOML content to parse
 * @returns {object} - Parsed JavaScript object
 */
function parse(tomlString) {
    try {
        const parser = new TOMLParser();
        return parser.parse(tomlString);
    } catch (err) {
        error('Failed to parse TOML:', err.message);
        return {};
    }
}

/**
 * Convert JavaScript object to TOML string
 * @param {object} obj - The object to convert
 * @returns {string} - TOML formatted string
 */
function stringify(obj) {
    try {
        const stringifier = new TOMLStringifier();
        return stringifier.stringify(obj);
    } catch (err) {
        error('Failed to stringify to TOML:', err.message);
        return '';
    }
}

module.exports = {
    parse,
    stringify,
    TOMLParser,
    TOMLStringifier
};
