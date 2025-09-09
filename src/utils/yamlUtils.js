const { print, warn, error } = require('../core/logger');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// Conditionally require vscode (not available in Node.js testing)
let vscode;
try {
    vscode = require('vscode');
} catch (err) {
    // vscode not available in testing environment
    vscode = null;
}

/**
 * Simple YAML utility for parsing and modifying roblox.yml files
 * Specifically designed to handle the require function configuration
 */

/**
 * Execute a shell command and return a promise
 * @param {string} command - The command to execute
 * @param {string} cwd - Working directory for the command
 * @returns {Promise<{success: boolean, stdout: string, stderr: string}>}
 */
function executeCommand(command, cwd = process.cwd()) {
    return new Promise((resolve) => {
        exec(command, { cwd }, (error, stdout, stderr) => {
            if (error) {
                resolve({
                    success: false,
                    stdout: stdout || '',
                    stderr: stderr || error.message,
                    error: error
                });
            } else {
                resolve({
                    success: true,
                    stdout: stdout || '',
                    stderr: stderr || ''
                });
            }
        });
    });
}

/**
 * Sleep utility function
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Read and parse a YAML file (basic implementation for roblox.yml)
 * @param {string} filePath - Path to the YAML file
 * @returns {string|null} - File content as string, or null if file doesn't exist
 */
function readYamlFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            return null;
        }
        return fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        error(`Failed to read YAML file ${filePath}:`, err.message);
        return null;
    }
}

/**
 * Write content to a YAML file
 * @param {string} filePath - Path to the YAML file
 * @param {string} content - Content to write
 * @returns {boolean} - Success status
 */
function writeYamlFile(filePath, content) {
    try {
        fs.writeFileSync(filePath, content, 'utf8');
        return true;
    } catch (err) {
        error(`Failed to write YAML file ${filePath}:`, err.message);
        return false;
    }
}

/**
 * Check if roblox.yml has the correct require configuration with any: true
 * @param {string} content - YAML content as string
 * @returns {boolean} - True if require has any: true configured
 */
function hasCorrectRequireConfig(content) {
    if (!content) return false;
    
    // Look for require section with any: true
    const requireSection = content.match(/require:\s*\n([\s\S]*?)(?=\n\w|\n$|$)/);
    if (!requireSection) return false;
    
    const requireContent = requireSection[1];
    return /any:\s*true/i.test(requireContent);
}

/**
 * Modify roblox.yml content to ensure require has any: true
 * @param {string} content - Original YAML content
 * @returns {string} - Modified YAML content
 */
function ensureRequireAnyTrue(content) {
    if (!content) return content;
    
    // Check if require section exists
    const requireMatch = content.match(/(require:\s*\n)([\s\S]*?)(?=\n\w|\n$|$)/);
    if (!requireMatch) {
        // No require section found, can't modify
        warn('No require section found in roblox.yml');
        return content;
    }
    
    const beforeRequire = content.substring(0, requireMatch.index + requireMatch[1].length);
    const requireContent = requireMatch[2];
    const afterRequire = content.substring(requireMatch.index + requireMatch[0].length);
    
    // Check if any: true already exists
    if (/any:\s*true/i.test(requireContent)) {
        print('roblox.yml already has any: true configured for require');
        return content;
    }
    
    // Get the indentation level from the first line in require section
    const indentMatch = requireContent.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1] : '  ';
    
    // Add any: true at the beginning of the require section
    const modifiedRequireContent = `${indent}any: true\n${requireContent}`;
    
    const result = beforeRequire + modifiedRequireContent + afterRequire;
    
    print('Modified roblox.yml to include any: true for require function');
    return result;
}

/**
 * Process a roblox.yml file to ensure it has the correct require configuration
 * @param {string} filePath - Path to the roblox.yml file
 * @returns {boolean} - True if file was processed successfully (whether modified or not)
 */
function processRobloxYml(filePath) {
    print(`Processing roblox.yml file: ${filePath}`);
    
    const content = readYamlFile(filePath);
    if (!content) {
        warn(`Could not read roblox.yml file: ${filePath}`);
        return false;
    }
    
    if (hasCorrectRequireConfig(content)) {
        print('roblox.yml already has correct require configuration');
        return true;
    }
    
    const modifiedContent = ensureRequireAnyTrue(content);
    if (modifiedContent === content) {
        // No changes made
        return true;
    }
    
    const success = writeYamlFile(filePath, modifiedContent);
    if (success) {
        print('Successfully updated roblox.yml with any: true for require function');
    } else {
        error('Failed to write updated roblox.yml file');
    }
    
    return success;
}

/**
 * Generate selene configuration with roblox.yml
 * Based on the provided code example, generates and modifies roblox.yml
 * @param {string} workspaceRoot - Root directory of the workspace
 * @returns {Promise<boolean>} - True if generation was successful
 */
async function generateSeleneConfig(workspaceRoot) {
    const startTime = Date.now();
    print('Generating Selene configuration...');
    
    const robloxYmlPath = path.join(workspaceRoot, 'roblox.yml');
    
    try {
        // Remove existing roblox.yml to ensure clean generation
        if (fs.existsSync(robloxYmlPath)) {
            fs.unlinkSync(robloxYmlPath);
            print('Removed existing roblox.yml for clean generation');
        }
        
        // Generate initial roblox.yml
        print('Executing: selene generate-roblox-std');
        const seleneResult = await executeCommand('selene generate-roblox-std', workspaceRoot);
        if (!seleneResult.success) {
            error('❌ Selene config generation failed:');
            error(seleneResult.stderr || seleneResult.error);
            throw new Error('Selene config generation failed');
        }
        
        // Wait for file to be written and verify it exists
        let attempts = 0;
        const maxAttempts = 10;
        while (!fs.existsSync(robloxYmlPath) && attempts < maxAttempts) {
            await sleep(500);
            attempts++;
        }
        
        if (!fs.existsSync(robloxYmlPath)) {
            throw new Error('roblox.yml file was not created after selene generation');
        }
        
        print('roblox.yml file generated successfully');
        
        // Process the generated file to add any: true
        const success = processRobloxYml(robloxYmlPath);
        
        const duration = Date.now() - startTime;
        if (success) {
            print(`✓ Selene configuration generated and modified (${duration}ms)`);
        } else {
            warn(`⚠ Selene configuration generated but modification failed (${duration}ms)`);
        }
        
        return success;
    } catch (err) {
        const duration = Date.now() - startTime;
        error(`Failed to generate selene configuration (${duration}ms):`, err.message);
        return false;
    }
}

/**
 * Check if selene.toml exists but roblox.yml doesn't, and offer to generate it
 * @param {string} workspaceRoot - Root directory of the workspace
 * @returns {Promise<void>}
 */
async function checkAndOfferSeleneGeneration(workspaceRoot) {
    const seleneTomlPath = path.join(workspaceRoot, 'selene.toml');
    const robloxYmlPath = path.join(workspaceRoot, 'roblox.yml');
    
    // Check if selene.toml exists but roblox.yml doesn't
    if (fs.existsSync(seleneTomlPath) && !fs.existsSync(robloxYmlPath)) {
        print('Found selene.toml but no roblox.yml file');
        
        if (!vscode) {
            warn('vscode not available - cannot show dialog');
            return;
        }
        
        const choice = await vscode.window.showInformationMessage(
            'RequireOnRails detected a selene.toml file but no roblox.yml. Would you like to generate the roblox.yml file with selene?',
            'Generate',
            'Not Now'
        );
        
        if (choice === 'Generate') {
            print('User chose to generate roblox.yml with selene');
            const success = await generateSeleneConfig(workspaceRoot);
            
            if (success) {
                vscode.window.showInformationMessage('RequireOnRails: Successfully generated and configured roblox.yml!');
            } else {
                vscode.window.showErrorMessage('RequireOnRails: Failed to generate roblox.yml. Please check that selene is installed and accessible.');
            }
        } else {
            print('User chose not to generate roblox.yml');
        }
    }
}

module.exports = {
    readYamlFile,
    writeYamlFile,
    hasCorrectRequireConfig,
    ensureRequireAnyTrue,
    processRobloxYml,
    executeCommand,
    sleep,
    generateSeleneConfig,
    checkAndOfferSeleneGeneration
};
