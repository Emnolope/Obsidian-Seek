// Moved to core/ so the MCP server shares it; re-exported so plugin imports are unchanged.
// expectationFor keeps its plugin-identity default here: core has no plugin to ask, so core's copy takes the identity as an argument.
import { expectationFor as expectationForCore } from '../core/sidecar-meta';
import type { MetaExpectation } from '../core/sidecar-types';
import { pluginIdentity, type IndexIdentity } from './identity';

export * from '../core/sidecar-meta';

export function expectationFor(id: IndexIdentity = pluginIdentity()): MetaExpectation {
    return expectationForCore(id);
}
