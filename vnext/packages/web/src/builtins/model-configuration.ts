import type { ProfileInfo } from '@morrow/sdk'
import type { PanelProps } from '../plugins.js'

export type Configuration = {
  profiles: ProfileInfo[]; defaultId: string
  formats: { id: string; label: string; requestPath: string }[]
  selection: { profile: string; model: string } | null
}

export async function request<T>(invoke: PanelProps['invoke'], method: string, input?: unknown): Promise<T> {
  const value = await invoke(method, input)
  if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string') throw new Error(value.error)
  return value as T
}

export function baseUrl(profile: ProfileInfo, formats: Configuration['formats']) {
  if (profile.baseUrl !== undefined) return profile.baseUrl
  const path = formats.find(format => format.id === profile.provider)?.requestPath
  return path && profile.endpoint.endsWith(path) ? profile.endpoint.slice(0, -path.length) : profile.endpoint
}

export const modelWindow = (tokens: number) => tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(1))}M` : tokens >= 1000 ? `${Number((tokens / 1000).toFixed(1))}K` : `${tokens}`
