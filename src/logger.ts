// The plugin's half of the logger: core/logger.ts does the work; this binds it to Obsidian's vault adapter, localStorage and Platform so `new SeekLogger(app, id)` call sites are unchanged.
import type { App } from 'obsidian';
import { SeekLogger as CoreSeekLogger } from '../core/logger';
import { isMobilePlatform } from './platform';

export class SeekLogger extends CoreSeekLogger {
    constructor(app: App, pluginId: string) {
        super({
            adapter: app.vault.adapter,
            device: { get: k => window.localStorage.getItem(k), set: (k, v) => window.localStorage.setItem(k, v), remove: k => window.localStorage.removeItem(k) },
            platform: isMobilePlatform() ? 'mobile' : 'desktop',
        }, pluginId);
    }
}
