/**
 * Static geo table for the preloaded Russian cities. Having this inline avoids
 * a Nominatim round-trip on every search and keeps the tool fast + offline-ish.
 *
 * - center: [lon, lat] used by 2GIS `location` and as Yandex map focus.
 * - spn:    [dLon, dLat] span used by Yandex `spn` (geographic focus).
 * - bbox:   [south, west, north, east] used by Overpass area filtering.
 */
export interface CityGeo {
  name: string; // canonical Cyrillic name
  center: [number, number]; // lon, lat
  spn: [number, number]; // dLon, dLat
  bbox: [number, number, number, number]; // south, west, north, east
}

export const CITIES: Record<string, CityGeo> = {
  'Москва': {
    name: 'Москва',
    center: [37.6173, 55.7558],
    spn: [0.9, 0.6],
    bbox: [55.49, 37.3, 56.0, 37.95],
  },
  'Санкт-Петербург': {
    name: 'Санкт-Петербург',
    center: [30.3351, 59.9343],
    spn: [0.9, 0.5],
    bbox: [59.7, 30.0, 60.1, 30.6],
  },
  'Казань': {
    name: 'Казань',
    center: [49.1221, 55.7879],
    spn: [0.5, 0.3],
    bbox: [55.65, 48.9, 55.9, 49.35],
  },
  'Екатеринбург': {
    name: 'Екатеринбург',
    center: [60.6057, 56.8389],
    spn: [0.5, 0.3],
    bbox: [56.72, 60.4, 56.95, 60.8],
  },
  'Новосибирск': {
    name: 'Новосибирск',
    center: [82.9204, 55.0302],
    spn: [0.6, 0.4],
    bbox: [54.9, 82.7, 55.15, 83.1],
  },
  'Краснодар': {
    name: 'Краснодар',
    center: [38.9769, 45.0355],
    spn: [0.5, 0.3],
    bbox: [44.95, 38.8, 45.12, 39.15],
  },
  'Нижний Новгород': {
    name: 'Нижний Новгород',
    center: [43.9999, 56.3269],
    spn: [0.6, 0.35],
    bbox: [56.2, 43.75, 56.4, 44.15],
  },
  'Ростов-на-Дону': {
    name: 'Ростов-на-Дону',
    center: [39.7015, 47.2357],
    spn: [0.5, 0.3],
    bbox: [47.15, 39.55, 47.33, 39.85],
  },
};

export const CITY_NAMES = Object.keys(CITIES);

export function cityGeo(city: string): CityGeo | undefined {
  return CITIES[city.trim()];
}
