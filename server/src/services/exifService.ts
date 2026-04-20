import * as exifr from 'exifr'

export interface ExifData {
  takenAt: string | null
  latitude: number | null
  longitude: number | null
  cameraMake: string | null
  cameraModel: string | null
  width: number | null
  height: number | null
}

export async function extractExif(filePath: string): Promise<ExifData> {
  try {
    const parsed = await exifr.parse(filePath, {
      tiff: true,
      exif: true,
      gps: true,
      translateKeys: true,
      translateValues: false,
    }) as any

    if (!parsed) return emptyExif()

    const takenAt = parsed.DateTimeOriginal || parsed.CreateDate || parsed.ModifyDate || null
    const latitude = parsed.latitude ?? null
    const longitude = parsed.longitude ?? null
    const cameraMake = (parsed.Make as string | undefined)?.trim() || null
    const cameraModel = (parsed.Model as string | undefined)?.trim() || null
    const width = parsed.ImageWidth || parsed.ExifImageWidth || null
    const height = parsed.ImageHeight || parsed.ExifImageHeight || null

    return {
      takenAt: takenAt instanceof Date ? takenAt.toISOString() : (typeof takenAt === 'string' ? takenAt : null),
      latitude: typeof latitude === 'number' && isFinite(latitude) ? latitude : null,
      longitude: typeof longitude === 'number' && isFinite(longitude) ? longitude : null,
      cameraMake,
      cameraModel,
      width: typeof width === 'number' ? width : null,
      height: typeof height === 'number' ? height : null,
    }
  } catch {
    return emptyExif()
  }
}

function emptyExif(): ExifData {
  return { takenAt: null, latitude: null, longitude: null, cameraMake: null, cameraModel: null, width: null, height: null }
}
