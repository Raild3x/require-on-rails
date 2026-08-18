/**
 * RequireOnRails Publishing Script
 * 
 * Main entry point for publishing RequireOnRails packages to different platforms.
 * Provides an interactive menu to choose between VSCode Marketplace and Wally publishing.
 * 
 * @author Logan
 * @version 1.0.0
 */

const readline = require('readline');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { publishWally } = require('./wallyPublish');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const packageJsonPath = path.join(__dirname, '..', 'package.json');

/**
 * Prompts the user with a question and returns their response
 * @param {string} question - The question to ask the user
 * @returns {Promise<string>} The user's response
 */
function askQuestion(question) {
    return new Promise((resolve) => {
        rl.question(question, resolve);
    });
}

/**
 * Executes a command with the given arguments and options
 * @param {string} command - The command to run
 * @param {string[]} args - Array of command arguments
 * @param {object} options - Spawn options (optional)
 * @returns {Promise<void>} Resolves when command completes successfully
 * @throws {Error} Throws if command fails with non-zero exit code
 */
function runCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { 
            stdio: 'inherit',
            shell: true,
            ...options
        });
        
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Command failed with exit code ${code}`));
            }
        });
    });
}

/**
 * Gets the current package version from package.json
 * @returns {string} The package version
 */
function getPackageVersion() {
    const content = fs.readFileSync(packageJsonPath, 'utf8');
    const packageData = JSON.parse(content);
    return packageData.version;
}

/**
 * Tags the released commit so the GitHub Action can be referenced.
 *
 * `uses: Raild3x/require-on-rails@<ref>` resolves against this repository's git refs — pushing
 * these tags IS how the action is published, there is no separate registry. Two tags per
 * release: the exact version for anyone pinning, and a floating major that is moved forward
 * each time so `@v2` users pick up fixes.
 *
 * Wally module releases are bookmarked as `wally-vX.Y.Z` instead, so that the bare `vX.Y.Z`
 * namespace belongs to the extension alone (the two products version independently).
 *
 * @param {string} version - The version just published, e.g. "2.3.0"
 */
function tagRelease(version) {
    const major = `v${version.split('.')[0]}`;
    const options = { stdio: 'inherit', cwd: path.join(__dirname, '..') };

    console.log(`\nTagging v${version} and moving ${major}...`);
    execSync(`git tag v${version}`, options);
    execSync(`git tag -f ${major}`, options);
    execSync(`git push origin v${version}`, options);
    execSync(`git push -f origin ${major}`, options);

    console.log(`✓ Tagged v${version} and moved ${major}. The action is now available at ` +
        `Raild3x/require-on-rails@${major}`);
}

/**
 * Publishes the package to the chosen platform
 * @returns {Promise<void>}
 */
async function publish() {
    try {
        const version = getPackageVersion();
        
        console.log('RequireOnRails Publish Process');
        console.log('==============================');
        console.log(`Publishing version: ${version}`);
        
        // Check if VSIX file exists
        const vsixFile = `require-on-rails-${version}.vsix`;
        const vsixPath = path.join(__dirname, '..', vsixFile);
        
        if (!fs.existsSync(vsixPath)) {
            console.log(`✗ VSIX file not found: ${vsixFile}`);
            console.log('Run "npm run build" first to create the package.');
            process.exit(1);
        }
        
        console.log(`Found VSIX file: ${vsixFile}`);
        
        // Publish to marketplace
        console.log('\nPublishing to VS Code Marketplace...');
        execSync(`npx vsce publish`, { stdio: 'inherit', cwd: path.join(__dirname, '..') });
        
        console.log(`\n✓ Successfully published version ${version} to VS Code Marketplace!`);

        // The marketplace publish above is already irreversible, so a tagging failure must not
        // be reported as a failed publish — that invites a re-publish of a version that is
        // already live. Tagging is safe to retry by hand.
        try {
            tagRelease(version);
        } catch (error) {
            console.error(`\n✗ Published ${version}, but tagging failed: ${error.message}`);
            console.error('  The extension IS published. Do not re-run publish; just tag by hand:');
            console.error(`    git tag v${version} && git tag -f v${version.split('.')[0]}`);
            console.error(`    git push origin v${version} && git push -f origin v${version.split('.')[0]}`);
            process.exit(1);
        }

    } catch (error) {
        console.error('\n✗ Publish failed:', error.message);
        process.exit(1);
    }
}

/**
 * Main function that handles the publishing workflow
 * Presents user with publishing options and executes the chosen action
 * @returns {Promise<void>}
 */
async function main() {
    try {
        console.log('📦 RequireOnRails Publishing Script\n');
        
        const choice = await askQuestion(
            'What would you like to publish?\n' +
            '1. VSCode Extension (Marketplace)\n' +
            '2. Wally Package\n' +
            'Enter your choice (1 or 2): '
        );
        
        console.log();
        
        switch (choice.trim()) {
            case '1':
                console.log('🚀 Publishing to VSCode Marketplace...');
                await publish();
                break;
                
            case '2':
                console.log('🚀 Publishing to Wally...');
                await publishWally(rl);
                break;
                
            default:
                console.log('❌ Invalid choice. Please run the script again and choose 1 or 2.');
                process.exit(1);
        }
        
    } catch (error) {
        console.error('❌ Publishing failed:', error.message);
        process.exit(1);
    } finally {
        rl.close();
    }
}

main();
// // Run the publish if this script is executed directly
// if (require.main === module) {
//     publish();
// } else {
//     main();
// }