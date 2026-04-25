import React, { useState } from 'react'
import { Mail, Plane, Send } from 'lucide-react'
import { useTranslation } from '../i18n'

export default function ForgotPasswordPage(): React.ReactElement {
  const { t } = useTranslation()
  const [email, setEmail] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

  const inputBase: React.CSSProperties = {
    width: '100%', padding: '11px 12px 11px 40px', border: '1px solid #e5e7eb',
    borderRadius: 12, fontSize: 14, fontFamily: 'inherit', outline: 'none',
    color: '#111827', background: 'white', boxSizing: 'border-box', transition: 'border-color 0.15s',
  }

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault()
    setError('')
    setIsLoading(true)
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error || 'Request failed')
      }
      setDone(true)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f9fafb', fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif", padding: '32px 24px' }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, marginBottom: 32 }}>
          <img src="/logo-dark.svg" alt="TREK" style={{ height: 48 }} />
        </div>

        <div style={{ background: 'white', borderRadius: 20, border: '1px solid #e5e7eb', padding: '36px 32px', boxShadow: '0 2px 16px rgba(0,0,0,0.06)' }}>
          {done ? (
            <div style={{ textAlign: 'center' }}>
              <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#f0fdf4', border: '1px solid #bbf7d0', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                <Mail size={24} style={{ color: '#16a34a' }} />
              </div>
              <h2 style={{ margin: '0 0 8px', fontSize: 20, fontWeight: 800, color: '#111827' }}>{t('forgotPassword.successTitle')}</h2>
              <p style={{ margin: '0 0 24px', fontSize: 14, color: '#6b7280', lineHeight: 1.6 }}>{t('forgotPassword.successMsg')}</p>
              <a href="/login" style={{ fontSize: 13, color: '#6b7280', textDecoration: 'none' }}
                onMouseEnter={(e: React.MouseEvent<HTMLAnchorElement>) => e.currentTarget.style.color = '#111827'}
                onMouseLeave={(e: React.MouseEvent<HTMLAnchorElement>) => e.currentTarget.style.color = '#6b7280'}
              >{t('forgotPassword.backToLogin')}</a>
            </div>
          ) : (
            <>
              <h2 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 800, color: '#111827' }}>{t('forgotPassword.title')}</h2>
              <p style={{ margin: '0 0 28px', fontSize: 13.5, color: '#9ca3af' }}>{t('forgotPassword.subtitle')}</p>

              <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {error && (
                  <div style={{ padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, fontSize: 13, color: '#dc2626' }}>
                    {error}
                  </div>
                )}
                <div>
                  <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: '#374151', marginBottom: 6 }}>{t('forgotPassword.email')}</label>
                  <div style={{ position: 'relative' }}>
                    <Mail size={15} style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', pointerEvents: 'none' }} />
                    <input
                      type="email" value={email} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)} required
                      placeholder="your@email.com" style={inputBase}
                      onFocus={(e: React.FocusEvent<HTMLInputElement>) => e.target.style.borderColor = '#111827'}
                      onBlur={(e: React.FocusEvent<HTMLInputElement>) => e.target.style.borderColor = '#e5e7eb'}
                    />
                  </div>
                </div>

                <button type="submit" disabled={isLoading} style={{
                  marginTop: 4, width: '100%', padding: '12px', background: '#111827', color: 'white',
                  border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 700, cursor: isLoading ? 'default' : 'pointer',
                  fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  opacity: isLoading ? 0.7 : 1, transition: 'opacity 0.15s',
                }}
                  onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => { if (!isLoading) e.currentTarget.style.background = '#1f2937' }}
                  onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => e.currentTarget.style.background = '#111827'}
                >
                  {isLoading
                    ? <><div style={{ width: 15, height: 15, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: 'white', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />{t('forgotPassword.sending')}</>
                    : <><Send size={15} />{t('forgotPassword.submit')}</>
                  }
                </button>
              </form>

              <p style={{ textAlign: 'center', marginTop: 20, fontSize: 13, color: '#9ca3af' }}>
                <a href="/login" style={{ color: '#6b7280', textDecoration: 'none' }}
                  onMouseEnter={(e: React.MouseEvent<HTMLAnchorElement>) => e.currentTarget.style.color = '#111827'}
                  onMouseLeave={(e: React.MouseEvent<HTMLAnchorElement>) => e.currentTarget.style.color = '#6b7280'}
                >{t('forgotPassword.backToLogin')}</a>
              </p>
            </>
          )}
        </div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}
