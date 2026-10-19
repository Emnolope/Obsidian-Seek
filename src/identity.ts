import { pluginIdentity as pluginIdentityCore } from '../core/identity';
import type { IndexIdentity } from '../core/index-types';
import { DB_VERSION } from './index-store';
export * from '../core/identity';
// Plugin default: supplies the IndexedDB schema version core can't see.
export function pluginIdentity(dbVersion: number = DB_VERSION): IndexIdentity { return pluginIdentityCore(dbVersion); }
