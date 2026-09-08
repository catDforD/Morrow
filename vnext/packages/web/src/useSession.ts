import { useCallback, useEffect, useRef, useState } from 'react'
import type { Projection, Record as FactRecord } from '@morrow/sdk'
import { action, facts, sessionNames, snapshot, token } from './api.js'
import { Clients, type ClientView } from './plugins.js'
import type { SessionEntry } from './AppSidebar.js'

export function useSession(session: string) {
  const [data, setData] = useState<{ session: Projection; workspace: Projection }>()
  const [timeline, setTimeline] = useState<FactRecord[]>([])
  const [sessions, setSessions] = useState<SessionEntry[]>([])
  const [error, setError] = useState('')
  const [delta, setDelta] = useState('')
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'disconnected'>('connecting')
  const [enabled, setEnabled] = useState(false)
  const [views, setViews] = useState<ClientView[]>([])
  const clients = useRef<Clients | undefined>(undefined)

  const refreshDirectory = useCallback(async () => {
    try {
      const names = await sessionNames()
      const entries = await Promise.all(names.map(async name => {
        const { session: state } = await snapshot(name)
        return state.parent ? null : { name, turns: state.run_ids.length, has_summary: Object.values(state.nodes).some(node => node.covers.length > 0), path: name }
      }))
      setSessions(entries.filter((entry): entry is SessionEntry => entry !== null))
    } catch (error) { setError(String(error)) }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [next, log] = await Promise.all([snapshot(session), facts(session)])
      setData(previous => !previous || next.session.seq >= previous.session.seq ? next : previous)
      setTimeline(previous => log.length >= previous.length ? log : previous)
    } catch (error) { setError(String(error)) }
  }, [session])

  const perform = async (name: string, values: object = {}) => {
    try {
      setError('')
      await action(session, name, values)
      await refresh()
      return true
    } catch (error) { setError(String(error)); return false }
  }

  useEffect(() => { void refresh().then(refreshDirectory) }, [refresh, refreshDirectory])
  useEffect(() => {
    let stopped = false
    let socket: WebSocket
    let retry: ReturnType<typeof setTimeout>
    let activeRun = '', activeRequest = '', sequence = 0
    const connect = () => {
      setConnection('connecting')
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/events?token=${encodeURIComponent(token())}`)
      socket.onopen = () => { setConnection('connected'); void refresh(); void refreshDirectory() }
      socket.onmessage = event => {
        const value = JSON.parse(event.data)
        if (value.type === 'resync' || value.type === 'host_disconnected') { setDelta(''); void refresh(); void refreshDirectory() }
        if (value.session !== session && value.session !== '_workspace') return
        if (value.type === 'model_progress' && value.purpose === 'main' && value.run === activeRun && value.request === activeRequest && value.sequence > sequence) {
          sequence = value.sequence
          if (value.events.some((e: { type: string }) => e.type === 'gap')) setDelta('')
          setDelta(previous => previous + value.events.filter((e: { type: string }) => e.type === 'text').map((e: { text: string }) => e.text).join(''))
        }
        if (value.type === 'fact') {
          const fact = value.record.fact
          if (fact.type === 'run_started') activeRun = fact.run
          if (fact.type === 'request_prepared' && fact.request.purpose === 'main') { activeRun = fact.request.run; activeRequest = fact.request.id; sequence = 0; setDelta('') }
          if (fact.type === 'model_settled' && fact.request === activeRequest) activeRequest = ''
          if (fact.type === 'run_ended') { activeRun = ''; activeRequest = '' }
          if (value.session === session && ['model_settled', 'run_ended', 'run_started'].includes(value.record.fact.type)) setDelta('')
          void refresh()
          if (['run_ended', 'session_opened'].includes(value.record.fact.type)) void refreshDirectory()
        }
      }
      socket.onclose = () => { if (!stopped) { setConnection('disconnected'); retry = setTimeout(connect, 1000) } }
    }
    connect()
    return () => { stopped = true; clearTimeout(retry); socket.close() }
  }, [session, refresh, refreshDirectory])

  useEffect(() => {
    const manager = new Clients(session, setViews)
    clients.current = manager
    return () => { clients.current = undefined; void manager.dispose() }
  }, [session])
  useEffect(() => {
    if (clients.current && data) void clients.current.sync(data.session, data.workspace, enabled).catch(error => setError(String(error)))
  }, [data, enabled])

  return { data, timeline, sessions, error, setError, delta, connection, enabled, setEnabled, views, refresh, refreshDirectory, perform }
}
