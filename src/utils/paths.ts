/**
 * Path normalization utilities
 */

/**
 * Replace backslashes with forward slashes for consistent path handling.
 * Used across all command files for cross-platform path normalization.
 */
export function normalizePath(path: string): string {
    return path.replace(/\\/g, '/');
}
