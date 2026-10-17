import * as THREE from 'three'

/**
 * A rendered celestial body.
 *
 * Replaces the three near-duplicate components the old scene carried (`PlanetBody`,
 * `MoonBody`, `MoonMesh`). One data-driven renderable covers all of them, and because
 * every body shares a single unit-radius geometry scaled per instance, adding bodies
 * costs a draw call rather than a megabyte of vertices.
 */

export interface SphereBodySpec {
  id: string
  /** Radius in the host layer's render units. This is the body's MEAN radius. */
  radius: number
  /** Equirectangular colour map. */
  textureUrl?: string
  /** Fallback colour when no texture is supplied or it fails to load. */
  color?: string
  /** Emissive bodies (the Sun) skip lighting entirely. */
  emissive?: boolean
  /** Linear emissive strength; values above 1 are what the bloom threshold selects on. */
  emissiveIntensity?: number
  /**
   * Apply the photosphere's limb-darkening law. Only meaningful on an emissive body:
   * a star is a glowing volume, not a lit surface, so no light in the scene gives it
   * a view-angle term and without this it renders as a flat sticker.
   */
  limbDarkened?: boolean
  /** Rim-light atmosphere colour. Omit for airless bodies. */
  atmosphereColor?: string
  /** Atmosphere shell radius as a multiple of the body radius. */
  atmosphereScale?: number
  /**
   * A star's aureole, drawn as an additive shell out to this multiple of the radius.
   * Only meaningful on an emissive body. See `coronaMaterial`.
   */
  coronaScale?: number
  coronaColor?: string
  /** Peak radiance of the aureole at the limb, in the same linear units as the disc. */
  coronaIntensity?: number
  /**
   * Polar radius divided by equatorial radius. The squash is applied about the MEAN
   * radius, so `radius` keeps meaning what every other consumer of it thinks it means
   * (arrival distance, the approach floor, label size, the proxy sphere) and only the
   * drawn shape changes.
   */
  polarRatio?: number
  /**
   * Base colour for the parts of `textureUrl` that carry no observation.
   *
   * Several USGS mosaics cover only the hemisphere a flyby actually imaged — Voyager 2
   * saw Triton's southern half and Titania's southern half, and the rest of each map is
   * encoded as pure black. Rendered literally, those bodies are a black ball with a
   * lit crescent. Set this to the body's measured mean albedo colour and the unimaged
   * region is filled flat, with no invented terrain in it.
   */
  unimagedFill?: string
  /**
   * Soft gain on the colour map, for a mosaic whose exposure does not match the body's
   * measured albedo. See `surfaceShader`.
   */
  mapGain?: number
  /** Haze colour for a body whose atmosphere is opaque in visible light (Titan). */
  hazeColor?: string
  /** How much of the surface map survives the haze. 0 is a featureless disc. */
  hazeMix?: number
  /** Translucent cloud deck, drawn as a thin second shell. Luminance is the coverage. */
  cloudTextureUrl?: string
  /** Greyscale elevation map, used as relief shading near the terminator. */
  bumpMapUrl?: string
  bumpScale?: number
  /** Ring texture (Saturn, Uranus). */
  ringTextureUrl?: string
  ringInnerScale?: number
  ringOuterScale?: number
  /** Segment count override; defaults scale with apparent importance. */
  segments?: number
}

/**
 * Unit spheres, one per segment count, reused by every body in the atlas.
 *
 * Keyed rather than single-slot: bodies are built at 96, 64 and 48 segments, and a
 * single slot disposed itself every time the count changed, leaving every mesh built
 * before the change pointing at a disposed geometry that the renderer then had to
 * re-upload on the next frame that drew it.
 */
const sharedSpheres = new Map<number, THREE.SphereGeometry>()
function unitSphere(segments: number): THREE.SphereGeometry {
  let geometry = sharedSpheres.get(segments)
  if (!geometry) {
    geometry = new THREE.SphereGeometry(1, segments, segments / 2)
    sharedSpheres.set(segments, geometry)
  }
  return geometry
}

const textureLoader = new THREE.TextureLoader()
const textureCache = new Map<string, THREE.Texture>()

function loadTexture(
  url: string,
  colorSpace: THREE.ColorSpace = THREE.SRGBColorSpace,
  wrapS: THREE.Wrapping = THREE.RepeatWrapping,
): THREE.Texture {
  // The key must name every texture property this function sets, not just the URL:
  // the ring map goes through this same function and needs the opposite wrapping, and
  // the bump and alpha maps need the sRGB decode off. A key that omits either would
  // hand whichever caller got there first its settings to everyone else.
  const key = `${url}|${wrapS}|${colorSpace}`
  const hit = textureCache.get(key)
  if (hit) return hit
  const texture = textureLoader.load(url)
  texture.colorSpace = colorSpace
  texture.anisotropy = 8
  // u runs 0 -> 1 exactly once round an equirectangular map, so its first and last
  // columns are geographic neighbours. Clamping blends the edge column with itself and
  // leaves a step down the antimeridian that widens as you descend toward the surface
  // (5,828 pixels of it at 1.05 body radii). v is a real edge: leave it clamped.
  texture.wrapS = wrapS
  texture.wrapT = THREE.ClampToEdgeWrapping
  textureCache.set(key, texture)
  return texture
}

/** Shader fragments injected into a body's surface material, with their cache key. */
interface SurfaceShader {
  key: string
  uniforms: Record<string, THREE.IUniform>
  vertexCommon: string
  vertexBody: string
  fragmentCommon: string
  /** Runs immediately after `<map_fragment>`, on `diffuseColor`. */
  afterMap: string
  /** Runs after `<lights_fragment_end>`, on `reflectedLight`. */
  afterLights: string
}

/**
 * Build the per-body additions to three's standard surface shader.
 *
 * Everything that modifies a body's surface goes through this one composer and one
 * `onBeforeCompile`. An earlier version assigned `onBeforeCompile` per feature, which
 * silently dropped whichever feature was installed first — the fill and the haze can
 * land on the same body, and the ring shadow lands on top of both.
 */
function surfaceShader(spec: SphereBodySpec): SurfaceShader | null {
  const parts: SurfaceShader = {
    key: '',
    uniforms: {},
    vertexCommon: '',
    vertexBody: '',
    fragmentCommon: 'const vec3 kLuma = vec3(0.2126, 0.7152, 0.0722);\n',
    afterMap: '',
    afterLights: '',
  }
  let used = false

  if (spec.mapGain && spec.mapGain !== 1) {
    used = true
    parts.key += `gain:${spec.mapGain}|`
    parts.uniforms.uMapGain = { value: spec.mapGain }
    parts.fragmentCommon += 'uniform float uMapGain;\n'
    // A soft gain, not a multiply. Voyager's Triton mosaic is exposed about 2.5 stops
    // under the moon's measured albedo, so the imaged half and the flat unimaged fill
    // beside it read as two different objects. A straight multiply fixes the mean and
    // clips the bright nitrogen frost; 1 - exp(-g*c) matches the mean, is monotone and
    // never reaches 1, so the frost keeps its structure. The absolute level of an
    // uncalibrated mosaic is arbitrary anyway; the albedo it is being matched to is not.
    parts.afterMap += 'diffuseColor.rgb = 1.0 - exp(-uMapGain * diffuseColor.rgb);\n'
  }

  if (spec.unimagedFill && spec.textureUrl) {
    used = true
    parts.key += `unimaged:${spec.unimagedFill}|`
    parts.uniforms.uUnimagedFill = {
      value: new THREE.Color(spec.unimagedFill).convertSRGBToLinear(),
    }
    parts.fragmentCommon += 'uniform vec3 uUnimagedFill;\n'
    // Erode the coverage boundary by a couple of texels before testing it.
    //
    // The test itself is on decoded linear luminance, with the threshold under the
    // darkest real terrain in these maps and above the no-data black. What it could
    // not see is the one-to-two-texel ring of JPEG ringing the mosaic edge leaves at
    // sRGB 24-100 — well above the window, so it survived and drew as a hard dark
    // outline around the imaged patch, which reads as a rendering bug rather than as
    // a coverage boundary. Taking the darkest of a small cross erodes the imaged
    // region by the sample radius and takes the ring with it. Both partial mosaics in
    // the atlas (Triton, Titania) are 1440x720; a differently sized one would want a
    // different offset here.
    parts.afterMap += `
      vec2 fillStep = vec2(1.5 / 1440.0, 1.5 / 720.0);
      float cover = dot(texture2D(map, vMapUv).rgb, kLuma);
      cover = min(cover, dot(texture2D(map, vMapUv + vec2(fillStep.x, 0.0)).rgb, kLuma));
      cover = min(cover, dot(texture2D(map, vMapUv - vec2(fillStep.x, 0.0)).rgb, kLuma));
      cover = min(cover, dot(texture2D(map, vMapUv + vec2(0.0, fillStep.y)).rgb, kLuma));
      cover = min(cover, dot(texture2D(map, vMapUv - vec2(0.0, fillStep.y)).rgb, kLuma));
      diffuseColor.rgb = mix(uUnimagedFill, diffuseColor.rgb, smoothstep(0.0006, 0.004, cover));
    `
  }

  if (spec.hazeColor) {
    used = true
    const mix = spec.hazeMix ?? 0.12
    parts.key += `haze:${spec.hazeColor}:${mix}|`
    parts.uniforms.uHazeColor = { value: new THREE.Color(spec.hazeColor).convertSRGBToLinear() }
    parts.uniforms.uHazeMix = { value: mix }
    parts.fragmentCommon += 'uniform vec3 uHazeColor;\nuniform float uHazeMix;\n'
    // Titan's visible-light appearance is an opaque orange haze with essentially no
    // contrast in it; the shipped map is the Cassini radar/ISS SURFACE mosaic, which
    // no eye has ever seen and which carries hard rectangular tile seams. Keeping it
    // as a faint luminance detail under flat haze is closer to the truth than either
    // the raw mosaic or a bare colour, and it is what hides the seams — a tint alone
    // leaves every tile edge fully visible, in orange.
    parts.afterMap += 'diffuseColor.rgb = mix(uHazeColor, diffuseColor.rgb * uHazeColor, uHazeMix);\n'
  }

  if (spec.ringTextureUrl) {
    used = true
    const ratio = spec.polarRatio ?? 1
    const inner = spec.ringInnerScale ?? 1.24
    const outer = spec.ringOuterScale ?? 2.27
    parts.key += `ringshadow:${inner}:${outer}:${ratio}|`
    parts.uniforms.uSunBody = { value: new THREE.Vector3(1, 0, 0) }
    parts.uniforms.uRingMap = {
      value: loadTexture(spec.ringTextureUrl, THREE.SRGBColorSpace, THREE.ClampToEdgeWrapping),
    }
    parts.vertexCommon += 'varying vec3 vBodyPos;\n'
    // The body's position in its own frame, in equatorial radii: the unit sphere with
    // the oblate squash put back, so the ring radii below are the same numbers the
    // ring geometry was built from.
    parts.vertexBody += `vBodyPos = vec3(transformed.x, transformed.y * ${ratio.toFixed(6)}, transformed.z);\n`
    parts.fragmentCommon += 'uniform vec3 uSunBody;\nuniform sampler2D uRingMap;\nvarying vec3 vBodyPos;\n'
    // The ring's shadow on the globe, closed-form: no shadow map is needed for a
    // sphere under a coplanar annulus. Trace the sun ray from the surface point to the
    // ring plane (the body's equator, y = 0 in body coordinates) and read the ring's
    // opacity at the radius it crosses.
    //
    // The texture's alpha is the ring's NORMAL opacity, and the shadow follows the
    // slant path tau/mu0. At the current 7.9-degree ring opening that path is seven
    // times the normal one, so alpha 0.27 blocks about 90% of the light, not 27% — a
    // plain (1 - alpha) paints a washed-out shadow exactly when the real one is at its
    // most dramatic. Only the direct irradiance is attenuated; the ambient fill is
    // left alone so the shadowed band darkens rather than going black.
    parts.afterLights += `
      float ringShadow = 1.0;
      float sunY = uSunBody.y;
      if (abs(sunY) > 1e-4) {
        float travel = -vBodyPos.y / sunY;
        if (travel > 0.0) {
          float hitRadius = length(vBodyPos.xz + travel * uSunBody.xz);
          float ringU = (hitRadius - ${inner.toFixed(5)}) / ${(outer - inner).toFixed(5)};
          if (ringU > 0.0 && ringU < 1.0) {
            float tauAlpha = texture2D(uRingMap, vec2(ringU, 0.5)).a;
            ringShadow = pow(max(1.0 - tauAlpha, 1e-4), 1.0 / max(abs(sunY), 0.02));
          }
        }
      }
      reflectedLight.directDiffuse *= ringShadow;
      reflectedLight.directSpecular *= ringShadow;
    `
  }

  return used ? parts : null
}

function installSurfaceShader(material: THREE.MeshStandardMaterial, parts: SurfaceShader): void {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, parts.uniforms)
    if (parts.vertexCommon) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${parts.vertexCommon}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${parts.vertexBody}`)
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${parts.fragmentCommon}`)
    if (parts.afterMap) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <map_fragment>', `#include <map_fragment>\n${parts.afterMap}`)
    }
    if (parts.afterLights) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${parts.afterLights}`)
    }
  }
  // Two materials that differ only in these uniforms must not share a compiled program.
  material.customProgramCacheKey = () => parts.key
}

/**
 * Reciprocal of the shipped sun map's mean linear luminance.
 *
 * `/textures/planets/sun.jpg` is a false-colour SDO rendition: measured over the whole
 * map its mean linear RGB is (0.896, 0.296, 0.050) — sRGB ~(247, 150, 63), a pumpkin.
 * Its CHROMA is an artist's choice and carries no information; its LUMINANCE is real
 * granulation and spot structure. Dividing that luminance by its own mean turns the
 * map into a dimensionless contrast factor that sits at 1.0 over average photosphere,
 * which is what lets the disc's absolute radiance be set by physics below instead of
 * by whatever exposure the image happened to be saved at. A different star map would
 * want this re-measured.
 */
const SUN_MAP_LUMA_NORM = 1 / 0.4059

/**
 * The photosphere: absolute radiance, limb darkening, limb reddening.
 *
 * Three things were wrong with drawing a star as a textured ball. A star is not a lit
 * surface, so nothing in the scene gives it a view-angle term and `MeshBasicMaterial`
 * has none of its own — the flat "sticker" look. The shipped map is false-colour, so
 * its orange carried straight through to the screen. And the disc's radiance came out
 * at a scene-linear luma of 0.68 against PostStack's 1.9 bloom threshold, so the one
 * object in the atlas that should glare was the only bright thing in frame that could
 * not reach the bright pass at all: measured, the 25 pixels outside the limb were
 * black while background stars a thousandth its size had visible halos.
 *
 * So: the map supplies contrast only (see `SUN_MAP_LUMA_NORM`), the material colour
 * supplies the photosphere's own 5,772 K white-gold and its absolute level, and the
 * level is chosen to sit a factor of ~4 over the bloom threshold so the disc saturates
 * and the glare is produced by the tone mapper rather than painted on.
 *
 * The law is the standard V-band Eddington fit, I(mu)/I(1) = 0.30 + 0.93mu - 0.23mu^2,
 * reaching 0.30 at the extreme limb, with the limb reddening that comes with it: at
 * grazing angles the line of sight only reaches the cooler upper photosphere. Because
 * the centre is driven deep into AgX's shoulder and the limb is not, the law is also
 * what keeps the disc from reading as a white sticker — the granulation survives in
 * the outer third, where the curve still has slope.
 *
 * Everything here is applied to `diffuseColor`, i.e. in linear space before tone
 * mapping, not to the encoded output. `normal` is available even though meshbasic
 * never uses it — three's default vertex prefix always declares the attribute — but
 * the varying has to be declared in both stages by hand or it will not link.
 */
function applyLimbDarkening(material: THREE.MeshBasicMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLimbN;\nvarying vec3 vLimbV;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvLimbN = normalize(normalMatrix * normal);\nvLimbV = -(modelViewMatrix * vec4(transformed, 1.0)).xyz;',
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLimbN;\nvarying vec3 vLimbV;')
      // Replaces `<map_fragment>` rather than following it: three's chunk multiplies
      // the texel in as a colour, and taking only its luminance is the whole point.
      .replace(
        '#include <map_fragment>',
        `
        #ifdef USE_MAP
          // sqrt halves the map's contrast in log space. Its range is 0 to 1 about a
          // mean of 0.41, which is a factor of several either way; real photospheric
          // granulation is nearer 10%, and at full strength the dark patches read as
          // grey cloud on a cue ball rather than as structure in something glowing.
          float gran = dot(texture2D(map, vMapUv).rgb, vec3(0.2126, 0.7152, 0.0722));
          diffuseColor.rgb *= sqrt(gran * ${SUN_MAP_LUMA_NORM.toFixed(5)});
        #endif
        float mu = clamp(dot(normalize(vLimbN), normalize(vLimbV)), 0.0, 1.0);
        diffuseColor.rgb *= 0.30 + 0.93 * mu - 0.23 * mu * mu;
        diffuseColor.rgb *= mix(vec3(1.0, 0.82, 0.62), vec3(1.0), smoothstep(0.0, 0.45, mu));`,
      )
  }
  material.customProgramCacheKey = () => 'limb-darkened'
}

/**
 * A star's aureole.
 *
 * The photosphere has a hard edge — it is an optical-depth-1 surface a few hundred
 * kilometres thick on a 696,000 km body — but no photograph of the Sun shows one, and
 * neither does the eye. What fills the gap is everything above the limb: the thin
 * chromosphere and the inner K-corona, electron-scattered photospheric light whose
 * surface brightness falls off very steeply with height.
 *
 * Drawn the same way as the atmosphere rim and for the same reason: density from the
 * ray's IMPACT PARAMETER, not from the grazing angle, so the glow peaks where the ray
 * grazes the photosphere and falls to exactly zero at the shell's own silhouette
 * rather than being truncated from near its peak in one pixel. The profile is a plain
 * inverse power of the height, which is what a coronagraph's radial profile looks like
 * once the instrument's own vignetting is divided out; it is normalised to reach zero
 * at the shell edge so the shell can be small and still leave no stroke.
 *
 * This is a visual aureole, not photometry: the real K-corona at the limb is about a
 * millionth of disc brightness and would be invisible beside a disc tone-mapped to
 * white. `uIntensity` is set so the inner arcminute clears the bloom threshold, which
 * is where the glare actually comes from — the shell's job is only to make sure the
 * threshold is cleared by something with a soft outer edge.
 *
 * Cost is one draw call and a shell of 2.6 body radii. That is large at the Sun and
 * sub-degree from every planet: from Mercury the whole shell subtends 2.1 degrees,
 * about 40 pixels of radius, so it is free at every destination but the Sun itself.
 */
function coronaMaterial(color: THREE.Color, outerRatio: number, intensity: number): THREE.ShaderMaterial {
  // Normalising constant so the profile is 1 at the photosphere and 0 at the shell.
  const floor = Math.pow(1 / outerRatio, 5)
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: color },
      uIntensity: { value: intensity },
      uOuter: { value: outerRatio },
      uFloor: { value: floor },
      uGain: { value: 1 / (1 - floor) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vViewPosition;
      varying vec3 vCenterView;
      varying float vShellRadius;
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vViewPosition = viewPosition.xyz;
        vCenterView = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vShellRadius = length(modelViewMatrix[0].xyz);
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uIntensity;
      uniform float uOuter;
      uniform float uFloor;
      uniform float uGain;
      varying vec3 vViewPosition;
      varying vec3 vCenterView;
      varying float vShellRadius;
      void main() {
        vec3 ray = normalize(vViewPosition);
        float impact = length(vCenterView - dot(vCenterView, ray) * ray) / max(vShellRadius, 1e-20);
        // Height above the photosphere, in body radii. Rays that pass inside the
        // photosphere are clamped to its surface: the disc is drawn over them anyway.
        float height = max(impact * uOuter, 1.0);
        float profile = (pow(1.0 / height, 5.0) - uFloor) * uGain;
        float alpha = max(profile, 0.0) * uIntensity;
        gl_FragColor = vec4(uColor * alpha, alpha);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    premultipliedAlpha: true,
    depthWrite: false,
    side: THREE.BackSide,
  })
}

/**
 * The atmosphere rim.
 *
 * A back-face sphere slightly larger than the body, additively blended, with its
 * opacity driven by how deep through the shell the view ray passes.
 *
 * The ray's impact parameter, not the grazing angle, is what drives it. `pow(1 - |N.V|, k)`
 * is MAXIMAL at the shell's own silhouette and there is no geometry beyond it, so
 * however the blend mode and the shell radius are set the glow is truncated from near
 * its peak to zero in one pixel — a hard coloured stroke drawn round the planet, with
 * a darker trough just inside it. Driving the density from the impact parameter
 * inverts that: it peaks where the ray grazes the solid body and falls to exactly zero
 * at the shell's edge, which is how air actually thins out.
 *
 * `premultipliedAlpha` matters here. The shader premultiplies, and without the flag
 * three's additive path is blendFuncSeparate(SRC_ALPHA, ONE), so the colour is
 * multiplied by alpha a second time and the intended cubic density response comes out
 * as a sixth power — all of the brightness crushed into the last texel.
 *
 * On an OBLATE body the impact parameter has to be measured in the space where the
 * shell is a sphere, which is why the stretch below exists. Normalising the view-space
 * perpendicular distance by the equatorial half-width instead puts the polar
 * silhouette at impact == polarRatio — 0.902 for Saturn — which is below `uInner`, so
 * `depth` clamps to 0, the density sits at its 1.0 peak across the whole polar annulus
 * and is then truncated to zero in one pixel. That is exactly the hard stroke this
 * formulation exists to remove, reintroduced at full strength over the poles; it was
 * measured on both giants (Saturn's polar ray ran 139,142,146,150,154,0).
 */
function atmosphereMaterial(
  color: THREE.Color,
  innerRatio: number,
  polarRatio: number,
): THREE.ShaderMaterial {
  // The stretch is a no-op on a sphere, so do not make a sphere pay for it.
  const oblate = polarRatio !== 1
  const stretchVarying = oblate ? 'varying vec3 vShellAxis;\n' : ''
  const stretchFn = oblate
    ? /* glsl */ `
      uniform float uPolarStretch;
      // Map view space to the space in which the shell is a sphere of radius
      // vShellRadius: lengthen the component along the polar axis by 1/polarRatio.
      // The map is linear and fixes the origin, so the camera stays at the origin and
      // a ray stays a ray through it.
      vec3 unsquash(vec3 v) { return v + vShellAxis * dot(v, vShellAxis) * uPolarStretch; }
    `
    : ''
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: color },
      uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
      uInner: { value: innerRatio },
      ...(oblate ? { uPolarStretch: { value: 1 / polarRatio - 1 } } : {}),
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormalWorld;
      varying vec3 vViewPosition;
      varying vec3 vCenterView;
      varying float vShellRadius;
      ${stretchVarying}
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vViewPosition = viewPosition.xyz;
        vNormalWorld = normalize(mat3(modelMatrix) * normal);
        vCenterView = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        // The shell's equatorial half-width, which is its radius everywhere once the
        // squash is undone in the fragment stage.
        vShellRadius = length(modelViewMatrix[0].xyz);
        ${oblate ? 'vShellAxis = normalize(modelViewMatrix[1].xyz);' : ''}
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform vec3 uSunDirection;
      uniform float uInner;
      varying vec3 vNormalWorld;
      varying vec3 vViewPosition;
      varying vec3 vCenterView;
      varying float vShellRadius;
      ${stretchVarying}
      ${stretchFn}
      void main() {
        ${
          oblate
            ? `vec3 ray = normalize(unsquash(vViewPosition));
        vec3 centre = unsquash(vCenterView);`
            : `vec3 ray = normalize(vViewPosition);
        vec3 centre = vCenterView;`
        }
        float impact = length(centre - dot(centre, ray) * ray) / max(vShellRadius, 1e-20);
        float depth = clamp((impact - uInner) / max(1.0 - uInner, 1e-5), 0.0, 1.0);
        float density = (exp(-depth * 3.5) - exp(-3.5)) / (1.0 - exp(-3.5));
        // Only the lit limb glows; the night side keeps a thin trace so the planet
        // still reads as round against the void.
        float sunFacing = clamp(dot(normalize(vNormalWorld), normalize(uSunDirection)) + 0.3, 0.0, 1.0);
        float alpha = density * sunFacing;
        gl_FragColor = vec4(uColor * alpha, alpha);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    premultipliedAlpha: true,
    depthWrite: false,
    side: THREE.BackSide,
  })
}

/**
 * Ring photometry and the planet's shadow on the rings.
 *
 * Extends the existing `MeshBasicMaterial` rather than replacing it with a
 * `ShaderMaterial`: three only injects the sRGB decode for its own built-in map slot,
 * and a hand-written shader sampling the same cached texture through a custom uniform
 * would render the rings visibly brighter and washed out, and would lose the tone map.
 *
 * Brightness is Chandrasekhar single scattering through a slab of optical depth tau,
 * with tau recovered from the texture's alpha. A plain |n.sunDir| would be sin(B_sun) —
 * 0.137 at the current epoch — and would render the rings at 14% of their brightness
 * today and at zero through every ring-plane crossing, which is not what a ring does.
 * The lit and unlit faces are separated by the SIGN of n.sunDir against n.viewDir, and
 * the unlit face is transmission rather than reflection, so there the optically thin
 * gaps — the Cassini Division above all — are the BRIGHT parts.
 *
 * The lit face is normalised against the GEOMETRY rather than against one viewpoint;
 * see the comment on `ringBright` for what went wrong when it was not.
 */
function ringMaterial(
  texture: THREE.Texture,
  equatorialRadius: number,
  polarRatio: number,
): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    opacity: 0.92,
  })
  // The ring mesh is rotated a quarter turn about x, so in its own object space the
  // body's polar axis is +z and the body is an ellipsoid of semi-axes (eq, eq, polar).
  const inverseShape = `vec3(${(1 / equatorialRadius).toExponential(8)}, ${(1 / equatorialRadius).toExponential(8)}, ${(1 / (equatorialRadius * polarRatio)).toExponential(8)})`
  material.onBeforeCompile = (shader) => {
    const sun = ringSunUniforms(material)
    shader.uniforms.uSunRing = sun.direction
    shader.uniforms.uSunShadow = sun.shadowAxis
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRingObj;\nvarying vec3 vRingView;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vRingObj = transformed;
        vec3 ringMv = (modelViewMatrix * vec4(transformed, 1.0)).xyz;
        // The direction back to the camera, returned to the ring's own object space.
        // Nothing in this chain scales the ring, so mat3(modelViewMatrix) is a pure
        // rotation and its inverse is its transpose, written out because transpose()
        // is GLSL ES 3.0 only.
        mat3 ringRot = mat3(modelViewMatrix);
        vRingView = normalize(vec3(dot(ringRot[0], -ringMv), dot(ringRot[1], -ringMv), dot(ringRot[2], -ringMv)));`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform vec3 uSunRing;\nuniform vec4 uSunShadow;\nvarying vec3 vRingObj;\nvarying vec3 vRingView;',
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float ringTau = -log(max(1.0 - texture2D(map, vMapUv).a, 0.004));
        float muSun = uSunShadow.w;
        float muView = max(abs(vRingView.z), 0.02);
        // Chandrasekhar single scattering through a slab of optical depth tau, split
        // into the two factors it is a product of: an obliquity term mu0/(mu + mu0)
        // and the slab's own opacity along the combined slant path.
        float thick = 1.0 - exp(-ringTau * (1.0 / muView + 1.0 / muSun));
        float oblique = muSun / (muView + muSun);
        float transmitted = exp(-ringTau / muView);
        bool litFace = uSunRing.z * vRingView.z > 0.0;
        // The lit branch divides the obliquity term back out. It is physically the
        // ratio of two cosines and NOT a property of the ring, so leaving it in makes
        // the brightness depend on where the camera is: at today's 7.9-degree sun
        // elevation seen face-on it is 0.12, and the classic near-face-on Saturn lost
        // three quarters of its light to it (measured ring pixels 119/110/103 ->
        // 67/59/53). Divided out, what is left is the ring's optical thickness, which
        // is what a ring image actually shows, lightly weighted so that the optically
        // thin gaps — the Cassini Division above all — stay darker than the A ring
        // rather than merely greyer. The unlit face is transmission, where the thin
        // gaps are the BRIGHT parts, so it keeps the real geometry.
        float ringBright = litFace ? thick * (0.6 + 0.4 * thick) : transmitted + 0.10 * oblique * thick;

        // The planet's shadow. Dividing by the body's semi-axes turns the ellipsoid
        // into a unit sphere, after which the test is one dot product: the ring point
        // is eclipsed when the ray toward the Sun runs anti-sunward within one body
        // radius of the sun axis. The sun axis in that space is constant over the
        // whole annulus, so it is normalised once on the CPU in setSunDirection.
        vec3 ringP = vRingObj * ${inverseShape};
        vec3 ringS = uSunShadow.xyz;
        float ringAlong = dot(ringP, ringS);
        float ringOffAxis = length(ringP - ringAlong * ringS);
        if (ringAlong < 0.0) ringBright *= smoothstep(1.0, 1.03, ringOffAxis);

        diffuseColor.rgb *= clamp(ringBright, 0.0, 1.25);`,
      )
  }
  material.customProgramCacheKey = () => `ring:${inverseShape}`
  return material
}

/**
 * The ring shader's sun uniforms, kept on the material so `setSunDirection` can write
 * them whether or not the program has been compiled yet.
 *
 * `direction` is the unit sun direction in the ring's own object space. `shadowAxis`
 * is the two terms that are constant over the whole annulus and so are computed once
 * per frame on the CPU rather than once per fragment: xyz is that direction
 * renormalised in the space where the planet is a unit sphere, w is the sun's cosine
 * off the ring plane. The annulus covers a large part of the screen at Saturn, and
 * the normalise it replaces cost an inverse square root on every one of those pixels.
 */
interface RingSunUniforms {
  direction: THREE.IUniform
  shadowAxis: THREE.IUniform
}
const ringSunCache = new WeakMap<THREE.Material, RingSunUniforms>()
function ringSunUniforms(material: THREE.Material): RingSunUniforms {
  let uniforms = ringSunCache.get(material)
  if (!uniforms) {
    uniforms = {
      direction: { value: new THREE.Vector3(0, 0, 1) },
      shadowAxis: { value: new THREE.Vector4(0, 0, 1, 1) },
    }
    ringSunCache.set(material, uniforms)
  }
  return uniforms
}

export class SphereBody {
  readonly group = new THREE.Group()
  readonly mesh: THREE.Mesh
  readonly spec: SphereBodySpec

  private atmosphere: THREE.Mesh | null = null
  private corona: THREE.Mesh | null = null
  private clouds: THREE.Mesh | null = null
  private rings: THREE.Mesh | null = null
  private readonly sunDirection = new THREE.Vector3(1, 0, 0)
  /** Sun direction rotated out of the layer frame into the body's own. */
  private readonly bodySun = new THREE.Vector3(1, 0, 0)
  private readonly inverseSpin = new THREE.Quaternion()
  private surfaceSunUniform: THREE.IUniform | null = null
  private ringSun: RingSunUniforms | null = null
  private readonly polarRatio: number
  /** Equatorial radius in layer units; `spec.radius` is the mean. */
  private equatorialRadius: number

  constructor(spec: SphereBodySpec) {
    this.spec = spec
    const segments = spec.segments ?? 64
    this.polarRatio = spec.polarRatio ?? 1
    this.equatorialRadius = spec.radius / Math.cbrt(this.polarRatio)

    const material = spec.emissive
      ? new THREE.MeshBasicMaterial({
          color: spec.color ? new THREE.Color(spec.color) : new THREE.Color(1, 1, 1),
          map: spec.textureUrl ? loadTexture(spec.textureUrl) : null,
        })
      : new THREE.MeshStandardMaterial({
          color: spec.textureUrl ? 0xffffff : new THREE.Color(spec.color ?? '#9aa3ab'),
          map: spec.textureUrl ? loadTexture(spec.textureUrl) : null,
          // Relief shading is the one thing that changes how a body reads at the
          // terminator, and the Moon is the body in this atlas where it changes it
          // most. The map is greyscale height, not colour: it must bypass the sRGB
          // decode or the transfer curve distorts the slopes.
          bumpMap: spec.bumpMapUrl ? loadTexture(spec.bumpMapUrl, THREE.NoColorSpace) : null,
          bumpScale: spec.bumpScale ?? 1,
          roughness: 0.92,
          metalness: 0,
        })

    if (spec.emissive && spec.limbDarkened) {
      applyLimbDarkening(material as THREE.MeshBasicMaterial)
    }

    if (!spec.emissive) {
      const parts = surfaceShader(spec)
      if (parts) {
        installSurfaceShader(material as THREE.MeshStandardMaterial, parts)
        this.surfaceSunUniform = parts.uniforms.uSunBody ?? null
      }
    }

    if (spec.emissive && spec.emissiveIntensity) {
      // Push the Sun above the HDR bloom threshold so its glare is produced by the
      // tone mapper rather than painted on. `toneMapped` stays true deliberately —
      // disabling it is what makes a sun look like a white sticker.
      const basic = material as THREE.MeshBasicMaterial
      basic.color.multiplyScalar(spec.emissiveIntensity)
    }

    this.mesh = new THREE.Mesh(unitSphere(segments), material)
    this.applyShape(this.mesh, 1)
    this.mesh.name = spec.id
    this.group.add(this.mesh)

    if (spec.cloudTextureUrl) {
      // Coverage only. The shipped cloud map is pure greyscale, so binding it as both
      // `map` and `alphaMap` would composite its luminance against itself and the deck
      // would come out dark grey at about a third of its correct brightness. White
      // albedo, the GREEN channel as alpha (three's alphaMap convention — the shipped
      // map is greyscale, so that is its luminance, but a coloured coverage map would
      // need its own chunk), and the sRGB decode kept off it.
      const cloudMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        alphaMap: loadTexture(spec.cloudTextureUrl, THREE.NoColorSpace),
        transparent: true,
        depthWrite: false,
        roughness: 1,
        metalness: 0,
      })
      // The map is a monthly cloud-fraction composite, so thin cirrus covers most of
      // the globe at a low value. Taken as opacity directly it veils the whole Blue
      // Marble in grey; raised to a power the storm systems keep their opacity and the
      // haze thins out, which is also what a single instant looks like rather than a
      // month of averaging.
      cloudMaterial.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <alphamap_fragment>',
          `#include <alphamap_fragment>
          diffuseColor.a = pow(diffuseColor.a, 1.5);`,
        )
      }
      cloudMaterial.customProgramCacheKey = () => 'cloud-deck'
      const shell = new THREE.Mesh(unitSphere(segments), cloudMaterial)
      this.applyShape(shell, 1.003)
      this.clouds = shell
      this.group.add(shell)
    }

    if (spec.atmosphereColor) {
      const scale = spec.atmosphereScale ?? 1.06
      const shell = new THREE.Mesh(
        unitSphere(48),
        atmosphereMaterial(new THREE.Color(spec.atmosphereColor), 1 / scale, this.polarRatio),
      )
      this.applyShape(shell, scale)
      shell.renderOrder = 2
      this.atmosphere = shell
      this.group.add(shell)
    }

    if (spec.coronaScale && spec.coronaColor) {
      // 32 segments, not 48: the shell carries no texture and no normal, its profile
      // is computed per fragment from the ray, and all the silhouette does is bound
      // the region where the profile has already fallen to zero.
      const shell = new THREE.Mesh(
        unitSphere(32),
        coronaMaterial(
          new THREE.Color(spec.coronaColor).convertSRGBToLinear(),
          spec.coronaScale,
          spec.coronaIntensity ?? 1,
        ),
      )
      this.applyShape(shell, spec.coronaScale)
      shell.renderOrder = 2
      this.corona = shell
      this.group.add(shell)
    }

    if (spec.ringTextureUrl) {
      // The canonical 1.24 and 2.27 are ratios of the EQUATORIAL radius (2.27 x 60,268
      // km is exactly the A ring's outer edge), so they are taken against that and not
      // against the mean radius the globe is sized from.
      const inner = this.equatorialRadius * (spec.ringInnerScale ?? 1.24)
      const outer = this.equatorialRadius * (spec.ringOuterScale ?? 2.27)
      const geometry = new THREE.RingGeometry(inner, outer, 160, 1)
      // RingGeometry's default UVs are unusable for a radial ring texture: remap so u
      // runs from the inner edge to the outer edge.
      const position = geometry.attributes.position
      const uv = geometry.attributes.uv
      const v = new THREE.Vector3()
      for (let i = 0; i < position.count; i++) {
        v.fromBufferAttribute(position, i)
        const t = (v.length() - inner) / (outer - inner)
        uv.setXY(i, t, 0.5)
      }
      uv.needsUpdate = true

      const texture = loadTexture(spec.ringTextureUrl, THREE.SRGBColorSpace, THREE.ClampToEdgeWrapping)
      const material = ringMaterial(texture, this.equatorialRadius, this.polarRatio)
      this.ringSun = ringSunUniforms(material)
      this.rings = new THREE.Mesh(geometry, material)
      // Rings lie in the body's equatorial plane; the body group carries the tilt.
      this.rings.rotation.x = Math.PI / 2
      this.rings.renderOrder = 1
      this.group.add(this.rings)
    }
  }

  /** Scale a shell to the body's shape: oblate about the mean radius. */
  private applyShape(mesh: THREE.Mesh, multiple: number): void {
    const r = this.equatorialRadius * multiple
    mesh.scale.set(r, r * this.polarRatio, r)
  }

  /** Point the body's lighting at the Sun. `direction` is in the layer's space. */
  setSunDirection(direction: THREE.Vector3): void {
    this.sunDirection.copy(direction)
    if (this.atmosphere) {
      const material = this.atmosphere.material as THREE.ShaderMaterial
      material.uniforms.uSunDirection.value.copy(direction)
    }
    if (!this.surfaceSunUniform && !this.ringSun) return

    // Rotate the layer-space direction into the body's own frame. The group carries
    // the axial tilt and the spin, so a ring shadow computed in layer space would stay
    // pinned to one side of the screen while the planet turned underneath it.
    this.inverseSpin.copy(this.group.quaternion).invert()
    this.bodySun.copy(direction).applyQuaternion(this.inverseSpin)
    if (this.surfaceSunUniform) {
      // No stretch. The surface shader's space is the body frame divided by the
      // EQUATORIAL radius — the vertex injection writes vBodyPos with the oblate
      // squash put back — and a uniform scale leaves a direction unchanged. Stretching
      // it here instead traced Saturn's ring shadow from a sun 0.85 degrees too high
      // in ring opening, with a slant-path exponent 10% too shallow with it.
      ;(this.surfaceSunUniform.value as THREE.Vector3).copy(this.bodySun)
    }
    if (this.ringSun) {
      // The ring mesh's object space is the body's, turned a quarter turn about x.
      const direction = this.ringSun.direction.value as THREE.Vector3
      direction.set(this.bodySun.x, this.bodySun.z, -this.bodySun.y)
      // The two terms the ring shader would otherwise recompute per fragment. The
      // shadow test runs in the space where the planet is a unit sphere, so the sun
      // axis has to be renormalised there; both depend only on the sun, not the pixel.
      const shadow = this.ringSun.shadowAxis.value as THREE.Vector4
      shadow.set(direction.x, direction.y, direction.z / this.polarRatio, 0)
      const length = Math.hypot(shadow.x, shadow.y, shadow.z) || 1
      shadow.set(shadow.x / length, shadow.y / length, shadow.z / length, Math.max(Math.abs(direction.z), 0.02))
    }
  }

  /**
   * Drift the cloud deck relative to the surface.
   *
   * Driven by the body's own DISPLAYED spin step, not by the epoch: a deck whose
   * longitude is sampled absolutely from the clock aliases at exactly the rates the
   * displayed spin is capped to avoid, and would counter-rotate against the globe it
   * sits on. 1.2% of a rotation per rotation is about one extra lap every eighty days,
   * which is the right order for the mid-latitude jets.
   */
  advanceClouds(spinStepRadians: number): void {
    if (!this.clouds) return
    this.clouds.rotation.y = (this.clouds.rotation.y + spinStepRadians * 0.012) % (Math.PI * 2)
  }

  /** Rescale when the host layer's unit changes, or when the body is re-anchored. */
  setRadius(radius: number): void {
    this.equatorialRadius = radius / Math.cbrt(this.polarRatio)
    this.applyShape(this.mesh, 1)
    if (this.clouds) this.applyShape(this.clouds, 1.003)
    if (this.atmosphere) this.applyShape(this.atmosphere, this.spec.atmosphereScale ?? 1.06)
    if (this.corona) this.applyShape(this.corona, this.spec.coronaScale ?? 1)
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible
  }

  dispose(): void {
    this.group.removeFromParent()
    const material = this.mesh.material
    if (Array.isArray(material)) material.forEach((m) => m.dispose())
    else material.dispose()
    this.atmosphere?.geometry.dispose()
    ;(this.atmosphere?.material as THREE.Material | undefined)?.dispose()
    this.corona?.geometry.dispose()
    ;(this.corona?.material as THREE.Material | undefined)?.dispose()
    this.clouds?.geometry.dispose()
    ;(this.clouds?.material as THREE.Material | undefined)?.dispose()
    this.rings?.geometry.dispose()
    ;(this.rings?.material as THREE.Material | undefined)?.dispose()
  }
}
