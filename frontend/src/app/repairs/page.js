'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  getRepairsBoard,
  getRepairsOverdue,
  getBranches,
  getTechniciansWorkload,
  changeRepairStage,
  getAuthProfile,
  hasSession,
} from '../../lib/api';
import {
  Alert,
  AppHeader,
  Badge,
  Button,
  Card,
  Spinner,
  User,
  money,
} from '../../components/ui';

// All 10 stages in workflow order (F-12)
const STAGES = [
  'Received',
  'Diagnosing',
  'Waiting approval',
  'Waiting parts',
  'In repair',
  'Quality check',
  'Ready',
  'Delivered',
  'Unrepairable',
  'Cancelled',
];

const STAGE_TRANSITIONS = {
  Received: [{ to: 'Diagnosing', label: 'Diagnose' }, { to: 'Cancelled', label: 'Cancel' }],
  Diagnosing: [
    { to: 'Waiting approval', label: 'Ask Approval' },
    { to: 'Waiting parts', label: 'Wait Parts' },
    { to: 'In repair', label: 'Start Repair' },
    { to: 'Unrepairable', label: 'Unrepairable' },
    { to: 'Cancelled', label: 'Cancel' },
  ],
  'Waiting approval': [
    { to: 'In repair', label: 'Approve & Start' },
    { to: 'Diagnosing', label: 'Re-diagnose' },
    { to: 'Unrepairable', label: 'Unrepairable' },
    { to: 'Cancelled', label: 'Cancel' },
  ],
  'Waiting parts': [
    { to: 'In repair', label: 'Parts Arrived' },
    { to: 'Diagnosing', label: 'Re-diagnose' },
    { to: 'Unrepairable', label: 'Unrepairable' },
    { to: 'Cancelled', label: 'Cancel' },
  ],
  'In repair': [
    { to: 'Quality check', label: 'Done (QC)' },
    { to: 'Waiting parts', label: 'Wait Parts' },
    { to: 'Unrepairable', label: 'Unrepairable' },
    { to: 'Cancelled', label: 'Cancel' },
  ],
  'Quality check': [
    { to: 'Ready', label: 'Pass QC (Ready)' },
    { to: 'In repair', label: 'Rework' },
    { to: 'Cancelled', label: 'Cancel' },
  ],
  Ready: [
    { to: 'Delivered', label: 'Deliver' },
    { to: 'Cancelled', label: 'Cancel' },
  ],
  Delivered: [{ to: 'Diagnosing', label: 'Reopen', ownerOnly: true }],
  Unrepairable: [{ to: 'Diagnosing', label: 'Reopen', ownerOnly: true }],
  Cancelled: [{ to: 'Diagnosing', label: 'Reopen', ownerOnly: true }],
};

export default function RepairsBoardPage() {
  const router = useRouter();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [board, setBoard] = useState({});
  const [overdueList, setOverdueList] = useState([]);
  const [branches, setBranches] = useState([]);
  const [technicians, setTechnicians] = useState([]);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [selectedTechnician, setSelectedTechnician] = useState('');
  const [error, setError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');
  const [movingTicketId, setMovingTicketId] = useState(null);
  const [activeMobileStage, setActiveMobileStage] = useState('Received');

  const fetchBoard = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = {};
      if (selectedBranch) params.branchId = selectedBranch;
      if (selectedTechnician) params.technicianId = selectedTechnician;

      const [boardRes, overdueRes] = await Promise.all([
        getRepairsBoard(params),
        getRepairsOverdue(params).catch(() => ({ data: [] })),
      ]);

      setBoard(boardRes.data || {});
      setOverdueList(overdueRes.data || []);
    } catch (err) {
      setError(err.message || 'Failed to load repairs board.');
    } finally {
      setLoading(false);
    }
  }, [selectedBranch, selectedTechnician]);

  useEffect(() => {
    if (!hasSession()) {
      Promise.resolve().then(() => setLoading(false));
      return;
    }
    let ignore = false;
    getAuthProfile().then((p) => { if (!ignore) setProfile(p.data); }).catch(() => {});
    getBranches().then((b) => { if (!ignore) setBranches(b.data || []); }).catch(() => {});
    getTechniciansWorkload().then((w) => { if (!ignore) setTechnicians(w.data || []); }).catch(() => {});

    Promise.resolve().then(() => {
      if (!ignore) fetchBoard();
    });

    return () => { ignore = true; };
  }, [fetchBoard]);

  const isOverdue = (ticket) => {
    if (!ticket.promisedDate) return false;
    const isTerminalOrReady = ['Ready', 'Delivered', 'Cancelled', 'Unrepairable'].includes(ticket.stage);
    return !isTerminalOrReady && new Date(ticket.promisedDate) < new Date();
  };

  const isOwner = profile?.role?.key === 'owner';

  const handleStageMove = async (ticket, targetStage) => {
    // If ticket has advance and moving to Cancelled/Unrepairable, or invoice settled, redirect to ticket page
    if (['Cancelled', 'Unrepairable'].includes(targetStage) && ticket.advanceCents > 0 && !ticket.advanceSettled) {
      router.push(`/repairs/${ticket._id}?action=advance_decision&target=${encodeURIComponent(targetStage)}`);
      return;
    }

    if (targetStage === 'Delivered' && !ticket.isInvoiceSettled) {
      router.push(`/repairs/${ticket._id}?action=invoice`);
      return;
    }

    setMovingTicketId(ticket._id);
    setError('');
    setActionSuccess('');

    try {
      await changeRepairStage(ticket._id, {
        to: targetStage,
        note: `Stage moved from board to ${targetStage}`,
        waiveApproval: targetStage === 'In repair',
      });
      setActionSuccess(`Ticket ${ticket.ticketNo} moved to ${targetStage}`);
      fetchBoard();
    } catch (err) {
      // If error requires detailed action (like approval or settled invoice), route to detail page
      if (err.code === 'INVOICE_NOT_SETTLED' || err.code === 'APPROVAL_REQUIRED' || err.code === 'ADVANCE_DECISION_REQUIRED') {
        router.push(`/repairs/${ticket._id}`);
      } else {
        setError(err.message || 'Failed to change stage.');
      }
    } finally {
      setMovingTicketId(null);
    }
  };

  if (!hasSession()) {
    return (
      <Shell>
        <Alert tone="warning">
          Please <Link href="/">log in</Link> to view and manage repairs.
        </Alert>
      </Shell>
    );
  }

  const overdueCount = overdueList.length;

  const renderTicketCard = (ticket, stage) => {
    const overdue = isOverdue(ticket);
    const allowedMoves = (STAGE_TRANSITIONS[stage] || []).filter(
      (m) => !m.ownerOnly || isOwner
    );

    return (
      <div
        key={ticket._id}
        style={{
          background: 'var(--surface)',
          border: overdue ? '2px solid var(--danger)' : '1px solid var(--border)',
          borderRadius: 12,
          padding: 12,
          display: 'grid',
          gap: 8,
          boxShadow: '0 1px 2px rgba(16, 24, 40, 0.04)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Link
            href={`/repairs/${ticket._id}`}
            style={{
              fontWeight: 800,
              fontSize: 14,
              color: 'var(--brand)',
              textDecoration: 'none',
              minHeight: 44,
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            {ticket.ticketNo}
          </Link>

          {overdue && (
            <span
              style={{
                background: 'var(--danger-bg)',
                color: 'var(--danger)',
                fontSize: 11,
                fontWeight: 800,
                padding: '2px 8px',
                borderRadius: 999,
                border: '1px solid var(--danger)',
              }}
              role="status"
            >
              OVERDUE
            </span>
          )}
        </div>

        <div style={{ fontSize: 13, color: 'var(--heading)', fontWeight: 600 }}>
          {ticket.device?.brand} {ticket.device?.model}
        </div>

        <div style={{ fontSize: 12, color: 'var(--secondary)' }}>
          Customer: {ticket.customerId?.name || 'Walk-in'}
        </div>

        <p
          style={{
            fontSize: 12,
            color: 'var(--body)',
            background: 'var(--bg)',
            padding: '6px 8px',
            borderRadius: 6,
            margin: 0,
            lineHeight: 1.3,
          }}
        >
          {ticket.faultDescription}
        </p>

        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)' }}>
          <span>Tech: {ticket.technicianId?.name || 'Unassigned'}</span>
          {ticket.advanceCents > 0 && <span>Adv: {money(ticket.advanceCents)}</span>}
        </div>

        {/* Quick Stage Transition Actions */}
        {allowedMoves.length > 0 && (
          <div
            style={{
              display: 'flex',
              gap: 6,
              flexWrap: 'wrap',
              marginTop: 6,
              paddingTop: 6,
              borderTop: '1px solid var(--border)',
            }}
          >
            {allowedMoves.map((m) => (
              <button
                key={m.to}
                onClick={() => handleStageMove(ticket, m.to)}
                disabled={movingTicketId === ticket._id}
                style={{
                  border: '1px solid var(--input-border)',
                  background: 'var(--surface)',
                  color: m.to === 'Cancelled' ? 'var(--danger)' : 'var(--heading)',
                  borderRadius: 6,
                  padding: '6px 10px',
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: 'pointer',
                  minHeight: 44,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                aria-label={`Move ticket ${ticket.ticketNo} to ${m.to}`}
              >
                {movingTicketId === ticket._id ? 'Moving...' : m.label}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <Shell user={profile?.name}>
      <style jsx global>{`
        @media (max-width: 640px) {
          .repairs-board-desktop {
            display: none !important;
          }
          .repairs-board-mobile {
            display: block !important;
          }
        }
        @media (min-width: 641px) {
          .repairs-board-desktop {
            display: grid !important;
          }
          .repairs-board-mobile {
            display: none !important;
          }
        }
      `}</style>
      {/* Top Header / Actions */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 16,
        }}
      >
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: 'var(--heading)' }}>Repairs Kanban Board</h1>
          <p style={{ color: 'var(--secondary)', fontSize: 13, marginTop: 4 }}>
            Track device repair jobs across all 10 workflow stages.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {overdueCount > 0 && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 14px',
                borderRadius: 999,
                background: 'var(--danger-bg)',
                color: 'var(--danger)',
                fontWeight: 700,
                fontSize: 13,
                border: '1px solid var(--danger)',
              }}
              role="status"
              aria-label={`${overdueCount} overdue tickets`}
            >
              Overdue Tickets: {overdueCount}
            </span>
          )}

          <Button
            variant="secondary"
            onClick={fetchBoard}
            style={{ minHeight: 44, padding: '0 16px' }}
            aria-label="Refresh board"
          >
            Refresh
          </Button>

          <Link href="/repairs/new" style={{ textDecoration: 'none' }}>
            <Button style={{ minHeight: 44, padding: '0 20px' }}>
              + New Repair Ticket
            </Button>
          </Link>
        </div>
      </div>

      {error && (
        <Alert tone="danger">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{error}</span>
            <button
              onClick={() => setError('')}
              style={{
                background: 'transparent',
                border: 0,
                color: 'inherit',
                fontWeight: 700,
                cursor: 'pointer',
                minHeight: 44,
                minWidth: 44,
              }}
              aria-label="Dismiss error"
            >
              Dismiss
            </button>
          </div>
        </Alert>
      )}

      {actionSuccess && (
        <Alert tone="success">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{actionSuccess}</span>
            <button
              onClick={() => setActionSuccess('')}
              style={{
                background: 'transparent',
                border: 0,
                color: 'inherit',
                fontWeight: 700,
                cursor: 'pointer',
                minHeight: 44,
                minWidth: 44,
              }}
              aria-label="Dismiss success notice"
            >
              Dismiss
            </button>
          </div>
        </Alert>
      )}

      {/* Filters Toolbar */}
      <Card style={{ padding: 14 }}>
        <div
          style={{
            display: 'flex',
            gap: 16,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 700, color: 'var(--label)' }}>
            Branch
            <select
              value={selectedBranch}
              onChange={(e) => setSelectedBranch(e.target.value)}
              style={{
                border: '1px solid var(--input-border)',
                borderRadius: 8,
                padding: '8px 12px',
                minHeight: 44,
                fontSize: 14,
                background: 'var(--surface)',
                color: 'var(--heading)',
              }}
              aria-label="Filter by branch"
            >
              <option value="">All Branches</option>
              {branches.map((b) => (
                <option key={b._id} value={b._id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 700, color: 'var(--label)' }}>
            Technician
            <select
              value={selectedTechnician}
              onChange={(e) => setSelectedTechnician(e.target.value)}
              style={{
                border: '1px solid var(--input-border)',
                borderRadius: 8,
                padding: '8px 12px',
                minHeight: 44,
                fontSize: 14,
                background: 'var(--surface)',
                color: 'var(--heading)',
              }}
              aria-label="Filter by technician"
            >
              <option value="">All Technicians</option>
              {technicians.map((t) => (
                <option key={t._id} value={t._id}>
                  {t.name} ({t.activeTicketsCount ?? 0} active)
                </option>
              ))}
            </select>
          </label>
        </div>
      </Card>

      {/* Kanban Board Grid */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '60px 0' }}>
          <Spinner />
          <p style={{ marginTop: 12, color: 'var(--secondary)' }}>Loading repair board...</p>
        </div>
      ) : (
        <>
          {/* Desktop Kanban Board */}
          <div
            className="repairs-board-desktop"
            style={{
              display: 'grid',
              gridAutoFlow: 'column',
              gridAutoColumns: '310px',
              gap: 14,
              overflowX: 'auto',
              paddingBottom: 24,
              alignItems: 'start',
            }}
            role="region"
            aria-label="Repair stages kanban board"
          >
            {STAGES.map((stage) => {
              const column = board[stage] || { count: 0, items: [] };
              const isTerminal = ['Delivered', 'Unrepairable', 'Cancelled'].includes(stage);

              return (
                <div
                  key={stage}
                  style={{
                    background: isTerminal ? '#f0f3f8' : 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: 16,
                    display: 'flex',
                    flexDirection: 'column',
                    maxHeight: 'calc(100vh - 220px)',
                    boxShadow: '0 1px 3px rgba(16, 24, 40, 0.05)',
                  }}
                >
                  {/* Column Header */}
                  <div
                    style={{
                      padding: '14px 16px',
                      borderBottom: '1px solid var(--border)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      background: isTerminal ? 'transparent' : 'rgba(238, 242, 255, 0.4)',
                      borderTopLeftRadius: 16,
                      borderTopRightRadius: 16,
                    }}
                  >
                    <strong style={{ fontSize: 14, color: 'var(--heading)' }}>{stage}</strong>
                    <span
                      style={{
                        background: 'var(--tint)',
                        color: 'var(--brand)',
                        fontSize: 12,
                        fontWeight: 800,
                        padding: '2px 8px',
                        borderRadius: 999,
                      }}
                    >
                      {column.count}
                    </span>
                  </div>

                  {/* Column Items */}
                  <div
                    style={{
                      padding: 12,
                      display: 'grid',
                      gap: 10,
                      overflowY: 'auto',
                    }}
                  >
                    {column.items.length === 0 ? (
                      <div style={{ padding: '24px 8px', textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
                        No tickets in {stage}
                      </div>
                    ) : (
                      column.items.map((ticket) => renderTicketCard(ticket, stage))
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Mobile Stage Selector & Card List */}
          <div className="repairs-board-mobile" style={{ display: 'none' }}>
            <div
              style={{
                display: 'flex',
                gap: 8,
                overflowX: 'auto',
                paddingBottom: 10,
                marginBottom: 16,
                WebkitOverflowScrolling: 'touch',
              }}
            >
              {STAGES.map((st) => {
                const count = board[st]?.count ?? 0;
                const isSelected = activeMobileStage === st;
                return (
                  <button
                    key={st}
                    type="button"
                    onClick={() => setActiveMobileStage(st)}
                    style={{
                      flex: 'none',
                      padding: '8px 14px',
                      borderRadius: 999,
                      border: isSelected ? '2px solid var(--brand)' : '1px solid var(--border)',
                      background: isSelected ? 'var(--tint)' : 'var(--surface)',
                      color: isSelected ? 'var(--brand)' : 'var(--heading)',
                      fontWeight: 700,
                      fontSize: 13,
                      cursor: 'pointer',
                      minHeight: 44,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <span>{st}</span>
                    <span
                      style={{
                        background: isSelected ? 'var(--brand)' : 'var(--muted-bg, #e2e8f0)',
                        color: isSelected ? '#ffffff' : 'var(--secondary)',
                        borderRadius: 999,
                        padding: '2px 6px',
                        fontSize: 11,
                        fontWeight: 800,
                      }}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Mobile Stage Cards List */}
            <div style={{ display: 'grid', gap: 10 }}>
              {(board[activeMobileStage]?.items || []).length === 0 ? (
                <div
                  style={{
                    textAlign: 'center',
                    padding: '36px 16px',
                    background: 'var(--surface)',
                    borderRadius: 12,
                    border: '1px solid var(--border)',
                    color: 'var(--secondary)',
                  }}
                >
                  <p style={{ margin: 0, fontWeight: 600 }}>No tickets in {activeMobileStage}</p>
                  <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--muted)' }}>
                    Select another stage above or create a new ticket.
                  </p>
                </div>
              ) : (
                (board[activeMobileStage]?.items || []).map((ticket) =>
                  renderTicketCard(ticket, activeMobileStage)
                )
              )}
            </div>
          </div>
        </>
      )}
    </Shell>
  );
}

function Shell({ children, user }) {
  return (
    <>
      <AppHeader chip="Repairs & Service">
        <Link href="/" id="link-dashboard" style={{ fontWeight: 600, minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>
          Dashboard
        </Link>
        <Link href="/repairs" id="link-repairs" style={{ fontWeight: 600, color: 'var(--brand)', minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>
          Board
        </Link>
        <Link href="/pos" id="link-pos" style={{ fontWeight: 600, minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>
          Point of Sale
        </Link>
        {user && <User name={user} />}
      </AppHeader>
      <main
        style={{
          maxWidth: 1600,
          margin: '0 auto',
          padding: '24px 16px 48px',
          display: 'grid',
          gap: 18,
        }}
      >
        {children}
      </main>
    </>
  );
}
