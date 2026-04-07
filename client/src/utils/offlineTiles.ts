// Offline map tile pre-fetcher
// Pre-fetches tiles for the current viewport at zoom levels 10–16,
// which Workbox's CacheFirst handler automatically caches for offline use.

interface Bounds {
  north: number
  south: number
  east: number
  west: number
}

function lon2tile(lon: number, zoom: number): number {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, zoom))
}

function lat2tile(lat: number, zoom: number): number {
  return Math.floor(
    ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) *
      Math.pow(2, zoom)
  )
}

export function estimateTileCount(bounds: Bounds, minZoom = 10, maxZoom = 16): number {
  let total = 0
  for (let z = minZoom; z <= maxZoom; z++) {
    const xMin = lon2tile(bounds.west, z)
    const xMax = lon2tile(bounds.east, z)
    const yMin = lat2tile(bounds.north, z)
    const yMax = lat2tile(bounds.south, z)
    total += (Math.abs(xMax - xMin) + 1) * (Math.abs(yMax - yMin) + 1)
  }
  return total
}

export async function downloadTiles(
  tileUrlTemplate: string,
  bounds: Bounds,
  onProgress: (downloaded: number, total: number) => void,
  signal?: AbortSignal,
  minZoom = 10,
  maxZoom = 16
): Promise<{ downloaded: number; errors: number }> {
  const tiles: { z: number; x: number; y: number }[] = []

  for (let z = minZoom; z <= maxZoom; z++) {
    const xMin = Math.min(lon2tile(bounds.west, z), lon2tile(bounds.east, z))
    const xMax = Math.max(lon2tile(bounds.west, z), lon2tile(bounds.east, z))
    const yMin = Math.min(lat2tile(bounds.north, z), lat2tile(bounds.south, z))
    const yMax = Math.max(lat2tile(bounds.north, z), lat2tile(bounds.south, z))
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        tiles.push({ z, x, y })
      }
    }
  }

  const total = tiles.length
  let downloaded = 0
  let errors = 0

  // Fetch in batches of 8 to avoid overwhelming the SW cache
  const BATCH = 8
  for (let i = 0; i < tiles.length; i += BATCH) {
    if (signal?.aborted) break
    const batch = tiles.slice(i, i + BATCH)
    await Promise.all(
      batch.map(async ({ z, x, y }) => {
        const url = tileUrlTemplate
          .replace('{z}', String(z))
          .replace('{x}', String(x))
          .replace('{y}', String(y))
          .replace('{s}', ['a', 'b', 'c'][Math.floor(Math.random() * 3)])
        try {
          await fetch(url, { signal })
        } catch {
          errors++
        }
        downloaded++
        onProgress(downloaded, total)
      })
    )
  }

  return { downloaded, errors }
}
