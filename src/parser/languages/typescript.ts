/**
 * TypeScript/JavaScript language configuration for Chronicle
 */
import { FLOW, ACCESS, EXCEPTIONS, LITERALS, buildKeywords } from './common.js';

export const TYPESCRIPT_KEYWORDS = buildKeywords(
    FLOW, ACCESS, EXCEPTIONS, LITERALS,
    [
        // Declarations
        'function', 'class', 'interface', 'type', 'enum',
        'const', 'let', 'var', 'namespace', 'module', 'declare',
        // Modifiers
        'export', 'import', 'from', 'as',
        'static', 'readonly', 'abstract', 'async', 'await', 'override',
        // Primitive types
        'void', 'number', 'string', 'boolean', 'symbol', 'bigint',
        'any', 'unknown', 'never', 'object',
        // Control flow extras
        'in', 'of',
        // Operators and literals
        'new', 'typeof', 'instanceof', 'delete', 'keyof',
        'undefined', 'this', 'super',
        'is', 'infer', 'extends', 'implements',
        // Property accessors
        'get', 'set',
        // Other
        'constructor', 'with', 'debugger', 'yield', 'satisfies',
        // Common framework types (often noise)
        'Promise', 'Array', 'Map', 'Set', 'Object', 'Function',
        'Record', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit',
        'Exclude', 'Extract', 'ReturnType', 'Parameters',
    ],
);

export const TYPESCRIPT_IDENTIFIER_NODES = new Set([
    'identifier', 'type_identifier',
    'property_identifier', 'shorthand_property_identifier',
]);

export const TYPESCRIPT_COMMENT_NODES = new Set(['comment']);

export const TYPESCRIPT_METHOD_NODES = new Set([
    'function_declaration', 'method_definition', 'arrow_function',
    'function_expression', 'generator_function_declaration',
]);

export const TYPESCRIPT_TYPE_NODES = new Set([
    'class_declaration', 'abstract_class_declaration',
    'interface_declaration', 'type_alias_declaration', 'enum_declaration',
]);

/** Case-insensitive keyword check */
export function isKeyword(term: string): boolean {
    return TYPESCRIPT_KEYWORDS.has(term.toLowerCase());
}
