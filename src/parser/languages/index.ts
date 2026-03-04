/**
 * Language configuration registry
 */

import type { SupportedLanguage } from '../tree-sitter.js';
import * as csharp from './csharp.js';
import * as typescript from './typescript.js';
import * as rust from './rust.js';
import * as python from './python.js';
import * as c from './c.js';
import * as cpp from './cpp.js';
import * as java from './java.js';
import * as go from './go.js';
import * as php from './php.js';
import * as ruby from './ruby.js';

export interface LanguageConfig {
    isKeyword: (term: string) => boolean;
    identifierNodes: Set<string>;
    commentNodes: Set<string>;
    methodNodes: Set<string>;
    typeNodes: Set<string>;
    propertyNodes?: Set<string>;
}

/** Helper to build a LanguageConfig from a language module's exports. */
function cfg(
    mod: { isKeyword: (term: string) => boolean },
    identifierNodes: Set<string>,
    commentNodes: Set<string>,
    methodNodes: Set<string>,
    typeNodes: Set<string>,
    propertyNodes?: Set<string>,
): LanguageConfig {
    const config: LanguageConfig = { isKeyword: mod.isKeyword, identifierNodes, commentNodes, methodNodes, typeNodes };
    if (propertyNodes) config.propertyNodes = propertyNodes;
    return config;
}

const tsConfig = cfg(typescript, typescript.TYPESCRIPT_IDENTIFIER_NODES, typescript.TYPESCRIPT_COMMENT_NODES, typescript.TYPESCRIPT_METHOD_NODES, typescript.TYPESCRIPT_TYPE_NODES);

const configs: Record<SupportedLanguage, LanguageConfig> = {
    csharp: cfg(csharp, csharp.CSHARP_IDENTIFIER_NODES, csharp.CSHARP_COMMENT_NODES, csharp.CSHARP_METHOD_NODES, csharp.CSHARP_TYPE_NODES, csharp.CSHARP_PROPERTY_NODES),
    typescript: tsConfig,
    javascript: tsConfig,
    rust: cfg(rust, rust.RUST_IDENTIFIER_NODES, rust.RUST_COMMENT_NODES, rust.RUST_METHOD_NODES, rust.RUST_TYPE_NODES),
    python: cfg(python, python.PYTHON_IDENTIFIER_NODES, python.PYTHON_COMMENT_NODES, python.PYTHON_METHOD_NODES, python.PYTHON_TYPE_NODES),
    c: cfg(c, c.C_IDENTIFIER_NODES, c.C_COMMENT_NODES, c.C_METHOD_NODES, c.C_TYPE_NODES),
    cpp: cfg(cpp, cpp.CPP_IDENTIFIER_NODES, cpp.CPP_COMMENT_NODES, cpp.CPP_METHOD_NODES, cpp.CPP_TYPE_NODES),
    java: cfg(java, java.JAVA_IDENTIFIER_NODES, java.JAVA_COMMENT_NODES, java.JAVA_METHOD_NODES, java.JAVA_TYPE_NODES),
    go: cfg(go, go.GO_IDENTIFIER_NODES, go.GO_COMMENT_NODES, go.GO_METHOD_NODES, go.GO_TYPE_NODES),
    php: cfg(php, php.PHP_IDENTIFIER_NODES, php.PHP_COMMENT_NODES, php.PHP_METHOD_NODES, php.PHP_TYPE_NODES),
    ruby: cfg(ruby, ruby.RUBY_IDENTIFIER_NODES, ruby.RUBY_COMMENT_NODES, ruby.RUBY_METHOD_NODES, ruby.RUBY_TYPE_NODES),
};

/** Get language configuration */
export function getLanguageConfig(language: SupportedLanguage): LanguageConfig {
    return configs[language];
}

/** Check if a term is a keyword for the given language */
export function isKeyword(term: string, language: SupportedLanguage): boolean {
    return configs[language].isKeyword(term);
}
