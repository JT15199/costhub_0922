import { invoke } from '@tauri-apps/api/core';

async function hasReadableCredential(provider: any): Promise<boolean> {
  if (provider.credential_configured === true) return true;
  try { return await invoke<boolean>('provider_secret_status', { providerId: Number(provider.id) }); }
  catch { return Boolean(provider.credential_configured); }
}

/** 运行时与设置页统一：只有已启用且保险库可读的 LLM 才算可用。 */
export async function hasLLMConfig(): Promise<boolean> {
  try {
    const dbModule = await import('./db');
    if (Object.prototype.hasOwnProperty.call(dbModule, 'ensureConfiguredSearchActive')) {
      await (dbModule as any).ensureConfiguredSearchActive().catch(() => false);
    }
    const providers = await dbModule.getApiProviders();
    return (await Promise.all(providers.filter((p: any) => p.provider_type === 'llm' && Boolean(p.is_active)).map(hasReadableCredential))).some(Boolean);
  } catch {
    return false;
  }
}

/** Search provider diagnostic: distinguishes missing / inactive / unreadable credentials. */
export interface SearchConfigDiagnostic {
  available: boolean;
  providerCount: number;
  activeCount: number;
  activeWithCredential: number;
  inactiveConfigured: string[];
  missingCredential: string[];
}

export async function diagnoseSearchConfig(): Promise<SearchConfigDiagnostic> {
  try {
    const { getApiProviders } = await import('./db');
    const providers = await getApiProviders();
    const searchProviders = providers.filter((p: any) => p.provider_type === 'search');
    const checked = await Promise.all(searchProviders.map(async (provider: any) => ({
      provider,
      readable: await hasReadableCredential(provider),
    })));
    const activeWithCredential = checked.filter(item => Boolean(item.provider.is_active) && item.readable);
    return {
      available: activeWithCredential.length > 0,
      providerCount: searchProviders.length,
      activeCount: searchProviders.filter((p: any) => Boolean(p.is_active)).length,
      activeWithCredential: activeWithCredential.length,
      inactiveConfigured: checked.filter(item => !item.provider.is_active && item.readable).map(item => String(item.provider.provider_name || 'search-provider')),
      missingCredential: checked.filter(item => Boolean(item.provider.is_active) && !item.readable).map(item => String(item.provider.provider_name || 'search-provider')),
    };
  } catch {
    return { available: false, providerCount: 0, activeCount: 0, activeWithCredential: 0, inactiveConfigured: [], missingCredential: [] };
  }
}

/** Check whether an active search provider has a readable key. */
export async function hasSearchConfig(): Promise<boolean> {
  return (await diagnoseSearchConfig()).available;
}
