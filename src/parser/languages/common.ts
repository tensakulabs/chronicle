/**
 * Shared keyword groups and helpers for Chronicle language configurations.
 */

/** Control flow keywords used by TS, Java, C#, C, C++, PHP (11 keywords) */
export const FLOW = [
    'break', 'case', 'continue', 'default', 'do', 'else',
    'for', 'if', 'return', 'switch', 'while',
] as const;

/** Access modifiers used by TS, Java, C#, C++, PHP, Ruby */
export const ACCESS = ['public', 'private', 'protected'] as const;

/** Exception keywords used by TS, Java, C#, PHP */
export const EXCEPTIONS = ['try', 'catch', 'finally', 'throw'] as const;

/** Boolean + null literals used by TS, Java, C#, PHP */
export const LITERALS = ['true', 'false', 'null'] as const;

/** Build a keyword Set from multiple arrays of strings. */
export function buildKeywords(...sources: (readonly string[])[]): Set<string> {
    const result = new Set<string>();
    for (const src of sources) {
        for (const k of src) result.add(k);
    }
    return result;
}
