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
const { spawn } = require('child_process');
const { publishWally } = require('./wallyPublish');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

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
                console.error('VSCode Marketplace publishing is currently disabled. Please use Wally instead.');
                // await runCommand('npm', ['run', 'vsce', 'publish']);
                // console.log('✅ Successfully published to VSCode Marketplace!');
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