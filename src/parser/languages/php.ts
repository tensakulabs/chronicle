/**
 * PHP language configuration for Chronicle
 */
import { FLOW, ACCESS, EXCEPTIONS, LITERALS, buildKeywords } from './common.js';

export const PHP_KEYWORDS = buildKeywords(
    FLOW, ACCESS, EXCEPTIONS, LITERALS,
    [
        // Control flow extras
        'elseif', 'foreach', 'goto',
        // Functions & Classes
        'function', 'class', 'interface', 'trait', 'namespace',
        'abstract', 'final', 'static', 'const', 'var',
        // Visibility
        'readonly',
        // Include/Require
        'include', 'include_once', 'require', 'require_once', 'use',
        // Object operators
        'new', 'clone', 'instanceof', 'insteadof', 'implements', 'extends',
        // Output
        'echo', 'print',
        // Logical operators
        'and', 'or', 'xor',
        // Language constructs
        'array', 'list', 'eval', 'unset', 'empty', 'isset', 'yield',
        // Declarations
        'declare', 'enddeclare', 'endif', 'endfor', 'endforeach',
        'endswitch', 'endwhile', 'callable',
        // Other
        '__halt_compiler', 'die', 'exit', 'fn', 'match', 'global',
        // Magic constants
        '__CLASS__', '__DIR__', '__FILE__', '__FUNCTION__',
        '__LINE__', '__METHOD__', '__NAMESPACE__', '__TRAIT__',
    ],
);

export const PHP_IDENTIFIER_NODES = new Set(['name', 'variable_name']);
export const PHP_COMMENT_NODES = new Set(['comment']);

export const PHP_METHOD_NODES = new Set([
    'function_definition', 'method_declaration',
]);

export const PHP_TYPE_NODES = new Set([
    'class_declaration', 'interface_declaration',
    'trait_declaration', 'enum_declaration',
]);

/** Case-insensitive keyword check */
export function isKeyword(term: string): boolean {
    return PHP_KEYWORDS.has(term.toLowerCase());
}
