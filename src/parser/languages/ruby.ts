/**
 * Ruby language configuration for Chronicle
 */
import { ACCESS, buildKeywords } from './common.js';

export const RUBY_KEYWORDS = buildKeywords(
    ACCESS,
    [
        // Control flow
        'if', 'elsif', 'else', 'unless', 'then',
        'while', 'until', 'do', 'end',
        'for', 'in', 'case', 'when',
        // Definition
        'def', 'class', 'module', 'super', 'alias', 'undef',
        // Exception handling
        'begin', 'rescue', 'ensure', 'retry', 'raise',
        // Return & Flow control
        'return', 'yield', 'break', 'next', 'redo',
        // Literals & Values
        'true', 'false', 'nil', 'self',
        // Logical operators
        'and', 'or', 'not',
        // Special
        'defined?', 'BEGIN', 'END',
        // Magic constants
        '__LINE__', '__FILE__', '__ENCODING__',
        // Common built-ins (often noise)
        'attr_reader', 'attr_writer', 'attr_accessor',
        'require', 'require_relative', 'include', 'extend', 'prepend',
    ],
);

export const RUBY_IDENTIFIER_NODES = new Set([
    'identifier', 'constant',
    'instance_variable', 'class_variable', 'global_variable',
]);

export const RUBY_COMMENT_NODES = new Set(['comment']);

export const RUBY_METHOD_NODES = new Set(['method', 'singleton_method']);

export const RUBY_TYPE_NODES = new Set(['class', 'module', 'singleton_class']);

/** Case-sensitive keyword check */
export function isKeyword(term: string): boolean {
    return RUBY_KEYWORDS.has(term);
}
