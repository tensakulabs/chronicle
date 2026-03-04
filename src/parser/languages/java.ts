/**
 * Java language configuration for Chronicle
 */
import { FLOW, ACCESS, EXCEPTIONS, LITERALS, buildKeywords } from './common.js';

export const JAVA_KEYWORDS = buildKeywords(
    FLOW, ACCESS, EXCEPTIONS, LITERALS,
    [
        // Reserved keywords
        'abstract', 'assert', 'boolean', 'byte', 'char',
        'class', 'const', 'double', 'enum', 'extends',
        'final', 'float', 'goto', 'implements', 'import',
        'instanceof', 'int', 'interface', 'long', 'native',
        'new', 'package', 'short', 'static',
        'strictfp', 'super', 'synchronized', 'this', 'throws',
        'transient', 'void', 'volatile',
        // Contextual keywords
        'var', 'record', 'sealed', 'permits', 'yield', 'non-sealed',
    ],
);

export const JAVA_IDENTIFIER_NODES = new Set(['identifier', 'type_identifier']);

export const JAVA_COMMENT_NODES = new Set(['line_comment', 'block_comment']);

export const JAVA_METHOD_NODES = new Set([
    'method_declaration', 'constructor_declaration',
]);

export const JAVA_TYPE_NODES = new Set([
    'class_declaration', 'interface_declaration', 'enum_declaration',
    'record_declaration', 'annotation_type_declaration',
]);

/** Case-sensitive keyword check */
export function isKeyword(term: string): boolean {
    return JAVA_KEYWORDS.has(term);
}
