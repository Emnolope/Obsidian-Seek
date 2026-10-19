import { pluginIdentity as pluginIdentityCore } from '../core/identity';
import type { IndexIdentity } from '../core/index-types';
import { DB_VERSION } from './index-store';
export * from '../core/identity';
// Plugin default: supplies the IndexedDB schema version core can't see.
// fork 1.1.3 src/identity.ts:39 pluginIdentity (core takes dbVersion; this wrapper keeps the old zero-arg call)
export function pluginIdentity(dbVersion: number = DB_VERSION): IndexIdentity { return pluginIdentityCore(dbVersion); }
