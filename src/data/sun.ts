import type { AtlasEntity } from './types'

export const SUN: AtlasEntity = {
  id: 'sun',
  name: 'Sun',
  eyebrow: 'Star · Sol',
  kind: 'star',
  bodyId: 'sun',
  engineBody: 'Sun',
  radiusKm: 696_340,
  textureUrl: '/textures/planets/sun.jpg',
  description:
    'The G-type main-sequence star at the center of the Solar System. Its direction, rotation, and illumination in this view are calculated for the displayed UTC time.',
  facts: [
    { label: 'Mean radius', value: '696,340 km' },
    { label: 'Mass', value: '1.9885 × 10³⁰ kg' },
    { label: 'Spectral type', value: 'G2 V' },
    { label: 'Mean Earth distance', value: '149.6 million km' },
    { label: 'Display model', value: 'Direction accurate · scale compressed in Explore mode' },
  ],
  source: {
    label: 'NASA Sun facts',
    url: 'https://science.nasa.gov/sun/facts/',
  },
}
