import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'

type Option = { value: string; label: string }
type Position = { left: number; top: number; width: number; maxHeight: number }

export function Select({ label, value, options, onChange, disabled = false, compact = false, onOpen }: {
  label: string; value: string; options: Option[]; onChange(value: string): void; disabled?: boolean; compact?: boolean; onOpen?(): void
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const search = useRef({ text: '', time: 0 })
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [position, setPosition] = useState<Position>()
  const expanded = open && !disabled && options.length > 0
  const selected = options.findIndex(option => option.value === value)
  const show = () => {
    onOpen?.()
    setActive(Math.max(0, selected)); setOpen(true)
    search.current = { text: '', time: 0 }
  }
  const choose = (index: number) => {
    if (options[index]) onChange(options[index].value)
    setOpen(false)
  }

  // Render outside the scrolling settings card so the menu is never clipped by it.
  useLayoutEffect(() => {
    if (!expanded) return
    const update = () => {
      if (!trigger.current || !menu.current) return
      const rect = trigger.current.getBoundingClientRect()
      const viewport = document.documentElement
      const width = Math.min(compact ? Math.max(rect.width, 280) : rect.width, viewport.clientWidth - 16)
      // Measure wrapped options at their final width before positioning above the trigger.
      menu.current.style.width = `${width}px`
      const below = viewport.clientHeight - rect.bottom - 14
      const above = rect.top - 14
      const height = Math.min(280, menu.current.scrollHeight + 2)
      const upwards = below < height && above > below
      const maxHeight = Math.max(0, Math.min(280, upwards ? above : below))
      setPosition({
        left: Math.max(8, Math.min(compact ? rect.right - width : rect.left, viewport.clientWidth - width - 8)),
        top: upwards ? rect.top - 6 - Math.min(height, maxHeight) : rect.bottom + 6,
        width, maxHeight,
      })
    }
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) update() }
    update()
    const observer = new ResizeObserver(update)
    if (trigger.current) observer.observe(trigger.current)
    if (menu.current) observer.observe(menu.current)
    window.addEventListener('resize', update)
    document.addEventListener('scroll', scroll, true)
    return () => {
      window.removeEventListener('resize', update)
      document.removeEventListener('scroll', scroll, true)
      observer.disconnect()
    }
  }, [expanded, options.length, compact])

  useEffect(() => {
    if (!expanded) return
    const dismiss = (event: Event) => {
      const target = event.target as Node
      if (!trigger.current?.contains(target) && !menu.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('focusin', dismiss)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('focusin', dismiss)
    }
  }, [expanded])

  useEffect(() => {
    if (expanded) menu.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [expanded, active])

  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      if (!expanded) show()
      if (event.key === 'Home') setActive(0)
      else if (event.key === 'End') setActive(options.length - 1)
      else if (expanded) setActive(index => Math.max(0, Math.min(options.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))))
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (expanded) choose(active)
      else show()
      return
    }
    if (event.key === 'Escape' && expanded) {
      event.preventDefault(); event.stopPropagation(); setOpen(false)
      return
    }
    if (event.key === 'Tab' && expanded) choose(active)
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return
    event.preventDefault()
    const now = Date.now()
    const text = (now - search.current.time < 500 ? search.current.text : '') + event.key.toLowerCase()
    search.current = { text, time: now }
    const prefix = [...text].every(char => char === text[0]) ? text[0] : text
    const start = prefix.length === 1 ? (expanded ? active : selected) + 1 : 0
    const match = options.findIndex((_, offset) => options[(start + offset) % options.length].label.toLowerCase().startsWith(prefix))
    if (match < 0) return
    const index = (start + match) % options.length
    if (expanded) setActive(index)
    else onChange(options[index].value)
  }

  return <div className={`extension-field${compact ? ' select-compact' : ''}`}>
    <label id={`${id}-label`} className={compact ? 'sr-only' : undefined} htmlFor={id}>{label}</label>
    <button ref={trigger} id={id} type="button" role="combobox" className="select-trigger"
      aria-labelledby={`${id}-label`} aria-haspopup="listbox" aria-expanded={expanded}
      aria-controls={expanded ? `${id}-list` : undefined} aria-activedescendant={expanded ? `${id}-option-${active}` : undefined}
      disabled={disabled || !options.length} onKeyDown={keyDown} onClick={() => expanded ? setOpen(false) : show()}>
      <span>{options[selected]?.label ?? value}</span><ChevronDown size={15} aria-hidden="true" />
    </button>
    {expanded && createPortal(<div ref={menu} id={`${id}-list`} role="listbox" aria-labelledby={`${id}-label`}
      className="select-menu main-scroll" style={position ?? { visibility: 'hidden' }}>
      {options.map((option, index) => <div key={option.value} id={`${id}-option-${index}`} role="option"
        aria-selected={option.value === value} data-active={index === active} className="select-option"
        onPointerMove={() => setActive(index)} onPointerDown={event => event.preventDefault()} onClick={() => choose(index)}>
        <span>{option.label}</span>{option.value === value && <Check size={15} aria-hidden="true" />}
      </div>)}
    </div>, document.body)}
  </div>
}
