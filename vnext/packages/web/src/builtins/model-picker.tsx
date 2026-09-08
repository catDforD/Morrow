import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import type { ProfileInfo } from '@morrow/sdk'
import type { PanelProps } from '../plugins.js'
import { request, type Configuration } from './model-configuration.js'

type Position = { left: number; top: number; width: number; maxHeight: number }

export function ModelPicker({ invoke, state, disabled, openPage }: PanelProps) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const submenu = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef<{ menu: 'root' | 'models'; supplier?: string } | null>(null)
  const [config, setConfig] = useState<Configuration>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [supplier, setSupplier] = useState<string | null>(null)
  const [stacked, setStacked] = useState(false)
  const [position, setPosition] = useState<Position>()
  const [subposition, setSubposition] = useState<Position>()
  const stateSelection = state.selection as Configuration['selection'] | undefined
  const reload = async () => { const next = await request<Configuration>(invoke, 'profiles.get'); setConfig(next); setError('') }
  useEffect(() => {
    let disposed = false
    void request<Configuration>(invoke, 'profiles.get').then(value => {
      if (!disposed) { setConfig(value); setError('') }
    }).catch(error => { if (!disposed) setError(String(error.message ?? error)) })
    return () => { disposed = true }
  }, [invoke, stateSelection?.profile, stateSelection?.model])

  const groups = config?.profiles.filter(profile => profile.enabled && profile.models.length && config.formats.some(format => format.id === profile.provider)) ?? []
  const selected = config?.selection
  const current = groups.find(profile => profile.id === (selected?.profile ?? config?.defaultId))
  const model = current?.models.find(model => model.id === (selected?.model ?? current.model))
  const group = groups.find(profile => profile.id === supplier)
  const expanded = open && !disabled && !busy
  const close = () => { pendingFocus.current = null; setOpen(false); trigger.current?.focus() }
  const focusFirst = (element: HTMLDivElement | null) => element?.querySelector<HTMLButtonElement>('[role^="menuitem"]')?.focus()
  const show = () => {
    pendingFocus.current = { menu: 'root' }
    setSupplier(null); setOpen(true)
    void reload().catch(error => setError(String(error.message ?? error)))
  }
  const expand = (profile: ProfileInfo, focus = false) => {
    if (focus && supplier === profile.id) { focusFirst(submenu.current ?? menu.current); return }
    if (focus) pendingFocus.current = { menu: 'models' }
    setSupplier(profile.id)
  }
  const back = () => {
    pendingFocus.current = { menu: 'root', supplier: supplier ?? undefined }
    setSupplier(null)
  }
  const choose = async (profile: string, model: string) => {
    close(); setBusy(true); setError('')
    try { await request(invoke, 'models.select', { profile, model }); await reload() }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  // Both menus live outside the composer so scrolling containers cannot clip them.
  useLayoutEffect(() => {
    if (!expanded) return
    const update = () => {
      if (!trigger.current || !menu.current) return
      const rect = trigger.current.getBoundingClientRect()
      const viewport = document.documentElement
      const width = Math.min(200, viewport.clientWidth - 16)
      const left = Math.max(8, Math.min(rect.right - width, viewport.clientWidth - width - 8))
      const subwidth = Math.min(260, viewport.clientWidth - 16)
      const fitsRight = left + width + subwidth + 4 <= viewport.clientWidth - 8
      const fitsLeft = left - subwidth - 4 >= 8
      setStacked(!fitsRight && !fitsLeft)
      menu.current.style.width = `${width}px`
      const above = rect.top - 14, below = viewport.clientHeight - rect.bottom - 14
      const upwards = above >= Math.min(320, menu.current.scrollHeight) || above > below
      const maxHeight = Math.max(0, Math.min(320, upwards ? above : below))
      const top = upwards ? rect.top - 6 - Math.min(menu.current.scrollHeight + 2, maxHeight) : rect.bottom + 6
      setPosition({ left, top, width, maxHeight })
      if (!submenu.current) return
      submenu.current.style.width = `${subwidth}px`
      const row = menu.current.querySelector<HTMLButtonElement>(`[data-supplier="${supplier}"]`)?.getBoundingClientRect()
      const subheight = Math.min(320, submenu.current.scrollHeight + 2, viewport.clientHeight - 16)
      setSubposition({ left: fitsRight ? left + width + 4 : Math.max(8, left - subwidth - 4), top: Math.max(8, Math.min(row?.top ?? top, viewport.clientHeight - subheight - 8)), width: subwidth, maxHeight: Math.min(320, viewport.clientHeight - 16) })
    }
    const scroll = (event: Event) => { if (!submenu.current?.contains(event.target as Node)) update() }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(trigger.current!)
    observer.observe(menu.current!)
    if (submenu.current) observer.observe(submenu.current)
    window.addEventListener('resize', update)
    document.addEventListener('scroll', scroll, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', update); document.removeEventListener('scroll', scroll, true) }
  }, [expanded, group, supplier, stacked, config])

  // Focus in the render commit, after positioning, so rapid arrow keys reach the menu.
  useLayoutEffect(() => {
    const pending = pendingFocus.current
    if (!expanded || !pending) return
    const target = pending.menu === 'models' ? submenu.current ?? menu.current : menu.current
    if (!target || target.style.visibility === 'hidden') return
    if (pending.supplier) target.querySelector<HTMLButtonElement>(`[data-supplier="${pending.supplier}"]`)?.focus()
    else focusFirst(target)
    pendingFocus.current = null
  })

  useEffect(() => {
    if (!expanded) return
    const dismiss = (event: Event) => {
      const target = event.target as Node
      if (!trigger.current?.contains(target) && !menu.current?.contains(target) && !submenu.current?.contains(target)) {
        pendingFocus.current = null
        setOpen(false)
      }
    }
    // Close on user actions; browser focus restoration must not dismiss a newly opened menu.
    const dismissKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key === 'Tab') { pendingFocus.current = null; setOpen(false) }
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', dismissKey)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', dismissKey) }
  }, [expanded])

  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    } else if (event.key === 'ArrowRight') {
      const profile = groups.find(profile => profile.id === buttons[index]?.dataset.supplier)
      if (profile) { event.preventDefault(); expand(profile, true) }
    } else if (event.key === 'ArrowLeft' && group) {
      event.preventDefault(); back()
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); close()
    } else if (event.key === 'Tab') close()
  }
  const modelItems = (profile: ProfileInfo) => profile.models.map(item => <button key={item.id} type="button" role="menuitemradio" aria-checked={current?.id === profile.id && model?.id === item.id}
    className="model-menu-item" onClick={() => { void choose(profile.id, item.id) }}>
    <span title={item.id}>{item.name || item.id}</span>{current?.id === profile.id && model?.id === item.id && <Check size={14} aria-hidden="true" />}
  </button>)

  return <div className="composer-model-picker">
    <button ref={trigger} type="button" className="model-picker-trigger" aria-label="选择模型" aria-haspopup="menu" aria-expanded={expanded} aria-controls={expanded ? id : undefined}
      title={model ? `${current!.name} · ${model.id}` : selected ? `模型已不可用：${selected.model}` : '选择模型'} disabled={disabled || busy}
      onClick={() => expanded ? close() : show()} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show() } }}>
      <span>{model?.name || model?.id || (selected ? '模型已不可用' : '选择模型')}</span><ChevronDown size={13} aria-hidden="true" />
    </button>
    {expanded && createPortal(<>
      <div ref={menu} id={id} role="menu" aria-label="模型供应商" className="model-picker-menu main-scroll" style={position ?? { visibility: 'hidden' }} onKeyDown={navigate}>
        {stacked && group ? <>
          <button type="button" role="menuitem" className="model-menu-item model-menu-back" onClick={back}><ChevronLeft size={14} /><span>{group.name}</span></button>
          <div role="separator" className="model-menu-separator" />{modelItems(group)}
        </> : <>
          {groups.map(profile => <button key={profile.id} type="button" role="menuitem" data-supplier={profile.id} aria-haspopup="menu" aria-expanded={group?.id === profile.id}
            aria-controls={group?.id === profile.id ? `${id}-models` : undefined} className="model-menu-item" onPointerEnter={event => { if (event.pointerType === 'mouse') expand(profile) }} onClick={() => expand(profile, true)}>
            <span>{profile.name}</span><ChevronRight size={14} aria-hidden="true" />
          </button>)}
          {!groups.length && <p className="model-menu-empty">{config ? '暂无可用模型' : '正在加载模型…'}</p>}
          <div role="separator" className="model-menu-separator" />
          <button type="button" role="menuitem" className="model-menu-item" onPointerEnter={() => setSupplier(null)} onClick={() => { close(); openPage?.('模型设置') }}>管理模型</button>
        </>}
      </div>
      {!stacked && group && <div ref={submenu} id={`${id}-models`} role="menu" aria-label={`${group.name} 的模型`} className="model-picker-menu main-scroll" style={subposition ?? { visibility: 'hidden' }} onKeyDown={navigate}>{modelItems(group)}</div>}
    </>, document.body)}
    {error && <span className="model-picker-error" role="alert">{error}</span>}
  </div>
}
