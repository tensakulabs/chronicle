/**
 * Chronicle - Global constants
 *
 * Change product name here to rename the entire tool.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pkg = require('../package.json');

export const PRODUCT_NAME = 'Chronicle';
export const PRODUCT_NAME_LOWER = 'chronicle';
export const PRODUCT_VERSION: string = pkg.version;
export const INDEX_DIR = '.chronicle';
export const TOOL_PREFIX = 'chronicle_';
