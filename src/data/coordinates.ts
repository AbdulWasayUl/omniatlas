import * as THREE from 'three'

export function latLonToCartesian(
  latitude: number,
  longitude: number,
  radius: number,
): THREE.Vector3 {
  const latitudeRadians = THREE.MathUtils.degToRad(latitude)
  const longitudeRadians = THREE.MathUtils.degToRad(longitude)
  const cosLatitude = Math.cos(latitudeRadians)

  return new THREE.Vector3(
    radius * cosLatitude * Math.cos(longitudeRadians),
    radius * Math.sin(latitudeRadians),
    -radius * cosLatitude * Math.sin(longitudeRadians),
  )
}
