import type { Projection, Record as FactRecord } from '@morrow/sdk'

const fragment = new URLSearchParams(location.hash.slice(1))
if (fragment.has('token')) { sessionStorage.setItem('morrow-token', fragment.get('token')!); history.replaceState(null, '', location.pathname) }
export const token = () => sessionStorage.getItem('morrow-token') ?? ''
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...options, headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json', ...options.headers } })
  if (!response.ok) throw new Error((await response.json()).error ?? response.statusText)
  return response.json()
}
export const base = (session: string) => `/api/session/${encodeURIComponent(session)}`
export const snapshot = (session: string) => api<{ session: Projection; workspace: Projection }>(base(session))
export const facts = (session: string) => api<FactRecord[]>(`${base(session)}/facts`)
export const action = (session: string, action: string, values: object = {}) => api(base(session), { method: 'POST', body: JSON.stringify({ action, ...values }) })
export const sessionNames = async () => (await api<string[]>('/api/sessions')).filter(name => name !== '_workspace' && !/^workspace-[a-f0-9]{64}$/.test(name))
