import React, { useState } from 'react'
import { Upload, X, Check, AlertCircle } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useToast } from '../shared/Toast'

export interface ParsedBooking {
  title: string
  type: string
  confirmation_number?: string
  reservation_time?: string
  reservation_end_time?: string
  location?: string
  notes?: string
  metadata?: Record<string, string>
}

interface BookingImportModalProps {
  tripId: string
  isOpen: boolean
  onClose: () => void
  onSave?: (booking: ParsedBooking) => void
}

export default function BookingImportModal({ tripId, isOpen, onClose, onSave }: BookingImportModalProps): React.ReactElement | null {
  const { t } = useTranslation()
  const { showToast } = useToast()

  const [activeTab, setActiveTab] = useState<'paste' | 'file'>('paste')
  const [pastedText, setPastedText] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<ParsedBooking[]>([])
  const [error, setError] = useState<string | null>(null)

  const handleParse = async () => {
    setError(null)
    setResults([])
    setLoading(true)

    try {
      const text = activeTab === 'paste' ? pastedText : ''
      const file = activeTab === 'file' ? selectedFile : null

      if (activeTab === 'paste' && !text.trim()) {
        setError(t('common.error') + ': Please paste booking confirmation text')
        setLoading(false)
        return
      }

      if (activeTab === 'file' && !file) {
        setError(t('common.error') + ': Please select a file')
        setLoading(false)
        return
      }

      const formData = new FormData()
      if (activeTab === 'file' && file) {
        formData.append('file', file)
      }

      const endpoint = activeTab === 'paste'
        ? `/api/trips/${tripId}/reservations/parse`
        : `/api/trips/${tripId}/reservations/parse-file`

      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        ...(activeTab === 'paste'
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text.trim() }) }
          : { body: formData }
        ),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to parse booking')
      }

      const data = await response.json()
      if (data.results && data.results.length > 0) {
        setResults(data.results)
      } else {
        setError('No bookings found in the provided content')
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to parse booking')
    } finally {
      setLoading(false)
    }
  }

  const handleSaveBooking = (booking: ParsedBooking) => {
    onSave?.(booking)
    showToast(`${booking.title} added`, 'success')
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-auto" style={{ background: 'var(--bg-card)' }}>
        {/* Header */}
        <div className="sticky top-0 flex items-center justify-between p-4 border-b" style={{ borderColor: 'var(--border-secondary)' }}>
          <h2 className="text-lg font-semibold">{t('common.import')} Booking</h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-lg transition-colors">
            <X size={20} style={{ color: 'var(--text-secondary)' }} />
          </button>
        </div>

        {/* Tabs */}
        {results.length === 0 && (
          <div className="flex gap-4 p-4 border-b" style={{ borderColor: 'var(--border-secondary)' }}>
            <button
              onClick={() => setActiveTab('paste')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                activeTab === 'paste'
                  ? 'text-blue-600 bg-blue-50 dark:bg-blue-900/20'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-zinc-800'
              }`}>
              Paste text
            </button>
            <button
              onClick={() => setActiveTab('file')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                activeTab === 'file'
                  ? 'text-blue-600 bg-blue-50 dark:bg-blue-900/20'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-zinc-800'
              }`}>
              Upload file
            </button>
          </div>
        )}

        {/* Content */}
        <div className="p-6">
          {results.length === 0 ? (
            <>
              {/* Paste tab */}
              {activeTab === 'paste' && (
                <div className="space-y-4">
                  <textarea
                    value={pastedText}
                    onChange={e => setPastedText(e.target.value)}
                    placeholder="Paste your booking confirmation email or text here..."
                    className="w-full h-48 p-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                    style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                  />
                  {error && (
                    <div className="flex gap-2 p-3 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 rounded-lg">
                      <AlertCircle size={18} className="flex-shrink-0 mt-0.5" />
                      <span className="text-sm">{error}</span>
                    </div>
                  )}
                </div>
              )}

              {/* File tab */}
              {activeTab === 'file' && (
                <div className="space-y-4">
                  <div className="relative border-2 border-dashed rounded-lg p-8 text-center" style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-secondary)' }}>
                    <Upload size={32} className="mx-auto mb-2" style={{ color: 'var(--text-muted)' }} />
                    <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                      {selectedFile ? selectedFile.name : 'Drag & drop or click to select file'}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      .ics, .csv, .txt, .eml, .html
                    </p>
                    <input
                      type="file"
                      onChange={e => setSelectedFile(e.target.files?.[0] || null)}
                      accept=".ics,.csv,.txt,.eml,.html,.htm"
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer rounded-lg"
                    />
                  </div>
                  {error && (
                    <div className="flex gap-2 p-3 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 rounded-lg">
                      <AlertCircle size={18} className="flex-shrink-0 mt-0.5" />
                      <span className="text-sm">{error}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Parse button */}
              <button
                onClick={handleParse}
                disabled={loading || (!pastedText.trim() && !selectedFile)}
                className="w-full mt-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white rounded-lg font-medium transition-colors">
                {loading ? 'Parsing...' : 'Parse booking'}
              </button>
            </>
          ) : (
            <>
              {/* Results */}
              <div className="space-y-4">
                <p className="text-sm font-medium">
                  Found {results.length} booking{results.length !== 1 ? 's' : ''}
                </p>
                {results.map((booking, idx) => (
                  <div key={idx} className="border rounded-lg p-4" style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-secondary)' }}>
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                          {booking.title}
                        </h3>
                        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                          Type: <span className="font-medium capitalize">{booking.type}</span>
                        </p>
                        {booking.confirmation_number && (
                          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                            Conf #: <span className="font-mono font-medium">{booking.confirmation_number}</span>
                          </p>
                        )}
                        {booking.reservation_time && (
                          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                            Date: {new Date(booking.reservation_time).toLocaleDateString()}
                          </p>
                        )}
                        {booking.location && (
                          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                            Location: {booking.location}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() => handleSaveBooking(booking)}
                        className="flex-shrink-0 p-2 rounded-lg bg-green-100 hover:bg-green-200 dark:bg-green-900/20 dark:hover:bg-green-900/40 text-green-700 dark:text-green-300 transition-colors"
                        title="Add this booking">
                        <Check size={18} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Back button */}
              <button
                onClick={() => {
                  setResults([])
                  setPastedText('')
                  setSelectedFile(null)
                  setError(null)
                }}
                className="w-full mt-4 py-2 border rounded-lg font-medium transition-colors"
                style={{ borderColor: 'var(--border-secondary)', color: 'var(--text-secondary)' }}>
                Import another booking
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
