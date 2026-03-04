/**
 * MCP Tool definitions and handlers for Chronicle
 *
 * Re-exports from the split modules for backward compatibility.
 * - tool-definitions.ts: 22 tool definition objects (name, description, inputSchema)
 * - tool-handlers.ts: dispatch logic and individual handler functions
 */

export { registerTools } from './tool-definitions.js';
export { handleToolCall } from './tool-handlers.js';
