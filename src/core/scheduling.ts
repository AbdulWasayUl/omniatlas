/**
 * Breaking long decodes into slices the browser can interrupt.
 *
 * A catalogue decode is a tight loop over a few hundred thousand records. It allocates
 * almost nothing and it is about as fast as JavaScript gets, and it is still a problem,
 * because it runs to completion before the browser can do anything else. Anything over
 * 50 ms is a "long task": it blocks input, it blocks paint, and Total Blocking Time is
 * the sum of everything past that threshold.
 *
 * Slicing does not make the work smaller. It makes it interruptible, which is the thing
 * that was actually wrong. Measured on a desktop, the 282,103-record L2 star decode is
 * one 54 ms task; a phone CPU is roughly four to six times slower, which puts the same
 * loop around 250-300 ms and most of the 430 ms that Lighthouse reported.
 *
 * The threshold is what to aim at: slices are sized so each one stays comfortably under
 * 50 ms on a slow device, not so each is fast on a fast one.
 */

/**
 * Hand control back to the browser, preferring the scheduler when it exists.
 *
 * `scheduler.yield()` resumes at a higher priority than a fresh task, so a sliced decode
 * does not lose its place behind every timer the page has queued. `setTimeout(0)` is the
 * fallback and is clamped to about 4 ms by every browser, which is why slices are as
 * large as they are: at 32 slices that clamp alone would add 128 ms to the decode.
 */
function yieldToBrowser(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (typeof scheduler?.yield === 'function') return scheduler.yield()
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Run `each` over every item, yielding to the browser between slices.
 *
 * `perSlice` is in ITEMS, and the caller picks it from how much work one item is: the
 * star tier slices by HEALPix chunk, where one chunk is about 1,470 records, so sixteen
 * chunks is roughly 23,000 records and a few milliseconds even on a slow phone.
 *
 * `shouldStop` is checked at every slice boundary. A decode that yields can outlive the
 * thing that started it — React StrictMode unmounts and remounts every effect in
 * development, and a user can navigate away mid-boot — and without this the continuation
 * would go on filling buffers belonging to a disposed engine.
 */
export async function forEachSlice<T>(
  items: readonly T[],
  perSlice: number,
  each: (item: T, index: number) => void,
  shouldStop?: () => boolean,
): Promise<boolean> {
  const size = Math.max(1, Math.trunc(perSlice))
  for (let start = 0; start < items.length; start += size) {
    if (shouldStop?.()) return false
    const end = Math.min(start + size, items.length)
    for (let i = start; i < end; i++) each(items[i], i)
    // Not after the last slice: that yield buys nothing and delays the result by a task.
    if (end < items.length) await yieldToBrowser()
  }
  return !shouldStop?.()
}
