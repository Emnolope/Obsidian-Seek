// Moved to core/ so the MCP server shares it; this binds Obsidian's parseYaml so plugin call sites are unchanged.
import { parseYaml } from 'obsidian';
import { extractBaseDocs as extractBaseDocsCore } from '../core/base-extractor';
import type { BaseView } from './types';

export type { BaseView };
export const extractBaseDocs = (raw: string, path: string): BaseView[] => extractBaseDocsCore(raw, path, parseYaml);
