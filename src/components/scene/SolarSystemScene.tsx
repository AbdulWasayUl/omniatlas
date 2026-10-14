import { Html, Line, Stars } from '@react-three/drei'
import { useMemo } from 'react'
import * as THREE from 'three'
import { calculateSolarSystemEphemeris, sampleHeliocentricOrbitPath } from '../../astronomy/ephemeris'
import { DWARF_PLANETS, MOONS, NOTABLE_SMALL_BODIES, PLANETS, auToUnits } from '../../data/catalog'
import { MOON_COLORS } from '../../data/moons'
import type { AtlasEntity } from '../../data/types'
import { useExplorerStore } from '../../store/useExplorerStore'
import { AsteroidBelt } from './AsteroidBelt'
import { EarthBody } from './EarthBody'
import { MoonBody } from './MoonBody'
import { MoonMesh } from './MoonMesh'
import { PlanetBody } from './PlanetBody'
import { SunBody } from './SunBody'

function OrbitPath({
  planet,
  referenceDate,
  distanceMode,
  color,
  opacity,
}: {
  planet: AtlasEntity
  referenceDate: Date
  distanceMode: 'exploration' | 'physical'
  color: string
  opacity: number
}) {
  const points = useMemo(
    () => sampleHeliocentricOrbitPath(planet, referenceDate, distanceMode),
    // referenceDate is intentionally excluded — an orbit's shape doesn't change
    // meaningfully within a session, and resampling ~180 points per body every
    // time the clock ticks would be wasted work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [planet, distanceMode],
  )
  if (points.length < 2) return null

  return <Line points={points} color={color} lineWidth={0.6} transparent opacity={opacity} depthWrite={false} />
}

export function SolarSystemScene() {
  const distanceMode = useExplorerStore((state) => state.distanceMode)
  const simulationTimeMs = useExplorerStore((state) => state.simulationTimeMs)
  const focus = useExplorerStore((state) => state.focus)
  const focusOn = useExplorerStore((state) => state.focusOn)
  const showOrbits = useExplorerStore((state) => state.showOrbits)
  const physical = distanceMode === 'physical'

  const ephemeris = useMemo(
    () => calculateSolarSystemEphemeris(new Date(simulationTimeMs), distanceMode),
    [simulationTimeMs, distanceMode],
  )
  const referenceDate = useMemo(() => new Date(), [])

  const sunState = ephemeris.bodies.get('sun')!
  const starRadius = physical ? Math.max(400, auToUnits(45)) : 220

  const orbitBodies = [...PLANETS, ...DWARF_PLANETS]

  return (
    <>
      <color attach="background" args={['#020305']} />
      {!physical && <fog attach="fog" args={['#020305', 260, 620]} />}
      <Stars radius={starRadius} depth={physical ? starRadius * 0.3 : 90} count={4000} factor={2.4} saturation={0.05} fade speed={0} />

      <ambientLight intensity={0.24} color="#7d91aa" />
      {/* A point light at the Sun's position gives every planet a correct terminator regardless
          of its direction from the Sun. `decay={0}` keeps distant planets clearly visible instead
          of physically-accurate-but-unusably-dark — a deliberate readability choice, not a claim
          about true irradiance. */}
      <pointLight position={sunState.position} intensity={10} decay={0} color="#fff1d9" />

      <group position={sunState.position} quaternion={sunState.quaternion}>
        <SunBody radius={sunState.radiusUnits} />
      </group>

      {orbitBodies.map((planet) => {
        const state = ephemeris.bodies.get(planet.id)
        if (!state) return null
        return (
          <group key={planet.id} position={state.position} quaternion={state.quaternion}>
            {planet.id === 'earth' ? (
              <EarthBody />
            ) : (
              <PlanetBody planet={planet} radiusUnits={state.radiusUnits} />
            )}
          </group>
        )
      })}

      {ephemeris.bodies.get('moon') && (
        <group position={ephemeris.bodies.get('moon')!.position} quaternion={ephemeris.bodies.get('moon')!.quaternion}>
          <MoonBody radiusUnits={ephemeris.bodies.get('moon')!.radiusUnits} />
        </group>
      )}

      {MOONS.filter((moon) => moon.id !== 'moon').map((moon) => {
        const state = ephemeris.bodies.get(moon.id)
        if (!state) return null
        return (
          <group key={moon.id} position={state.position} quaternion={state.quaternion}>
            <MoonMesh moon={moon} radiusUnits={state.radiusUnits} color={MOON_COLORS[moon.id]} />
          </group>
        )
      })}

      {NOTABLE_SMALL_BODIES.map((body) => {
        const state = ephemeris.bodies.get(body.id)
        if (!state) return null
        return (
          <group key={body.id} position={state.position} quaternion={state.quaternion}>
            <MoonMesh moon={body} radiusUnits={state.radiusUnits} color="#9c8f7a" />
          </group>
        )
      })}

      <AsteroidBelt />

      {showOrbits &&
        orbitBodies.map((planet) => (
          <OrbitPath
            key={`orbit-${planet.id}`}
            planet={planet}
            referenceDate={referenceDate}
            distanceMode={distanceMode}
            color={planet.kind === 'dwarf-planet' ? '#9d84c9' : '#5d6b74'}
            opacity={planet.kind === 'dwarf-planet' ? 0.28 : 0.18}
          />
        ))}

      {focus === 'system' && (
        <>
          <BodyLocator id="sun" label="Sun" position={sunState.position} onFocus={focusOn} />
          {orbitBodies.map((planet) => {
            const state = ephemeris.bodies.get(planet.id)
            if (!state) return null
            return (
              <BodyLocator key={planet.id} id={planet.id} label={planet.name} position={state.position} onFocus={focusOn} />
            )
          })}
        </>
      )}
    </>
  )
}

function BodyLocator({
  id,
  label,
  position,
  onFocus,
}: {
  id: string
  label: string
  position: THREE.Vector3
  onFocus: (id: string) => void
}) {
  return (
    <group position={position}>
      <Html center zIndexRange={[6, 2]}>
        <button type="button" className="physical-body-label" onClick={() => onFocus(id)}>
          <i aria-hidden="true" />
          {label}
        </button>
      </Html>
    </group>
  )
}
