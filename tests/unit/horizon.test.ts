import type * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { Engine } from '../../src/core/Engine'
import { HorizonModule } from '../../src/modules/horizon'
import { MPC_M } from '../../src/core/world'
import { Z_LAST_SCATTERING, angularDiameterDistanceMpc, comovingDistanceMpc } from '../../src/astronomy/cosmology'

/**
 * The only boundary in this atlas whose radius is genuinely known.
 *
 * Which makes the tests here the opposite of the Oort cloud's: there, the job was to
 * stop the picture claiming more than the data supports. Here the number is solid to
 * better than a percent and the thing that needs guarding is the WORD "distance",
 * because the same surface is 45 billion light years away and was 41 million light
 * years away, and both are true.
 */

function boot(): { engine: Engine; module: HorizonModule } {
  const engine = new Engine({ renderer: {} as never })
  const module = new HorizonModule()
  module.init(engine)
  return { engine, module }
}

const GLY_PER_MPC = 3.2615638e-3

describe('the numbers', () => {
  it('puts the horizon and the microwave background where Planck 2018 puts them', () => {
    const { module } = boot()
    const m = module.manifest
    // 46.14 and 45.22 Gly. If these move, either the cosmology changed or the
    // integration broke; both are worth a failing test.
    expect(m.particleHorizonMpc * GLY_PER_MPC).toBeCloseTo(46.14, 1)
    expect(m.lastScatteringMpc * GLY_PER_MPC).toBeCloseTo(45.22, 1)
    module.dispose?.()
  })

  it('keeps the microwave background inside the horizon, by the width of the opaque era', () => {
    const { module } = boot()
    const ratio = module.manifest.lastScatteringMpc / module.manifest.particleHorizonMpc
    // 2%: the 380,000 years between the Big Bang and the moment light got free. If
    // this ever reaches 1, the module has conflated the two surfaces.
    expect(ratio).toBeGreaterThan(0.95)
    expect(ratio).toBeLessThan(0.995)
    module.dispose?.()
  })

  it('agrees with the cosmology module it is reading from', () => {
    const { module } = boot()
    // Not an independent check — a wiring check. The module must not be carrying its
    // own copy of a number that lives in src/astronomy/cosmology.ts.
    expect(module.manifest.lastScatteringMpc).toBeCloseTo(comovingDistanceMpc(Z_LAST_SCATTERING), 6)
    expect(module.manifest.emissionDistanceMpc).toBeCloseTo(angularDiameterDistanceMpc(Z_LAST_SCATTERING), 6)
    module.dispose?.()
  })
})

describe('what it refuses to say', () => {
  it('will not state one distance for a surface that has two', () => {
    const { engine, module } = boot()
    const node = engine.node('horizon:cmb') as { provenanceNote?: string } | null
    // The comoving distance and the distance at emission differ by ~1000x. Quoting
    // either alone, unqualified, would be the most confidently wrong number here.
    expect(node?.provenanceNote).toMatch(/COMOVING/)
    expect(node?.provenanceNote).toMatch(/million\s+light years away/)
    module.dispose?.()
  })

  it('says it is a limit of sight, not an edge of anything', () => {
    const { engine, module } = boot()
    const cmb = engine.node('horizon:cmb') as { caveat?: string } | null
    expect(cmb?.caveat).toMatch(/Not an edge of the universe/i)
    module.dispose?.()
  })

  it('reports no radius, because this is not a body', () => {
    const { engine, module } = boot()
    for (const id of ['horizon:cmb', 'horizon:particle']) {
      expect(engine.node(id)?.radiusMetres, id).toBe(0)
      // It still has to be flyable, and the framing is the known radius.
      expect(engine.node(id)?.framingRadiusMetres, id).toBeGreaterThan(1e3 * MPC_M)
    }
    module.dispose?.()
  })

  it('calls the distances derived, because they are integrated from the measurements', () => {
    const { engine, module } = boot()
    const node = engine.node('horizon:particle') as { provenance?: string } | null
    // cosmology.json: "MEASURED (parameters) / DERIVED (distances computed from them)".
    expect(node?.provenance).toBe('derived')
    module.dispose?.()
  })
})

describe('the drawing', () => {
  function shells(engine: Engine): THREE.LineSegments[] {
    const found: THREE.LineSegments[] = []
    engine.layer('cosmic').scene.traverse((object) => {
      if (object.name.startsWith('horizon:')) found.push(object as THREE.LineSegments)
    })
    return found
  }

  it('keeps the vertex buffer at unit scale and puts the radius in the matrix', () => {
    const { engine, module } = boot()
    const drawn = shells(engine)
    expect(drawn.length).toBe(2)
    for (const mesh of drawn) {
      const position = mesh.geometry.getAttribute('position').array as Float32Array
      let largest = 0
      for (const value of position) largest = Math.max(largest, Math.abs(value))
      // A 14,145 Mpc radius written into a vertex buffer is well past the ~1e4 bound
      // Layer.ts states. It goes in the scale instead, which three.js applies on the
      // CPU in doubles.
      expect(largest).toBeLessThanOrEqual(1.0001)
      expect(mesh.scale.x).toBeGreaterThan(1e3)
    }
    module.dispose?.()
  })

  it('draws the two shells at different radii', () => {
    const { engine, module } = boot()
    const radii = shells(engine).map((mesh) => mesh.scale.x).sort((a, b) => a - b)
    expect(radii[0]).toBeLessThan(radii[1])
    module.dispose?.()
  })

  it('gives everything back on dispose', () => {
    const { engine, module } = boot()
    module.dispose?.()
    expect(shells(engine).length).toBe(0)
    expect(engine.registry.has('horizon:cmb')).toBe(false)
  })
})
