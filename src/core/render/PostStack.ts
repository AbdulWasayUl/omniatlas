import * as THREE from 'three'

/**
 * Post-processing. The only file in the project that touches it, so swapping the whole
 * approach later is a one-file change.
 *
 * ## Why hand-rolled rather than EffectComposer
 *
 * The engine does not render one scene. It renders up to six, far to near, clearing
 * depth between each so they composite into a single image. A stock composer wants to
 * own the scene render, which would mean either flattening the layers — losing the
 * precision the whole architecture exists for — or running a composer per layer and
 * bloom-ing each separately, which double-counts light at every layer boundary. Owning
 * the targets directly is simpler than fighting that.
 *
 * ## The chain
 *
 * Scene renders into a half-float HDR target with tone mapping OFF, so values above 1
 * survive. A progressive mip chain downsamples with a 13-tap filter, then upsamples
 * with a 3x3 tent and adds back at each level. That gives a wide, soft, stable glow for
 * far less bandwidth than a single large-radius Gaussian, and crucially it does not
 * flicker when a bright sub-pixel object moves — which matters here, because almost
 * every bright thing in this product is a sub-pixel object.
 *
 * Tone mapping happens last, on the composited result. AgX rather than ACES: ACES
 * hue-shifts saturated bright oranges toward white, and saturated bright orange is
 * precisely what the Sun and Jupiter are.
 *
 * AgX's toe is steep: scene-linear 0.002 lands on code 1, 0.01 on code 18. That is
 * what makes a pure-black clear read as genuine void while a faint star one part in
 * five hundred above it is still a visible pixel. The toe is in fact the *least*
 * posterising part of the curve — codes 0-18 span 0.00055 linear each, the shoulder
 * around code 210 spans 0.045, eighty times wider. What forces the dither at the end
 * of the composite is the output, not the curve: 8-bit has few codes to spend near
 * black and the eye is at its most sensitive to a one-code step there.
 */

const MIP_COUNT = 5

const FULLSCREEN_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

/** 13-tap downsample, with the bright pass applied per tap on the first level. */
const DOWNSAMPLE_FRAGMENT = /* glsl */ `
  uniform sampler2D uSource;
  uniform vec2 uTexel;
  uniform float uThreshold;
  uniform float uFirstPass;
  varying vec2 vUv;

  // Soft-knee bright pass, applied to each tap rather than to the filtered result.
  //
  // The 13-tap kernel gives any single source pixel a weight of at most 1/8, so
  // thresholding afterwards silently demanded that a one-pixel light be eight times
  // over the bar before any of it survived. Almost every bright thing in this atlas
  // is sub-pixel — that is the whole point of the product — so in practice only the
  // Sun's disc ever cleared it and nothing else glowed at all. Prefiltering the taps
  // is also where every reference implementation puts it.
  vec3 prefilter(vec3 c) {
    float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float knee = uThreshold * 0.6;
    float soft = clamp(luma - uThreshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-5);
    return c * (max(soft, luma - uThreshold) / max(luma, 1e-5));
  }

  vec3 tap(vec2 uv) {
    vec3 c = texture2D(uSource, uv).rgb;
    return uFirstPass > 0.5 ? prefilter(c) : c;
  }

  void main() {
    vec2 t = uTexel;
    vec3 a = tap(vUv + vec2(-2.0, 2.0) * t);
    vec3 b = tap(vUv + vec2( 0.0, 2.0) * t);
    vec3 c = tap(vUv + vec2( 2.0, 2.0) * t);
    vec3 d = tap(vUv + vec2(-2.0, 0.0) * t);
    vec3 e = tap(vUv);
    vec3 f = tap(vUv + vec2( 2.0, 0.0) * t);
    vec3 g = tap(vUv + vec2(-2.0,-2.0) * t);
    vec3 h = tap(vUv + vec2( 0.0,-2.0) * t);
    vec3 i = tap(vUv + vec2( 2.0,-2.0) * t);
    vec3 j = tap(vUv + vec2(-1.0, 1.0) * t);
    vec3 k = tap(vUv + vec2( 1.0, 1.0) * t);
    vec3 l = tap(vUv + vec2(-1.0,-1.0) * t);
    vec3 m = tap(vUv + vec2( 1.0,-1.0) * t);

    vec3 result = e * 0.125;
    result += (a + c + g + i) * 0.03125;
    result += (b + d + f + h) * 0.0625;
    result += (j + k + l + m) * 0.125;

    gl_FragColor = vec4(result, 1.0);
  }
`

/** 3x3 tent upsample, added onto the next-larger mip. */
const UPSAMPLE_FRAGMENT = /* glsl */ `
  uniform sampler2D uSource;
  uniform vec2 uTexel;
  uniform float uRadius;
  varying vec2 vUv;

  void main() {
    vec2 t = uTexel * uRadius;
    vec3 result = texture2D(uSource, vUv + vec2(-1.0, 1.0) * t).rgb * 1.0;
    result += texture2D(uSource, vUv + vec2( 0.0, 1.0) * t).rgb * 2.0;
    result += texture2D(uSource, vUv + vec2( 1.0, 1.0) * t).rgb * 1.0;
    result += texture2D(uSource, vUv + vec2(-1.0, 0.0) * t).rgb * 2.0;
    result += texture2D(uSource, vUv).rgb * 4.0;
    result += texture2D(uSource, vUv + vec2( 1.0, 0.0) * t).rgb * 2.0;
    result += texture2D(uSource, vUv + vec2(-1.0,-1.0) * t).rgb * 1.0;
    result += texture2D(uSource, vUv + vec2( 0.0,-1.0) * t).rgb * 2.0;
    result += texture2D(uSource, vUv + vec2( 1.0,-1.0) * t).rgb * 1.0;
    gl_FragColor = vec4(result / 16.0, 1.0);
  }
`

/**
 * Final composite. Tone mapping is injected by three.js via the `tonemapping_fragment`
 * chunk, so the renderer's own AgX setting drives it and there is one implementation of
 * the curve rather than two that can drift apart.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `
  uniform sampler2D uScene;
  uniform sampler2D uBloom;
  uniform float uBloomIntensity;
  uniform float uVignette;
  uniform float uGrain;
  uniform float uTime;
  varying vec2 vUv;

  // Integer-style bit mixing (Hoskins' hash13), not fract(sin(x) * big).
  //
  // The sine hash only decorrelates while sin() is still resolving its argument.
  // At gl_FragCoord magnitudes the argument lands on a coarse lattice of
  // representable floats, so neighbouring pixels drew near-identical values and the
  // "noise" came out as a regular diagonal weave across the entire frame — a
  // screen-door over every picture in the atlas. Keying on the pixel did not help,
  // because the pixel grid is exactly what the lattice beats against.
  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }

  void main() {
    vec3 scene = texture2D(uScene, vUv).rgb;
    vec3 bloom = texture2D(uBloom, vUv).rgb;
    vec3 color = scene + bloom * uBloomIntensity;

    vec2 centred = vUv - 0.5;
    float vignette = 1.0 - uVignette * dot(centred, centred) * 1.6;
    color *= clamp(vignette, 0.0, 1.0);

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>

    // Dither, after the sRGB encode -- which is what "display-referred" means.
    //
    // It used to sit between the two includes, where the signal is still linear, and
    // an amplitude of 0.005 linear is anything but small down near black: the sRGB
    // transfer multiplies it by 12.92 there, so the void picked up eight codes of
    // speckle on top of whatever the clear colour already contributed. After the
    // encode the amplitude means what it reads as -- a fraction of one 8-bit code.
    //
    // Its only job is to break the banding AgX's steep toe leaves in faint smooth
    // gradients: an accretion disc, the Sun's corona, a terminator. Deep space has no
    // gradient to band, so the amplitude fades to nothing as the signal approaches
    // black and true black stays exactly black. Two hashes differenced give a
    // triangular distribution, which is the dither that leaves no residual pattern
    // correlated with the signal; holding the pattern for a 24 Hz step rather than
    // redrawing it every frame stops it buzzing on a static sky. The step wraps
    // because uTime is session elapsed seconds, and a float32 hash argument in the
    // tens of thousands has lost the low bits the mixing needs.
    float step24 = mod(floor(uTime * 24.0), 512.0);
    float dither = hash13(vec3(gl_FragCoord.xy, step24))
                 - hash13(vec3(gl_FragCoord.yx + 101.0, step24));
    float signal = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    // The gate reaches full amplitude within one 8-bit code. It used to ramp over
    // 0.02 -- five codes -- which switched the dither off across exactly the range
    // it exists to protect: measured peak excursion was 0.13 of a code at code 1 and
    // 0.43 at code 2, far below the >= 1 code a dither needs to decorrelate the
    // quantiser, so faint nebulosity and the outer corona still contoured. The signal
    // is bit-exact 0 in the void (black clear colour, AgX(0) = 0), so pure black is
    // still preserved exactly.
    gl_FragColor.rgb += dither * uGrain * smoothstep(0.0, 2.0 / 255.0, signal);
  }
`

interface Mip {
  target: THREE.WebGLRenderTarget
  width: number
  height: number
}

export interface PostStackOptions {
  /** Scene-linear luminance above which a pixel contributes to the glow. */
  threshold?: number
  intensity?: number
  vignette?: number
  /**
   * Dither amplitude, in display-referred units: 1/255 is one 8-bit code. The dither
   * is triangular, so this is its peak excursion, not its RMS. Slightly over one code
   * is what fully decorrelates the quantiser, which is why the default is 0.005.
   */
  grain?: number
}

export class PostStack {
  enabled = true

  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly quad: THREE.Mesh

  private hdr: THREE.WebGLRenderTarget
  private mips: Mip[] = []

  private readonly downsample: THREE.ShaderMaterial
  private readonly upsample: THREE.ShaderMaterial
  private readonly composite: THREE.ShaderMaterial

  private width = 1
  private height = 1


  constructor(renderer: THREE.WebGLRenderer, options: PostStackOptions = {}) {
    this.renderer = renderer

    this.hdr = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      samples: 4,
    })
    this.hdr.texture.colorSpace = THREE.NoColorSpace

    this.downsample = new THREE.ShaderMaterial({
      uniforms: {
        uSource: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uThreshold: { value: options.threshold ?? 1.0 },
        uFirstPass: { value: 0 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: DOWNSAMPLE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    })

    this.upsample = new THREE.ShaderMaterial({
      uniforms: {
        uSource: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uRadius: { value: 1.0 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: UPSAMPLE_FRAGMENT,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    })

    this.composite = new THREE.ShaderMaterial({
      uniforms: {
        uScene: { value: null },
        uBloom: { value: null },
        uBloomIntensity: { value: options.intensity ?? 0.85 },
        uVignette: { value: options.vignette ?? 0.35 },
        uGrain: { value: options.grain ?? 0.005 },
        uTime: { value: 0 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: COMPOSITE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    })
    // Lets three.js inject its own tone-mapping chunk, so AgX comes from the renderer.
    this.composite.toneMapped = true

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2))
    this.quad = new THREE.Mesh(geometry, this.composite)
    this.quad.frustumCulled = false
    this.scene.add(this.quad)
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.width = Math.max(1, Math.floor(width * pixelRatio))
    this.height = Math.max(1, Math.floor(height * pixelRatio))

    this.hdr.setSize(this.width, this.height)

    for (const mip of this.mips) mip.target.dispose()
    this.mips = []
    let w = this.width
    let h = this.height
    for (let i = 0; i < MIP_COUNT; i++) {
      w = Math.max(1, Math.floor(w / 2))
      h = Math.max(1, Math.floor(h / 2))
      const target = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        depthBuffer: false,
        stencilBuffer: false,
      })
      target.texture.colorSpace = THREE.NoColorSpace
      target.texture.minFilter = THREE.LinearFilter
      target.texture.magFilter = THREE.LinearFilter
      this.mips.push({ target, width: w, height: h })
    }
  }

  /** The target the engine should render its layers into. */
  get sceneTarget(): THREE.WebGLRenderTarget | null {
    return this.enabled ? this.hdr : null
  }

  /** Run the glow chain and blit the composited result to the screen. */
  render(elapsedSeconds: number): void {
    if (!this.enabled) return
    const gl = this.renderer
    const previousAutoClear = gl.autoClear
    gl.autoClear = true

    // Downsample: HDR -> mip0 (with threshold) -> mip1 -> ...
    this.quad.material = this.downsample
    for (let i = 0; i < this.mips.length; i++) {
      const source = i === 0 ? this.hdr.texture : this.mips[i - 1].target.texture
      const sourceWidth = i === 0 ? this.width : this.mips[i - 1].width
      const sourceHeight = i === 0 ? this.height : this.mips[i - 1].height
      this.downsample.uniforms.uSource.value = source
      this.downsample.uniforms.uTexel.value.set(1 / sourceWidth, 1 / sourceHeight)
      this.downsample.uniforms.uFirstPass.value = i === 0 ? 1 : 0
      gl.setRenderTarget(this.mips[i].target)
      gl.render(this.scene, this.camera)
    }

    // Upsample and accumulate back down the chain, additively.
    this.quad.material = this.upsample
    gl.autoClear = false
    for (let i = this.mips.length - 1; i > 0; i--) {
      this.upsample.uniforms.uSource.value = this.mips[i].target.texture
      this.upsample.uniforms.uTexel.value.set(1 / this.mips[i].width, 1 / this.mips[i].height)
      gl.setRenderTarget(this.mips[i - 1].target)
      gl.render(this.scene, this.camera)
    }

    // Composite to the screen.
    gl.autoClear = true
    this.quad.material = this.composite
    this.composite.uniforms.uScene.value = this.hdr.texture
    this.composite.uniforms.uBloom.value = this.mips[0].target.texture
    this.composite.uniforms.uTime.value = elapsedSeconds
    gl.setRenderTarget(null)
    gl.render(this.scene, this.camera)

    gl.autoClear = previousAutoClear
  }

  setIntensity(value: number): void {
    this.composite.uniforms.uBloomIntensity.value = value
  }

  dispose(): void {
    this.hdr.dispose()
    for (const mip of this.mips) mip.target.dispose()
    this.mips = []
    this.downsample.dispose()
    this.upsample.dispose()
    this.composite.dispose()
    this.quad.geometry.dispose()
  }
}
