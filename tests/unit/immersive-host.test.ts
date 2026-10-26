import { describe, expect, it } from 'vitest'
import { canHostInventedSystem } from '../../src/modules/immersive/index'

/**
 * Which stars may have a system invented for them.
 *
 * The whole of immersive mode rests on invented worlds being unmistakable for measured
 * ones, and this is the function that decides where invention is allowed to happen at
 * all. The Sun is the case that matters: the atlas holds it three times over — `sun` in
 * the helio layer with real planets around it, `sun-galactic` as the galaxy module's
 * "you are here" marker, and Sol again inside the star catalogue — and every one of them
 * is `objectClass: 'star'`. A check on the class alone put "The Sun b" next to Mercury.
 */

const star = (over: Partial<{ objectClass: string; layer: string }> = {}) => ({
  objectClass: 'star',
  layer: 'stellar',
  ...over,
})

describe('canHostInventedSystem', () => {
  it('allows a catalogue star with nothing orbiting it', () => {
    expect(canHostInventedSystem(star(), false)).toBe(true)
  })

  it('refuses a star that already has something orbiting it', () => {
    // The Sun by its second route, and the rule that stays right when the atlas gains a
    // real exoplanet catalogue: a star with measured planets never also sprouts invented
    // ones.
    expect(canHostInventedSystem(star(), true)).toBe(false)
  })

  it('refuses the Sun in the helio layer and its galactic marker', () => {
    expect(canHostInventedSystem(star({ layer: 'helio' }), false)).toBe(false)
    expect(canHostInventedSystem(star({ layer: 'galactic' }), false)).toBe(false)
  })

  it('refuses anything that is not a star', () => {
    for (const objectClass of ['planet', 'moon', 'galaxy', 'nebula', 'black-hole']) {
      expect(canHostInventedSystem(star({ objectClass }), false)).toBe(false)
    }
  })
})
