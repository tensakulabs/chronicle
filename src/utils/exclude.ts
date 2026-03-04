/**
 * Exclude pattern utilities
 *
 * Moved from src/commands/init.ts — imported by update.ts and session.ts.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// ============================================================
// Default exclude patterns
// ============================================================

export const DEFAULT_EXCLUDE = [
    // Package managers
    '**/node_modules/**',
    '**/packages/**',
    '**/vendor/**',          // PHP Composer, Go
    '**/vendor/bundle/**',   // Ruby Bundler
    // Build output
    '**/bin/**',
    '**/obj/**',
    '**/bld/**',             // Alternative build folder
    '**/build/**',
    '**/dist/**',
    '**/out/**',             // VS Code, some TS configs
    '**/target/**',          // Rust, Maven
    '**/Debug/**',           // Visual Studio
    '**/Release/**',         // Visual Studio
    '**/x64/**',             // Visual Studio
    '**/x86/**',             // Visual Studio
    '**/[Aa][Rr][Mm]/**',    // Visual Studio ARM
    '**/[Aa][Rr][Mm]64/**',  // Visual Studio ARM64
    '**/__pycache__/**',     // Python
    '**/.pyc',               // Python bytecode
    '**/venv/**',            // Python virtual env
    '**/.venv/**',           // Python virtual env
    '**/env/**',             // Python virtual env
    '**/*.egg-info/**',      // Python package metadata
    // IDE/Editor
    '**/.git/**',
    '**/.vs/**',
    '**/.idea/**',
    '**/.vscode/**',
    // Framework-specific
    '**/.next/**',           // Next.js
    '**/coverage/**',        // Test coverage
    '**/tmp/**',             // Ruby, temp files
    // Generated files
    '**/*.min.js',
    '**/*.generated.*',
    '**/*.g.cs',             // C# source generators
    '**/*.Designer.cs',      // WinForms designer
];

// ============================================================
// .gitignore support
// ============================================================

export function readGitignore(projectPath: string): string[] {
    const gitignorePath = join(projectPath, '.gitignore');
    if (!existsSync(gitignorePath)) return [];

    const content = readFileSync(gitignorePath, 'utf-8');
    return content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))  // Keine Kommentare/Leerzeilen
        .map(pattern => {
            // Glob-kompatibel machen
            if (pattern.endsWith('/')) {
                return `**/${pattern}**`;  // Verzeichnis: foo/ → **/foo/**
            }
            if (!pattern.includes('/') && !pattern.startsWith('*')) {
                return `**/${pattern}`;    // Datei/Ordner: foo → **/foo
            }
            return pattern;
        });
}
