import type { Context } from '@deepseek-ai/cordis'

/** The pinned DSH adapters below use the audited fetch boundary. A plugin loaded in the same
 * process is trusted code; the public provider directory is a compatibility check, not a sandbox. */
export function assertMemoryProviderSupported(llm: Pick<Context['llm'], 'listConfigurableProviders'>, provider: string): void {
  if (provider === 'deepseek-official' || provider === 'deepseek-account') return
  const configured = llm.listConfigurableProviders().find(item => item.provider === provider)
  if (configured?.settingsNs === 'llm-pi-ai'
    && configured.settingsPath.length === 2 && configured.settingsPath[0] === 'providers' && configured.settingsPath[1] === provider) return
  throw new Error('Model adapter does not support the memory request barrier')
}
