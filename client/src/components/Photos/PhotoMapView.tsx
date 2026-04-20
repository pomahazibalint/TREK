import { useEffect, useRef } from 'react'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import MarkerClusterGroup from 'react-leaflet-cluster'
import { Marker } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import { useSettingsStore } from '../../store/settingsStore'
import type { Photo } from '../../types'

const DEFAULT_TILE = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'

function escAttr(s: string) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function createPhotoIcon(url: string, selected = false): L.DivIcon {
  const size = selected ? 52 : 44
  return L.divIcon({
    html: `<div style="width:${size}px;height:${size}px;border-radius:8px;overflow:hidden;border:2.5px solid white;box-shadow:0 2px 10px rgba(0,0,0,0.4);cursor:pointer;">
      <img src="${escAttr(url)}" style="width:100%;height:100%;object-fit:cover;" crossorigin="use-credentials" />
    </div>`,
    className: '',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -(size / 2)],
  })
}

function FitBounds({ photos }: { photos: Photo[] }) {
  const map = useMap()
  const fitted = useRef(false)

  useEffect(() => {
    if (fitted.current) return
    const points = photos.filter(p => p.latitude != null && p.longitude != null)
    if (points.length === 0) return
    const bounds = L.latLngBounds(points.map(p => [p.latitude!, p.longitude!]))
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 })
    fitted.current = true
  }, [photos.length])

  return null
}

interface PhotoMapViewProps {
  photos: Photo[]
  onPhotoClick: (photo: Photo) => void
}

export default function PhotoMapView({ photos, onPhotoClick }: PhotoMapViewProps) {
  const settings = useSettingsStore(s => s.settings)
  const tileUrl = settings.map_tile_url || DEFAULT_TILE

  const withCoords = photos.filter(p => p.latitude != null && p.longitude != null)

  if (withCoords.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, color: 'var(--text-faint)', padding: 40 }}>
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
        <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)' }}>No location data</p>
        <p style={{ margin: 0, fontSize: 13 }}>Photos need GPS coordinates to appear on the map. Re-sync your album to pick up location data.</p>
      </div>
    )
  }

  const center: [number, number] = [withCoords[0].latitude!, withCoords[0].longitude!]

  return (
    <div style={{ flex: 1, minHeight: 0 }}>
      <MapContainer
        center={center}
        zoom={10}
        style={{ width: '100%', height: '100%' }}
        zoomControl={true}
      >
        <TileLayer url={tileUrl} attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' />
        <FitBounds photos={withCoords} />
        <MarkerClusterGroup
          chunkedLoading
          maxClusterRadius={60}
          iconCreateFunction={(cluster) => {
            const count = cluster.getChildCount()
            const size = count > 99 ? 52 : count > 9 ? 46 : 40
            return L.divIcon({
              html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:rgba(17,24,39,0.85);border:2.5px solid white;box-shadow:0 2px 10px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:white;font-family:system-ui,sans-serif;">${count}</div>`,
              className: '',
              iconSize: [size, size],
              iconAnchor: [size / 2, size / 2],
            })
          }}
        >
          {withCoords.map(photo => (
            <Marker
              key={photo.id}
              position={[photo.latitude!, photo.longitude!]}
              icon={createPhotoIcon(photo.url!)}
              eventHandlers={{ click: () => onPhotoClick(photo) }}
            />
          ))}
        </MarkerClusterGroup>
      </MapContainer>
    </div>
  )
}
