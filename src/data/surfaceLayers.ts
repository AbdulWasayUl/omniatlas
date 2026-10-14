import type { AtlasEntity } from './types'

export interface CountryRecord {
  id: string
  name: string
  admin: string
  iso2: string | null
  iso3: string | null
  continent: string | null
  subregion: string | null
  population: number | null
  labelRank: number
  latitude: number
  longitude: number
}

export interface CityRecord {
  id: string
  name: string
  country: string | null
  latitude: number
  longitude: number
  population: number | null
  isCapital: boolean
  isMegacity: boolean
  tier: number
}

export interface CraterRecord {
  id: string
  name: string
  latitude: number
  longitude: number
  diameterKm: number
  tier: number
  approvalDate: string | null
  origin: string | null
}

export const COUNTRIES_URL = '/data/earth/countries.json'
export const COUNTRIES_BOUNDARY_URL = '/data/earth/countries-50m.bin'
export const CITIES_URL = '/data/earth/cities.json'
export const MOON_CRATERS_URL = '/data/moon/craters.json'

const NATURAL_EARTH_SOURCE = {
  label: 'Natural Earth 1:50m cultural vectors',
  url: 'https://www.naturalearthdata.com/downloads/50m-cultural-vectors/',
}

const USGS_GAZETTEER_SOURCE = {
  label: 'USGS Gazetteer of Planetary Nomenclature',
  url: 'https://planetarynames.wr.usgs.gov/Nomenclature',
}

export function countryToEntity(country: CountryRecord): AtlasEntity {
  return {
    id: country.id,
    name: country.name,
    eyebrow: [country.subregion, country.continent].filter(Boolean).join(' · ') || 'Earth · Country',
    kind: 'country',
    parentId: 'earth',
    bodyId: 'earth',
    coordinates: { latitude: country.latitude, longitude: country.longitude },
    description: `${country.admin} is shown with a Natural Earth boundary outline, revealed at country-level zoom over the Earth globe.`,
    facts: [
      { label: 'Continent', value: country.continent ?? 'Unknown' },
      { label: 'Subregion', value: country.subregion ?? 'Unknown' },
      { label: 'Population (est.)', value: country.population ? country.population.toLocaleString() : 'Unknown' },
      { label: 'ISO code', value: country.iso3 ?? country.iso2 ?? 'Unknown' },
    ],
    source: NATURAL_EARTH_SOURCE,
  }
}

export function cityToEntity(city: CityRecord): AtlasEntity {
  return {
    id: city.id,
    name: city.name,
    eyebrow: city.isCapital ? `Capital · ${city.country ?? 'Earth'}` : `City · ${city.country ?? 'Earth'}`,
    kind: 'city',
    parentId: 'earth',
    bodyId: 'earth',
    coordinates: { latitude: city.latitude, longitude: city.longitude },
    description: `${city.name} is a labeled location revealed at close zoom over the Earth globe, from the Natural Earth populated-places catalogue.`,
    facts: [
      { label: 'Country', value: city.country ?? 'Unknown' },
      { label: 'Population (metro est.)', value: city.population ? city.population.toLocaleString() : 'Unknown' },
      { label: 'National capital', value: city.isCapital ? 'Yes' : 'No' },
    ],
    source: NATURAL_EARTH_SOURCE,
  }
}

export function craterToEntity(crater: CraterRecord): AtlasEntity {
  return {
    id: crater.id,
    name: crater.name,
    eyebrow: 'Moon · Named crater',
    kind: 'crater',
    parentId: 'moon',
    bodyId: 'moon',
    coordinates: { latitude: crater.latitude, longitude: crater.longitude },
    description: crater.origin
      ? `An IAU-approved named lunar crater honoring ${crater.origin}. Its label appears only when this surface area is centered and viewed at close zoom.`
      : 'An IAU-approved named lunar crater. Its label appears only when this surface area is centered and viewed at close zoom.',
    facts: [
      { label: 'Diameter', value: `${crater.diameterKm.toLocaleString()} km` },
      { label: 'Feature type', value: 'Crater' },
      { label: 'Approval date', value: crater.approvalDate ?? 'Unknown' },
    ],
    source: USGS_GAZETTEER_SOURCE,
  }
}
