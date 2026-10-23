import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADING_FACTS, loadingFact } from '../../src/ui/loadingFacts'
import { R0_KPC } from '../../src/astronomy/galaxy'

/**
 * The loading screen's facts, checked against the files they claim to describe.
 *
 * An atlas whose whole claim is sourced truth cannot show invented trivia on its own
 * loading screen, and a fact card is precisely where a plausible wrong number would
 * never be noticed: nobody re-reads the splash. These re-derive the counted figures
 * from the same manifests the renderer reads, so a catalogue rebuild that changes a
 * total fails here rather than quietly making the page wrong.
 */

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public')
const read = (p: string) => JSON.parse(fs.readFileSync(path.join(PUBLIC, p), 'utf8'))

/** Every number appearing in a fact, with separators stripped: "329,860" -> 329860. */
function numbersIn(text: string): number[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, '')))
}

describe('loading facts', () => {
  it('all carry a source, because a number without one is the thing this project refuses', () => {
    expect(LOADING_FACTS.length).toBeGreaterThan(0)
    for (const fact of LOADING_FACTS) {
      expect(fact.source.trim().length, `"${fact.text.slice(0, 40)}..." has no source`).toBeGreaterThan(4)
      expect(fact.text.trim().length).toBeGreaterThan(40)
      // Long enough to be the largest paint, short enough not to reflow the card.
      expect(fact.text.length, `"${fact.text.slice(0, 40)}..." is too long for the card`).toBeLessThan(230)
    }
  })

  it('states the star total the three tier manifests actually sum to', () => {
    const total =
      read('data/stars/l0.json').recordCount +
      read('data/stars/l1.json').recordCount +
      read('data/stars/l2/index.json').recordCount

    const fact = LOADING_FACTS.find((f) => f.text.includes('real stars'))
    expect(fact, 'the star fact was renamed; update this test with it').toBeDefined()
    expect(numbersIn(fact!.text)).toContain(total)
  })

  it('states the 2MRS counts the manifest publishes', () => {
    const stats = read('data/universe/2mrs.json').statistics as {
      withRedshift: number
      withoutRedshift: number
    }
    const fact = LOADING_FACTS.find((f) => f.text.includes('2MASS Redshift Survey'))
    expect(fact, 'the 2MRS fact was renamed; update this test with it').toBeDefined()

    const numbers = numbersIn(fact!.text)
    // The total it quotes, and the count it says is NOT drawn. The second is the point
    // of the fact: a survey row with no redshift has no honest distance, so it is left
    // out rather than placed somewhere plausible.
    expect(numbers).toContain(stats.withRedshift + stats.withoutRedshift)
    expect(numbers).toContain(stats.withoutRedshift)
  })

  it('states the galactocentric radius the renderer actually uses', () => {
    const fact = LOADING_FACTS.find((f) => f.text.includes('kiloparsec'))
    expect(fact, 'the galactic centre fact was renamed; update this test with it').toBeDefined()
    expect(numbersIn(fact!.text)).toContain(R0_KPC)
  })

  it('wraps the index, so a stale one cannot blank the card', () => {
    expect(loadingFact(0)).toBe(LOADING_FACTS[0])
    expect(loadingFact(LOADING_FACTS.length)).toBe(LOADING_FACTS[0])
    expect(loadingFact(-1)).toBe(LOADING_FACTS[1 % LOADING_FACTS.length])
    expect(loadingFact(1.9)).toBe(LOADING_FACTS[1 % LOADING_FACTS.length])
  })
})
