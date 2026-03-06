#!/usr/bin/env node
/**
 * Chronicle - MCP Server Entry Point
 *
 * Provides persistent code indexing for Claude Code.
 *
 * Usage:
 *   node build/index.js              - Start MCP server (default)
 *   node build/index.js scan <path>  - Scan for .chronicle directories
 *   node build/index.js init <path>  - Index a project
 */

import { createServer } from './server/mcp-server.js';
import { scan, init } from './commands/index.js';
import { setupMcpClients, unsetupMcpClients } from './commands/setup.js';
import { PRODUCT_NAME, PRODUCT_NAME_LOWER } from './constants.js';
import { startViewer, stopViewer } from './viewer/server.js';

async function main() {
    const args = process.argv.slice(2);

    // CLI mode: --version / -v
    if (args[0] === '--version' || args[0] === '-v') {
        const { createRequire } = await import('module');
        const require = createRequire(import.meta.url);
        const pkg = require('../package.json');
        console.log(pkg.version);
        return;
    }

    // CLI mode: --help / -h / help
    if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
        console.log(`${PRODUCT_NAME} - MCP Server for persistent code indexing

Usage: ${PRODUCT_NAME_LOWER} [command] [options]

Commands:
  init <path>       Index a project (creates .chronicle/)
  scan <path>       Find indexed projects in directory tree
  viewer [path]     Open interactive project explorer (default: .)
  setup             Register as MCP server in AI clients
  unsetup           Remove MCP server registration
  help              Show this help message

Options:
  -v, --version     Show version number
  -h, --help        Show this help message

Running without a command starts the MCP server (stdio transport).

Examples:
  ${PRODUCT_NAME_LOWER} init .              Index current directory
  ${PRODUCT_NAME_LOWER} scan ~/projects     Find all indexed projects
  ${PRODUCT_NAME_LOWER} viewer              Open viewer for current project
  ${PRODUCT_NAME_LOWER} setup               Auto-register with Claude, Cursor, etc.`);
        return;
    }

    // CLI mode: scan
    if (args[0] === 'scan') {
        const searchPath = args[1];
        if (!searchPath) {
            console.error(`Usage: ${PRODUCT_NAME_LOWER} scan <path>`);
            process.exit(1);
        }

        const result = scan({ path: searchPath });

        if (!result.success) {
            console.error(`Error: ${result.error}`);
            process.exit(1);
        }

        console.log(`\n${PRODUCT_NAME} Indexes Found: ${result.projects.length}`);
        console.log(`Scanned: ${result.scannedDirs} directories\n`);

        if (result.projects.length === 0) {
            console.log('No indexed projects found.');
        } else {
            for (const proj of result.projects) {
                console.log(`${proj.name}`);
                console.log(`  Path: ${proj.path}`);
                console.log(`  Files: ${proj.files} | Items: ${proj.items} | Methods: ${proj.methods} | Types: ${proj.types}`);
                console.log(`  Last indexed: ${proj.lastIndexed}`);
                console.log();
            }
        }

        return;
    }

    // CLI mode: init
    if (args[0] === 'init') {
        const projectPath = args[1];
        if (!projectPath) {
            console.error(`Usage: ${PRODUCT_NAME_LOWER} init <path>`);
            process.exit(1);
        }

        console.log(`Indexing: ${projectPath}`);
        const result = await init({ path: projectPath });

        if (!result.success) {
            console.error(`Error: ${result.errors.join(', ')}`);
            process.exit(1);
        }

        console.log(`Done!`);
        console.log(`  Files: ${result.filesIndexed}`);
        console.log(`  Items: ${result.itemsFound}`);
        console.log(`  Methods: ${result.methodsFound}`);
        console.log(`  Types: ${result.typesFound}`);
        console.log(`  Time: ${result.durationMs}ms`);

        return;
    }

    // CLI mode: setup
    if (args[0] === 'setup') {
        setupMcpClients();
        return;
    }

    // CLI mode: unsetup
    if (args[0] === 'unsetup') {
        unsetupMcpClients();
        return;
    }

    // CLI mode: viewer
    if (args[0] === 'viewer') {
        const { resolve } = await import('path');
        const projectPath = resolve(args[1] ?? '.');
        const result = await startViewer(projectPath);
        console.log(result);
        console.log('Press Ctrl+C to stop.');
        // Keep process alive until interrupted
        await new Promise(() => {});
    }

    // Interactive terminal: show helpful info instead of silently starting server
    if (process.stdin.isTTY && args.length === 0) {
        const { createRequire } = await import('module');
        const require = createRequire(import.meta.url);
        const pkg = require('../package.json');

        console.log(`
  ${PRODUCT_NAME} v${pkg.version}
  MCP Server for persistent code indexing

  Quick Start:
    ${PRODUCT_NAME_LOWER} init .              Index current project
    ${PRODUCT_NAME_LOWER} scan ~/projects     Find indexed projects
    ${PRODUCT_NAME_LOWER} setup               Register with AI clients

  Commands:
    init <path>       Index a project (creates .chronicle/)
    scan <path>       Find indexed projects in directory tree
    viewer [path]     Open interactive project explorer
    setup             Register as MCP server in AI clients
    unsetup           Remove MCP server registration

  Options:
    -v, --version     Show version number
    -h, --help        Show full help

  The MCP server starts automatically when invoked by an AI client.
  To start it manually: ${PRODUCT_NAME_LOWER} serve
`);
        return;
    }

    // Start MCP server (default for non-TTY / piped stdin, or explicit 'serve')
    if (args[0] === 'serve') {
        // Explicit serve command — strip it so server doesn't see it
    }

    const server = createServer();

    // Graceful shutdown handlers
    const shutdown = () => {
        stopViewer();
        process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    await server.start();
}

main().catch((error) => {
    console.error(`Failed to start ${PRODUCT_NAME}:`, error);
    process.exit(1);
});
