import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react'
import type { Bot, Conversation, Id } from '@shared/domain'
import { errorMessage } from './bridge'
import { useData } from '../store/data'
import { useUi } from '../store/ui'

export interface AsyncState<T> {
  data: T | undefined
  error: string | undefined
  loading: boolean
  reload: () => void
  setData: (data: T) => void
}

/** Run an async loader when deps change; keeps the previous data while reloading. */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    setLoading(true)
    fn().then(
      (value) => {
        if (!alive) return
        setData(value)
        setError(undefined)
        setLoading(false)
      },
      (err: unknown) => {
        if (!alive) return
        setError(errorMessage(err))
        setLoading(false)
      }
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, error, loading, reload, setData }
}

export function useCurrentConversation(): Conversation | undefined {
  const route = useUi((s) => s.route)
  return useData((s) => (route.kind === 'conversation' ? s.conversations.find((c) => c.id === route.id) : undefined))
}

export function useBot(id: Id | undefined | null): Bot | undefined {
  return useData((s) => (id ? s.botMap.get(id) : undefined))
}

/** Value that only changes after `ms` of quiet. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/** Cycle through phrases every `ms` while `items` stays the same list. */
export function useRotating(items: string[], ms = 3200): string | undefined {
  const [i, setI] = useState(0)
  const key = items.join('|')
  useEffect(() => {
    setI(0)
    if (items.length < 2) return
    const t = setInterval(() => setI((n) => n + 1), ms)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ms])
  return items.length ? items[i % items.length] : undefined
}

/** Local editable copy of a value that resets when the source changes (e.g. another bot). */
export function useDraftValue<T>(source: T, resetKey: unknown): [T, (v: T) => void, boolean] {
  const [value, setValue] = useState(source)
  const sourceRef = useRef(source)
  useEffect(() => {
    sourceRef.current = source
    setValue(source)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])
  return [value, setValue, value !== source]
}
