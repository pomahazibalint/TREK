import React, { useState, useEffect } from 'react'
import { useAuthStore } from '../../store/authStore'
import { useTranslation } from '../../i18n'
import { useAddonStore } from '../../store/addonStore'
import { MessageCircle, StickyNote, BarChart3, Sparkles } from 'lucide-react'
import CollabChat from './CollabChat'
import CollabNotes from './CollabNotes'
import CollabPolls from './CollabPolls'
import WhatsNextWidget from './WhatsNextWidget'

function useIsDesktop(breakpoint = 1024) {
  const [isDesktop, setIsDesktop] = useState(window.innerWidth >= breakpoint)
  useEffect(() => {
    const check = () => setIsDesktop(window.innerWidth >= breakpoint)
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [breakpoint])
  return isDesktop
}

const card: React.CSSProperties = {
  display: 'flex', flexDirection: 'column',
  background: 'var(--bg-card)', borderRadius: 16, border: '1px solid var(--border-faint)',
  overflow: 'hidden', minHeight: 0,
}

interface TripMember {
  id: number
  username: string
  avatar_url?: string | null
}

interface CollabPanelProps {
  tripId: number | string
  tripMembers?: TripMember[]
}

export default function CollabPanel({ tripId, tripMembers = [] }: CollabPanelProps) {
  const { user } = useAuthStore()
  const { t } = useTranslation()
  const isSubEnabled = useAddonStore(s => s.isSubEnabled)
  const chatEnabled = isSubEnabled('collab', 'chat_enabled')
  const notesEnabled = isSubEnabled('collab', 'notes_enabled')
  const pollsEnabled = isSubEnabled('collab', 'polls_enabled')

  const allTabs = [
    { id: 'chat', label: t('collab.tabs.chat') || 'Chat', icon: MessageCircle, enabled: chatEnabled },
    { id: 'notes', label: t('collab.tabs.notes') || 'Notes', icon: StickyNote, enabled: notesEnabled },
    { id: 'polls', label: t('collab.tabs.polls') || 'Polls', icon: BarChart3, enabled: pollsEnabled },
    { id: 'next', label: t('collab.whatsNext.title') || "What's Next", icon: Sparkles, enabled: true },
  ]
  const tabs = allTabs.filter(t => t.enabled)

  const [mobileTab, setMobileTab] = useState(() => tabs[0]?.id || 'next')
  const isDesktop = useIsDesktop()

  // Reset mobile tab if selected tab gets disabled
  useEffect(() => {
    if (!tabs.find(t => t.id === mobileTab)) setMobileTab(tabs[0]?.id || 'next')
  }, [chatEnabled, notesEnabled, pollsEnabled])

  if (isDesktop) {
    return (
      <div style={{ height: '100%', display: 'flex', gap: 12, padding: 12, overflow: 'hidden', minHeight: 0 }}>
        {/* Chat — left, fixed width */}
        {chatEnabled && (
          <div style={{ ...card, flex: '0 0 380px' }}>
            <CollabChat tripId={tripId} currentUser={user} />
          </div>
        )}

        {/* Right column: Notes top, Polls + What's Next bottom */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'hidden', minHeight: 0 }}>
          {notesEnabled && (
            <div style={{ ...card, flex: 1 }}>
              <CollabNotes tripId={tripId} currentUser={user} />
            </div>
          )}

          <div style={{ flex: 1, display: 'flex', gap: 12, overflow: 'hidden', minHeight: 0 }}>
            {pollsEnabled && (
              <div style={{ ...card, flex: 1 }}>
                <CollabPolls tripId={tripId} currentUser={user} />
              </div>
            )}
            <div style={{ ...card, flex: 1 }}>
              <WhatsNextWidget tripMembers={tripMembers} />
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Mobile: tab bar + single panel
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'absolute', inset: 0 }}>
      <div style={{
        display: 'flex', gap: 2, padding: '8px 12px', borderBottom: '1px solid var(--border-faint)',
        background: 'var(--bg-card)', flexShrink: 0,
      }}>
        {tabs.map(tab => {
          const Icon = tab.icon
          const active = mobileTab === tab.id
          return (
            <button key={tab.id} onClick={() => setMobileTab(tab.id)} style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: '8px 0', borderRadius: 10, border: 'none', cursor: 'pointer',
              background: active ? 'var(--accent)' : 'transparent',
              color: active ? 'var(--accent-text)' : 'var(--text-muted)',
              fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
              transition: 'all 0.15s',
            }}>
              {tab.label}
            </button>
          )
        })}
      </div>

      <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
        {mobileTab === 'chat' && chatEnabled && <CollabChat tripId={tripId} currentUser={user} />}
        {mobileTab === 'notes' && notesEnabled && <CollabNotes tripId={tripId} currentUser={user} />}
        {mobileTab === 'polls' && pollsEnabled && <CollabPolls tripId={tripId} currentUser={user} />}
        {mobileTab === 'next' && <WhatsNextWidget tripMembers={tripMembers} />}
      </div>
    </div>
  )
}
