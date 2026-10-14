import { useEffect, useState } from 'react'

const jsonCache = new Map<string, unknown>()
const jsonInflight = new Map<string, Promise<unknown>>()

/** Fetches and caches a static JSON dataset, shared across every component that requests the same URL. */
export function useRemoteJson<T>(url: string | null, active = true): T | null {
  const [, forceRender] = useState(0)

  useEffect(() => {
    if (!url || !active || jsonCache.has(url)) return
    let cancelled = false
    if (!jsonInflight.has(url)) {
      jsonInflight.set(
        url,
        fetch(url)
          .then((response) => {
            if (!response.ok) throw new Error(`Request failed: ${response.status}`)
            return response.json()
          })
          .then((data) => {
            jsonCache.set(url, data)
            return data
          })
          .catch((error: unknown) => {
            console.error(error)
            return null
          }),
      )
    }
    inflightThen(url, () => {
      if (!cancelled) forceRender((value) => value + 1)
    })
    return () => {
      cancelled = true
    }
  }, [url, active])

  if (!url) return null
  return (jsonCache.get(url) as T | undefined) ?? null
}

function inflightThen(url: string, callback: () => void) {
  jsonInflight.get(url)?.then(callback)
}

const binaryCache = new Map<string, Float32Array>()
const binaryInflight = new Map<string, Promise<Float32Array | null>>()

/** Fetches and caches a static Float32Array binary buffer (e.g. line-segment geometry). */
export function useRemoteBinary(url: string | null, active = true): Float32Array | null {
  const [, forceRender] = useState(0)

  useEffect(() => {
    if (!url || !active || binaryCache.has(url)) return
    let cancelled = false
    if (!binaryInflight.has(url)) {
      binaryInflight.set(
        url,
        fetch(url)
          .then((response) => {
            if (!response.ok) throw new Error(`Request failed: ${response.status}`)
            return response.arrayBuffer()
          })
          .then((buffer) => {
            const array = new Float32Array(buffer)
            binaryCache.set(url, array)
            return array
          })
          .catch((error: unknown) => {
            console.error(error)
            return null
          }),
      )
    }
    binaryInflight.get(url)?.then(() => {
      if (!cancelled) forceRender((value) => value + 1)
    })
    return () => {
      cancelled = true
    }
  }, [url, active])

  if (!url) return null
  return binaryCache.get(url) ?? null
}
