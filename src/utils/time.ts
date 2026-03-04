/**
 * Time offset parsing utility
 *
 * Moved from src/commands/query.ts — used by query.ts and files.ts.
 */

/**
 * Parse time offset string to Unix timestamp
 * Supports: "2h" (hours), "30m" (minutes), "1d" (days), "1w" (weeks), or ISO date string
 */
export function parseTimeOffset(input: string): number | null {
    if (!input) return null;

    // Try relative time format: 2h, 30m, 1d, 1w
    const match = input.match(/^(\d+)([mhdw])$/i);
    if (match) {
        const value = parseInt(match[1], 10);
        const unit = match[2].toLowerCase();
        const now = Date.now();

        switch (unit) {
            case 'm': return now - value * 60 * 1000;           // minutes
            case 'h': return now - value * 60 * 60 * 1000;      // hours
            case 'd': return now - value * 24 * 60 * 60 * 1000; // days
            case 'w': return now - value * 7 * 24 * 60 * 60 * 1000; // weeks
        }
    }

    // Try ISO date string
    const date = new Date(input);
    if (!isNaN(date.getTime())) {
        return date.getTime();
    }

    return null;
}
