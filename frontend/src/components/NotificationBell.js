'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { getInAppNotifications, markInAppNotificationRead, markAllInAppNotificationsRead } from '../lib/api';

/**
 * In-app Notification Bell header component.
 * Displays unread notification count badge and a dropdown of recent alerts.
 * Follows accessibility guidelines: 44x44px touch target, visible focus ring, status as text.
 */
export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const menuRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const res = await getInAppNotifications('limit=10');
      if (res && res.data) {
        setItems(res.data);
        setUnreadCount(res.unreadCount || 0);
      }
    } catch {
      // Quiet fail if not logged in or offline
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000); // Polling every 30s
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    function handleClickOutside(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open]);

  const handleMarkRead = async (id) => {
    try {
      await markInAppNotificationRead(id);
      await load();
    } catch {
      // Quiet fail
    }
  };

  const handleMarkAllRead = async () => {
    try {
      setLoading(true);
      await markAllInAppNotificationsRead();
      await load();
    } finally {
      setLoading(false);
    }
  };

  return (
    // TODO: swap for shared component if UI library adds a Popover/Dropdown
    <div ref={menuRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        aria-label="In-app notifications"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        style={{
          minWidth: 44,
          minHeight: 44,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--surface)',
          border: '1px solid var(--input-border)',
          borderRadius: 22,
          cursor: 'pointer',
          position: 'relative',
          padding: '0 10px',
          color: 'var(--body)',
        }}
      >
        <span aria-hidden="true" style={{ fontSize: 18 }}>🔔</span>
        {unreadCount > 0 && (
          <span
            style={{
              position: 'absolute',
              top: -2,
              right: -2,
              background: 'var(--danger)',
              color: '#fff',
              fontSize: 11,
              fontWeight: 700,
              borderRadius: 10,
              minWidth: 18,
              height: 18,
              lineHeight: '18px',
              padding: '0 4px',
              textAlign: 'center',
            }}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="region"
          aria-label="Notification list"
          style={{
            position: 'absolute',
            right: 0,
            top: 48,
            width: 340,
            maxWidth: '90vw',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            zIndex: 1000,
            padding: 16,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <strong style={{ fontSize: 15, color: 'var(--heading)' }}>Notifications</strong>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                disabled={loading}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--brand)',
                  fontSize: 12,
                  cursor: 'pointer',
                  padding: 4,
                  minHeight: 44,
                  display: 'inline-flex',
                  alignItems: 'center',
                }}
              >
                Mark all read
              </button>
            )}
          </div>

          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            {items.length === 0 ? (
              <p style={{ color: 'var(--muted)', fontSize: 13, padding: '16px 0', textAlign: 'center' }}>
                No notifications right now.
              </p>
            ) : (
              items.map((item) => (
                <div
                  key={item._id}
                  style={{
                    padding: '10px 0',
                    borderBottom: '1px solid var(--border)',
                    opacity: item.readAt ? 0.7 : 1,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                        {/* Status as text not colour only */}
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            padding: '1px 6px',
                            borderRadius: 4,
                            textTransform: 'uppercase',
                            background:
                              item.level === 'warning'
                                ? 'var(--warning-bg)'
                                : item.level === 'danger'
                                ? 'var(--danger-bg)'
                                : 'var(--tint)',
                            color:
                              item.level === 'warning'
                                ? 'var(--warning)'
                                : item.level === 'danger'
                                ? 'var(--danger)'
                                : 'var(--brand)',
                          }}
                        >
                          {item.level || 'INFO'}
                        </span>
                        <strong style={{ fontSize: 13, color: 'var(--heading)' }}>{item.title}</strong>
                      </div>
                      <p style={{ fontSize: 12, color: 'var(--body)', margin: '4px 0' }}>{item.body}</p>
                    </div>
                    {!item.readAt && (
                      <button
                        type="button"
                        aria-label="Mark notification read"
                        onClick={() => handleMarkRead(item._id)}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--secondary)',
                          fontSize: 12,
                          cursor: 'pointer',
                          marginLeft: 8,
                          minWidth: 44,
                          minHeight: 44,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        ✓
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <div style={{ marginTop: 12, paddingTop: 8, borderTop: '1px solid var(--border)', textAlign: 'center' }}>
            <Link
              href="/notifications"
              onClick={() => setOpen(false)}
              style={{
                fontSize: 13,
                color: 'var(--brand)',
                textDecoration: 'none',
                minHeight: 44,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              View Templates & Logs →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
