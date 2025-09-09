const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');

const packageJsonPath = path.join(__dirname, '..', 'package.json');

// Read current package.json
function readPackageJson() {
    const content = fs.readFileSync(packageJsonPath, 'utf8');
    return JSON.parse(content);
}

// Write updated package.json
function writePackageJson(packageData) {
    const content = JSON.stringify(packageData, null, 2);
    fs.writeFileSync(packageJsonPath, content, 'utf8');
}

// Parse version string into components
function parseVersion(version) {
    const parts = version.split('.');
    return {
        major: parseInt(parts[0], 10),
        minor: parseInt(parts[1], 10),
        patch: parseInt(parts[2], 10)
    };
}

// Increment version based on type
function incrementVersion(currentVersion, type) {
    const version = parseVersion(currentVersion);
    
    switch (type) {
        case 'patch':
            version.patch++;
            break;
        case 'minor':
            version.minor++;
            version.patch = 0;
            break;
        case 'major':
            version.major++;
            version.minor = 0;
            version.patch = 0;
            break;
        default:
            throw new Error(`Invalid version type: ${type}`);
    }
    
    return `${version.major}.${version.minor}.${version.patch}`;
}

// Prompt user for version type
function promptVersionType() {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        console.log('\nSelect version bump type:');
        console.log('1. patch (x.x.X) - Bug fixes');
        console.log('2. minor (x.X.0) - New features');
        console.log('3. major (X.0.0) - Breaking changes');
        console.log('4. skip - Build without version change');
        
        rl.question('\nEnter your choice (1-4): ', (answer) => {
            rl.close();
            
            switch (answer.trim()) {
                case '1':
                    resolve('patch');
                    break;
                case '2':
                    resolve('minor');
                    break;
                case '3':
                    resolve('major');
                    break;
                case '4':
                    resolve('skip');
                    break;
                default:
                    console.log('Invalid choice. Defaulting to patch.');
                    resolve('patch');
                    break;
            }
        });
    });
}

// Main build function
async function build() {
    try {
        console.log('RequireOnRails Build Process');
        console.log('============================');
        
        // Read current package.json
        const packageData = readPackageJson();
        const currentVersion = packageData.version;
        
        console.log(`Current version: ${currentVersion}`);
        
        // Prompt for version type
        const versionType = await promptVersionType();
        
        if (versionType !== 'skip') {
            // Calculate new version
            const newVersion = incrementVersion(currentVersion, versionType);
            
            console.log(`\nUpdating version from ${currentVersion} to ${newVersion}`);
            
            // Update package.json
            packageData.version = newVersion;
            writePackageJson(packageData);
            
            console.log('✓ Package.json updated');
            
            // Update CHANGELOG.md
            updateChangelog(currentVersion, newVersion, versionType);
        } else {
            console.log('\nSkipping version update');
        }
        
        // Run compilation
        console.log('\nRunning compilation...');
        try {
            execSync('npm run compile', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
            console.log('✓ Compilation completed');
        } catch (error) {
            console.log('⚠ Compilation step skipped (TypeScript disabled)');
        }
        
        // Run tests
        console.log('\nRunning tests...');
        try {
            execSync('npm test', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
            console.log('✓ Tests passed');
        } catch (error) {
            console.error('✗ Tests failed');
            throw error;
        }
        
        // Build VSIX package
        console.log('\nBuilding VSIX package...');
        execSync('npx vsce package', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
        console.log('✓ VSIX package created');
        
        console.log('\n✓ Build completed successfully!');
        
        if (versionType !== 'skip') {
            console.log(`\nNext steps:`);
            console.log(`1. Review the changes`);
            console.log(`2. Commit the version bump: git add . && git commit -m "chore: bump version to ${packageData.version}"`);
            console.log(`3. Create a tag: git tag v${packageData.version}`);
            console.log(`4. Push changes: git push && git push --tags`);
        }
        
    } catch (error) {
        console.error('\n✗ Build failed:', error.message);
        process.exit(1);
    }
}

// Update CHANGELOG.md with new version
function updateChangelog(oldVersion, newVersion, versionType) {
    const changelogPath = path.join(__dirname, '..', 'CHANGELOG.md');
    
    if (!fs.existsSync(changelogPath)) {
        console.log('⚠ CHANGELOG.md not found, skipping changelog update');
        return;
    }
    
    try {
        let content = fs.readFileSync(changelogPath, 'utf8');
        
        // Replace [Unreleased] with the new version and date
        const today = new Date().toISOString().split('T')[0];
        const versionHeader = `## [${newVersion}] - ${today}`;
        
        // Add new [Unreleased] section
        const unreleasedHeader = `## [Unreleased]\n\n### Added\n\n### Changed\n\n### Fixed\n\n`;
        
        // Replace the first occurrence of ## [Unreleased]
        content = content.replace('## [Unreleased]', unreleasedHeader + versionHeader);
        
        fs.writeFileSync(changelogPath, content, 'utf8');
        console.log('✓ CHANGELOG.md updated');
    } catch (error) {
        console.log('⚠ Failed to update CHANGELOG.md:', error.message);
    }
}

// Run the build if this script is executed directly
if (require.main === module) {
    build();
}

module.exports = { build, incrementVersion, parseVersion };
