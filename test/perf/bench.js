#!/usr/bin/env node
//
// Build conversion performance harness.
//
//   node test/perf/bench.js [--modules 5000] [--style string]
//
// Generates a synthetic Roblox project (deterministic pseudo-random require graph across
// Server/Client/Shared with realistic nesting), then measures the costs the watch pipeline's
// design rests on:
//
//   context      - createContext: the cost paid at every full-rebuild boundary
//   coldBuild    - full runBuild writing the output tree (activation / rename boundary)
//   incremental  - one watched save: convert + write a single file (avg/max over a sample)
//   burst        - one watch flush of a 50-file autosave batch
//
// Emits human-readable lines plus one machine-greppable `PERF_METRICS {json}` line for
// trend-watching in CI. Only generous ceilings assert (shared runners are noisy); the
// numbers themselves are the deliverable.
//
// If a darklua binary is runnable, also times `darklua process` over the generated output,
// so the README's post-processor recipes carry measured numbers. Skipped silently otherwise
// (CI does not install darklua).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { runBuild, convertOrCopyFile } = require('../../src/features/buildProject');
const pathResolver = require('../../src/features/pathResolver');

// ---------------------------------------------------------------------------
// Synthetic project generation (deterministic: same size -> same project)
// ---------------------------------------------------------------------------

/** Small LCG so runs are reproducible without Math.random. */
function makeRng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

/**
 * @param {string} root
 * @param {number} moduleCount
 */
function generateProject(root, moduleCount) {
    const rng = makeRng(42);
    const areas = ['src/Server', 'src/Client', 'src/Shared'];
    /** @type {{rel: string, name: string, area: string}[]} */
    const modules = [];
    /** @type {Record<string, string>} */
    const aliases = { Server: 'src/Server', Client: 'src/Client', Shared: 'src/Shared' };

    for (let i = 0; i < moduleCount; i++) {
        const area = areas[i % areas.length];
        const depth = 1 + Math.floor(rng() * 3);
        const dirs = [];
        for (let d = 0; d < depth; d++) dirs.push(`Sub${Math.floor(rng() * 6)}`);
        const name = `Module${i}`;
        const rel = `${area}/${dirs.join('/')}/${name}.luau`;
        modules.push({ rel, name, area });
        aliases[name] = rel.replace(/\.luau$/, '');
    }

    for (let i = 0; i < moduleCount; i++) {
        const module = modules[i];
        const lines = [];
        const requireCount = i === 0 ? 0 : 1 + Math.floor(rng() * 3);
        for (let r = 0; r < requireCount; r++) {
            const target = modules[Math.floor(rng() * i)];
            const form = rng();
            const spec = form < 0.5
                ? `@${target.name}`
                : `@${target.area.split('/')[1]}/${target.rel.split('/').slice(2).join('/').replace(/\.luau$/, '')}`;
            lines.push(`local Dep${r} = require("${spec}")`);
        }
        lines.push(`return { name = "${module.name}", deps = ${requireCount} }`);
        const absolute = path.join(root, module.rel);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, lines.join('\n') + '\n');
    }

    fs.writeFileSync(path.join(root, '.luaurc'), JSON.stringify({ aliases }, null, 2));
    fs.writeFileSync(path.join(root, 'default.project.json'), JSON.stringify({
        name: 'perf',
        tree: {
            $className: 'DataModel',
            ReplicatedStorage: { Shared: { $path: 'src/Shared' } },
            ServerScriptService: { Server: { $path: 'src/Server' } },
            StarterPlayer: {
                $className: 'StarterPlayer',
                StarterPlayerScripts: { Client: { $path: 'src/Client' } }
            }
        }
    }, null, 2));

    return modules;
}

// ---------------------------------------------------------------------------

/** @param {() => void} fn */
function timeMs(fn) {
    const start = process.hrtime.bigint();
    fn();
    return Number(process.hrtime.bigint() - start) / 1e6;
}

function main() {
    const argv = process.argv.slice(2);
    const moduleArg = argv.indexOf('--modules');
    const moduleCount = moduleArg !== -1 ? parseInt(argv[moduleArg + 1], 10) : 5000;
    const styleArg = argv.indexOf('--style');
    const style = /** @type {any} */ (styleArg !== -1 ? argv[styleArg + 1] : 'string');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ror-perf-'));
    console.log(`Generating synthetic project: ${moduleCount} modules (${root})`);
    const modules = generateProject(root, moduleCount);

    const buildOptions = {
        directoriesToScan: ['src/Server', 'src/Client', 'src/Shared'],
        ignoreDirectories: [],
        importModulePaths: ['game:GetService("ReplicatedStorage").src.Import'],
        outputDirectory: 'dist',
        outputRequireStyle: style,
        rojoProjectPath: 'default.project.json',
        sourcemapPath: 'sourcemap.json'
    };

    /** @type {Record<string, number>} */
    const metrics = { modules: moduleCount };

    // Context creation: the fixed cost of every full-rebuild boundary.
    /** @type {ReturnType<typeof pathResolver.createContext>} */
    let ctx = /** @type {any} */ (null);
    metrics.contextMs = timeMs(() => { ctx = pathResolver.createContext(root, buildOptions); });

    // Cold full build (writes the whole output tree).
    let buildResult;
    metrics.coldBuildMs = timeMs(() => { buildResult = runBuild(root, buildOptions); });
    if (!buildResult || buildResult.findings.length > 0 || !buildResult.written) {
        console.error('FAIL: synthetic project did not build cleanly:',
            JSON.stringify(buildResult && buildResult.findings.slice(0, 3), null, 2));
        process.exit(1);
    }

    // Incremental: one watched save = convert + write one file against the cached context.
    const rng = makeRng(7);
    const sample = [];
    for (let i = 0; i < Math.min(100, modules.length); i++) {
        sample.push(modules[Math.floor(rng() * modules.length)].rel);
    }
    /** @type {number[]} */
    const perFile = [];
    for (const rel of sample) {
        perFile.push(timeMs(() => {
            const findings = [];
            const result = convertOrCopyFile(root, rel, ctx, {
                outputRequireStyle: style,
                importModulePaths: buildOptions.importModulePaths
            }, findings);
            if (result) {
                const outPath = path.join(root, 'dist', rel);
                fs.mkdirSync(path.dirname(outPath), { recursive: true });
                fs.writeFileSync(outPath, result.data);
            }
        }));
    }
    metrics.incrementalAvgMs = perFile.reduce((a, b) => a + b, 0) / perFile.length;
    metrics.incrementalMaxMs = Math.max(...perFile);

    // Burst: one watch flush of a 50-file autosave batch.
    const burst = sample.slice(0, 50);
    metrics.burstMs = timeMs(() => {
        for (const rel of burst) {
            const findings = [];
            const result = convertOrCopyFile(root, rel, ctx, {
                outputRequireStyle: style,
                importModulePaths: buildOptions.importModulePaths
            }, findings);
            if (result) fs.writeFileSync(path.join(root, 'dist', rel), result.data);
        }
    });

    // Optional: darklua post-processing over the generated output (README recipe numbers).
    fs.writeFileSync(path.join(root, '.darklua.json'), JSON.stringify({ rules: ['remove_comments'] }));
    fs.writeFileSync(path.join(root, 'rokit.toml'), '[tools]\ndarklua = "seaofvoices/darklua@0.19.0"\n');
    const darkluaCommand = 'darklua process dist dist-darklua';
    const darklua = spawnSync(darkluaCommand, { cwd: root, encoding: 'utf8', shell: true });
    if (darklua.status === 0) {
        metrics.darkluaFullPassMs = timeMs(() => {
            spawnSync(darkluaCommand, { cwd: root, encoding: 'utf8', shell: true });
        });
    } else {
        console.log('darklua not runnable here — skipping post-processor benchmark.');
    }

    console.log('');
    console.log(`context:            ${metrics.contextMs.toFixed(1)} ms`);
    console.log(`cold full build:    ${metrics.coldBuildMs.toFixed(1)} ms  (${moduleCount} modules)`);
    console.log(`incremental save:   avg ${metrics.incrementalAvgMs.toFixed(2)} ms, max ${metrics.incrementalMaxMs.toFixed(2)} ms`);
    console.log(`50-file burst:      ${metrics.burstMs.toFixed(1)} ms`);
    if (metrics.darkluaFullPassMs !== undefined) {
        console.log(`darklua full pass:  ${metrics.darkluaFullPassMs.toFixed(1)} ms`);
    }
    console.log('');
    console.log(`PERF_METRICS ${JSON.stringify(metrics)}`);

    fs.rmSync(root, { recursive: true, force: true });

    // Generous ceilings only — shared CI runners are noisy, and the trend line is what matters.
    if (metrics.coldBuildMs > 60000) {
        console.error(`FAIL: cold build took ${metrics.coldBuildMs.toFixed(0)} ms (ceiling 60000).`);
        process.exit(1);
    }
    if (metrics.incrementalAvgMs > 100) {
        console.error(`FAIL: incremental average ${metrics.incrementalAvgMs.toFixed(1)} ms (ceiling 100).`);
        process.exit(1);
    }
}

main();
