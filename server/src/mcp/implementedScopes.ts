import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { collectScopesFromRegistration } from './scopes';
import { registerTools } from './tools';
import { registerResources } from './resources';

// Minimal no-op stand-in — only registerTool/registerResource are called during
// registration; handlers are closures that never execute at this point.
const mockServer = {
  registerTool: () => {},
  registerResource: () => {},
} as unknown as McpServer;

/**
 * Derived at startup by running both registrar functions in probe mode.
 * Automatically stays in sync: adding or removing a scope guard in tools.ts
 * or resources.ts is the only change needed.
 */
export const IMPLEMENTED_SCOPES: string[] = collectScopesFromRegistration(() => {
  registerTools(mockServer, 0, null);
  registerResources(mockServer, 0, null);
});
