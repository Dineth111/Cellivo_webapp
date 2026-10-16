'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  getRepairTicket,
  changeRepairStage,
  assignRepairTechnician,
  recordRepairApproval,
  addRepairPart,
  removeRepairPart,
  searchRepairParts,
  settleRepairInvoice,
  setRepairWarranty,
  getTechniciansWorkload,
  getAuthProfile,
  hasSession,
} from '../../../lib/api';
import {
  Alert,
  AppHeader,
  Badge,
  Button,
  Card,
  Field,
  Spinner,
  Table,
  User,
  money,
  date,
} from '../../../components/ui';

const STAGE_ORDER = [
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
  Received: ['Diagnosing', 'Cancelled'],
  Diagnosing: ['Waiting approval', 'Waiting parts', 'In repair', 'Unrepairable', 'Cancelled'],
  'Waiting approval': ['In repair', 'Diagnosing', 'Unrepairable', 'Cancelled'],
  'Waiting parts': ['In repair', 'Diagnosing', 'Unrepairable', 'Cancelled'],
  'In repair': ['Quality check', 'Waiting parts', 'Unrepairable', 'Cancelled'],
  'Quality check': ['Ready', 'In repair', 'Cancelled'],
  Ready: ['Delivered', 'Cancelled'],
  Delivered: ['Diagnosing'], // Owner reopen only
  Unrepairable: ['Diagnosing'], // Owner reopen only
  Cancelled: ['Diagnosing'], // Owner reopen only
};

function validateRupeeAmount(val, fieldName, { required = false } = {}) {
  if (val === undefined || val === null || String(val).trim() === '') {
    if (required) return `${fieldName} is required.`;
    return null;
  }
  const s = String(val).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    return `${fieldName} must be a valid positive amount with up to 2 decimal places.`;
  }
  const num = Number(s);
  if (isNaN(num) || num < 0) {
    return `${fieldName} cannot be negative.`;
  }
  return null;
}

function parseRupeeToCents(val) {
  if (val === undefined || val === null || String(val).trim() === '') return 0;
  const num = Number(String(val).trim());
  return isNaN(num) || num < 0 ? 0 : Math.round(num * 100);
}

export default function RepairTicketDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = params?.id;

  const [profile, setProfile] = useState(null);
  const [ticket, setTicket] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Passcode state (audited reveal)
  const [revealedPasscode, setRevealedPasscode] = useState(null);
  const [revealingPasscode, setRevealingPasscode] = useState(false);

  // Technician assignment
  const [technicians, setTechnicians] = useState([]);
  const [selectedTechId, setSelectedTechId] = useState('');
  const [assigningTech, setAssigningTech] = useState(false);

  // Approval recording
  const [approvalDecision, setApprovalDecision] = useState('approved');
  const [approvalChannel, setApprovalChannel] = useState('in_person');
  const [recordingApproval, setRecordingApproval] = useState(false);

  // Parts management & inventory search
  const [partName, setPartName] = useState('');
  const [partSku, setPartSku] = useState('');
  const [partQty, setPartQty] = useState(1);
  const [partPriceRs, setPartPriceRs] = useState('');
  const [partCostRs, setPartCostRs] = useState('');
  const [addingPart, setAddingPart] = useState(false);
  const [removingPartId, setRemovingPartId] = useState(null);
  const [partSearchQuery, setPartSearchQuery] = useState('');
  const [partSearchResults, setPartSearchResults] = useState([]);
  const [searchingParts, setSearchingParts] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [isFreeTextPart, setIsFreeTextPart] = useState(false);

  // Invoicing
  const [labourRs, setLabourRs] = useState('');
  const [invoicePaymentMethod, setInvoicePaymentMethod] = useState('cash');
  const [settlingInvoice, setSettlingInvoice] = useState(false);

  // Warranty
  const [warrantyDaysInput, setWarrantyDaysInput] = useState('');
  const [savingWarranty, setSavingWarranty] = useState(false);

  // Advance cancellation / unrepairable modal dialog
  const [showAdvanceModal, setShowAdvanceModal] = useState(false);
  const [targetAdvanceStage, setTargetAdvanceStage] = useState('Cancelled');
  const [advanceDecision, setAdvanceDecision] = useState('refund');
  const [advanceFeeRs, setAdvanceFeeRs] = useState('');
  const [advanceRefundMethod, setAdvanceRefundMethod] = useState('cash');
  const [cancellationNote, setCancellationNote] = useState('');
  const [processingAdvanceDecision, setProcessingAdvanceDecision] = useState(false);

  // Stage transition general
  const [transitioningStage, setTransitioningStage] = useState(false);
  const [stageNote, setStageNote] = useState('');
  const [waiveApprovalChoice, setWaiveApprovalChoice] = useState(false);

  const fetchTicket = useCallback(async () => {
    if (!id) return;
    setError('');
    try {
      const res = await getRepairTicket(id);
      setTicket(res.data);
      if (res.data.technicianId?._id) {
        setSelectedTechId(res.data.technicianId._id);
      }
      if (res.data.labourCents !== undefined) {
        setLabourRs((res.data.labourCents / 100).toString());
      }
      if (res.data.warrantyDays !== undefined) {
        setWarrantyDaysInput(res.data.warrantyDays.toString());
      }
      if (res.data.advancePaymentMethod) {
        setAdvanceRefundMethod(res.data.advancePaymentMethod);
      }
    } catch (err) {
      setError(err.message || 'Failed to load ticket details.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!hasSession()) {
      Promise.resolve().then(() => setLoading(false));
      return;
    }

    let ignore = false;
    getAuthProfile().then((p) => { if (!ignore) setProfile(p.data); }).catch(() => {});
    getTechniciansWorkload().then((res) => { if (!ignore) setTechnicians(res.data || []); }).catch(() => {});

    Promise.resolve().then(() => {
      if (!ignore) fetchTicket();
    });

    return () => { ignore = true; };
  }, [fetchTicket]);

  // Handle URL query actions (e.g. ?action=advance_decision&target=Cancelled)
  useEffect(() => {
    const action = searchParams?.get('action');
    const target = searchParams?.get('target');
    if (action === 'advance_decision' && target) {
      Promise.resolve().then(() => {
        setTargetAdvanceStage(target);
        setShowAdvanceModal(true);
      });
    }
  }, [searchParams]);

  // Debounced part search from inventory catalogue
  useEffect(() => {
    if (!partSearchQuery.trim() || isFreeTextPart || selectedProduct) {
      return;
    }
    const timer = setTimeout(async () => {
      setSearchingParts(true);
      try {
        const res = await searchRepairParts(id, partSearchQuery.trim());
        setPartSearchResults(res.data || []);
      } catch {
        setPartSearchResults([]);
      } finally {
        setSearchingParts(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [partSearchQuery, id, isFreeTextPart, selectedProduct]);


  const handleSelectProduct = (prod) => {
    setSelectedProduct(prod);
    setPartName(prod.name);
    setPartSku(prod.sku || '');
    setPartPriceRs(((prod.sellingPriceCents || 0) / 100).toFixed(2));
    if (prod.averageCostCents !== undefined) {
      setPartCostRs(((prod.averageCostCents || 0) / 100).toFixed(2));
    }
    setPartSearchResults([]);
  };

  const handleClearSelectedProduct = () => {
    setSelectedProduct(null);
    setPartSearchQuery('');
    setPartName('');
    setPartSku('');
    setPartPriceRs('');
    setPartCostRs('');
    setPartSearchResults([]);
  };

  const isOwner = profile?.role?.key === 'owner';
  const canApprove = isOwner || profile?.role?.grid?.repairs?.approve === true;
  const canEdit = isOwner || profile?.role?.grid?.repairs?.edit === true;
  const canViewCostMargin = isOwner || profile?.role?.special?.view_cost_margin === true;

  const handleRevealPasscode = async () => {
    setRevealingPasscode(true);
    setError('');
    try {
      const res = await getRepairTicket(id, { revealPasscode: true });
      setRevealedPasscode(res.data.passcode || 'No passcode set');
      setSuccessMsg('Passcode revealed (audited in security log).');
    } catch (err) {
      setError(err.message || 'Failed to reveal passcode.');
    } finally {
      setRevealingPasscode(false);
    }
  };

  const handleAssignTechnician = async (e) => {
    e.preventDefault();
    if (!selectedTechId) return;
    setAssigningTech(true);
    setError('');
    setSuccessMsg('');
    try {
      await assignRepairTechnician(id, selectedTechId);
      setSuccessMsg('Technician assigned successfully.');
      fetchTicket();
    } catch (err) {
      setError(err.message || 'Failed to assign technician.');
    } finally {
      setAssigningTech(false);
    }
  };

  const handleStageChange = async (targetStage) => {
    setError('');
    setSuccessMsg('');

    // Advance decision check
    if (
      ['Cancelled', 'Unrepairable'].includes(targetStage) &&
      ticket.advanceCents > 0 &&
      !ticket.advanceSettled
    ) {
      setTargetAdvanceStage(targetStage);
      setAdvanceFeeRs('0');
      setCancellationNote(stageNote || '');
      setShowAdvanceModal(true);
      return;
    }

    // Cancellation from active stages requires note
    if (
      targetStage === 'Cancelled' &&
      ['In repair', 'Quality check', 'Ready'].includes(ticket.stage) &&
      !stageNote.trim()
    ) {
      setError('A cancellation note is required when cancelling an in-progress repair.');
      return;
    }

    setTransitioningStage(true);
    try {
      await changeRepairStage(id, {
        to: targetStage,
        note: stageNote.trim() || undefined,
        waiveApproval: waiveApprovalChoice || targetStage === 'In repair',
      });
      setSuccessMsg(`Stage transitioned to "${targetStage}" successfully.`);
      setStageNote('');
      setWaiveApprovalChoice(false);
      fetchTicket();
    } catch (err) {
      setError(err.message || 'Failed to transition stage.');
    } finally {
      setTransitioningStage(false);
    }
  };

  const handleAdvanceDecisionSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccessMsg('');

    if (advanceDecision === 'keep_fee') {
      const feeErr = validateRupeeAmount(advanceFeeRs, 'Keep fee amount', { required: true });
      if (feeErr) {
        setError(feeErr);
        return;
      }
      const maxFeeCents = ticket.advanceCents || 0;
      const parsedFeeCents = parseRupeeToCents(advanceFeeRs);
      if (parsedFeeCents > maxFeeCents) {
        setError(`Fee cannot exceed advance deposit of Rs ${(maxFeeCents / 100).toFixed(2)}.`);
        return;
      }
    }

    setProcessingAdvanceDecision(true);

    try {
      const feeCents = advanceDecision === 'keep_fee' ? parseRupeeToCents(advanceFeeRs) : 0;
      await changeRepairStage(id, {
        to: targetAdvanceStage,
        note: cancellationNote.trim() || 'Ticket cancelled with advance settlement',
        advanceDecision,
        feeCents,
        paymentMethod: advanceRefundMethod,
      });

      setShowAdvanceModal(false);
      setSuccessMsg(`Ticket moved to ${targetAdvanceStage} and advance ${advanceDecision} journal posted.`);
      fetchTicket();
    } catch (err) {
      setError(err.message || 'Failed to settle advance.');
    } finally {
      setProcessingAdvanceDecision(false);
    }
  };

  const handleRecordApproval = async (e) => {
    e.preventDefault();
    setRecordingApproval(true);
    setError('');
    setSuccessMsg('');
    try {
      await recordRepairApproval(id, {
        decision: approvalDecision,
        by: approvalChannel,
      });
      setSuccessMsg(`Customer estimate approval recorded as "${approvalDecision}".`);
      fetchTicket();
    } catch (err) {
      setError(err.message || 'Failed to record approval.');
    } finally {
      setRecordingApproval(false);
    }
  };

  const handleAddPart = async (e) => {
    e.preventDefault();
    if (!partName.trim()) {
      setError('Part name is required.');
      return;
    }
    const qty = parseInt(partQty, 10);
    if (!Number.isInteger(qty) || qty < 1 || qty > 1000) {
      setError('Part quantity must be an integer between 1 and 1000.');
      return;
    }
    const priceErr = validateRupeeAmount(partPriceRs, 'Part selling price');
    if (priceErr) {
      setError(priceErr);
      return;
    }
    const costErr = canViewCostMargin && !selectedProduct && partCostRs
      ? validateRupeeAmount(partCostRs, 'Part cost price')
      : null;
    if (costErr) {
      setError(costErr);
      return;
    }
    const unitPriceCents = parseRupeeToCents(partPriceRs);
    const unitCostCents = canViewCostMargin && partCostRs ? parseRupeeToCents(partCostRs) : 0;

    setAddingPart(true);
    setError('');
    setSuccessMsg('');
    try {
      const payload = selectedProduct
        ? {
            productId: selectedProduct._id,
            qty,
            unitPriceCents,
          }
        : {
            name: partName.trim(),
            sku: partSku.trim() || null,
            qty,
            unitPriceCents,
            unitCostCents,
          };

      await addRepairPart(id, payload);
      setSuccessMsg(`Part "${partName.trim()}" added to ticket.`);
      handleClearSelectedProduct();
      setPartQty(1);
      fetchTicket();
    } catch (err) {
      const msg = err.message || '';
      if (msg.toLowerCase().includes('insufficient') || err.code === 'INSUFFICIENT_STOCK') {
        setError(`Insufficient stock for "${partName}": available stock in this branch is less than ${qty}.`);
      } else if (msg.toLowerCase().includes('part_locked') || msg.toLowerCase().includes('back in stock') || msg.toLowerCase().includes('locked')) {
        setError('Parts are locked because this shop-owned unit is back in stock.');
      } else if (msg.toLowerCase().includes('invoice') || err.code === 'INVOICE_SETTLED') {
        setError('Cannot add parts after the invoice has been settled.');
      } else {
        setError(msg || 'Failed to add part.');
      }
    } finally {
      setAddingPart(false);
    }
  };

  const handleRemovePart = async (partId, name) => {
    if (!window.confirm(`Remove part "${name}" from this repair ticket?`)) return;
    setRemovingPartId(partId);
    setError('');
    setSuccessMsg('');
    try {
      await removeRepairPart(id, partId);
      setSuccessMsg(`Part removed successfully.`);
      fetchTicket();
    } catch (err) {
      const msg = err.message || '';
      if (msg.toLowerCase().includes('part_locked') || msg.toLowerCase().includes('back in stock')) {
        setError('Cannot remove parts once shop-owned unit is back in stock.');
      } else if (msg.toLowerCase().includes('recognised') || err.code === 'COGS_ALREADY_POSTED') {
        setError('Cannot remove parts after cost has been recognised on invoice or write-off.');
      } else {
        setError(msg || 'Failed to remove part.');
      }
    } finally {
      setRemovingPartId(null);
    }
  };

  const handleSettleInvoice = async (e) => {
    e.preventDefault();
    if (ticket.stage !== 'Ready') {
      setError('Invoice can only be settled when ticket is in "Ready" stage.');
      return;
    }
    const labourErr = validateRupeeAmount(labourRs, 'Labour charge');
    if (labourErr) {
      setError(labourErr);
      return;
    }
    const labourCents = parseRupeeToCents(labourRs);
    const partsTotal = (ticket.parts || []).reduce((acc, p) => acc + (p.qty || 1) * (p.unitPriceCents || 0), 0);
    if (labourCents + partsTotal <= 0) {
      setError('Total repair invoice amount must be greater than Rs 0.00.');
      return;
    }

    setSettlingInvoice(true);
    setError('');
    setSuccessMsg('');
    try {
      await settleRepairInvoice(id, {
        paymentMethod: invoicePaymentMethod,
        labourCents,
      });
      setSuccessMsg('Repair invoice settled and double-entry ledger journal posted.');
      fetchTicket();
    } catch (err) {
      setError(err.message || 'Failed to settle invoice.');
    } finally {
      setSettlingInvoice(false);
    }
  };

  const handleSaveWarranty = async (e) => {
    e.preventDefault();
    const days = parseInt(warrantyDaysInput, 10);
    if (isNaN(days) || days < 0) {
      setError('Warranty days must be a non-negative integer.');
      return;
    }
    setSavingWarranty(true);
    setError('');
    setSuccessMsg('');
    try {
      await setRepairWarranty(id, days);
      setSuccessMsg(`Warranty set to ${days} days.`);
      fetchTicket();
    } catch (err) {
      setError(err.message || 'Failed to update warranty.');
    } finally {
      setSavingWarranty(false);
    }
  };

  if (!hasSession()) {
    return (
      <Shell>
        <Alert tone="warning">
          Please <Link href="/">log in</Link> to view ticket details.
        </Alert>
      </Shell>
    );
  }

  if (loading || !ticket) {
    return (
      <Shell user={profile?.name}>
        <div style={{ textAlign: 'center', padding: '60px 0' }}>
          <Spinner />
          <p style={{ marginTop: 12, color: 'var(--secondary)' }}>Loading repair ticket...</p>
        </div>
      </Shell>
    );
  }

  const partsTotalCents = (ticket.parts || []).reduce(
    (sum, p) => sum + (p.qty || 1) * (p.unitPriceCents || 0),
    0
  );
  const currentLabourCents = labourRs && String(labourRs).trim() !== '' ? parseRupeeToCents(labourRs) : (ticket.labourCents || 0);
  const grandTotalCents = partsTotalCents + currentLabourCents;
  const advanceCents = ticket.advanceSettled ? 0 : ticket.advanceCents || 0;
  const balanceDueCents = grandTotalCents - advanceCents;

  const allowedTransitions = STAGE_TRANSITIONS[ticket.stage] || [];
  const isTerminal = ['Delivered', 'Unrepairable', 'Cancelled'].includes(ticket.stage);

  return (
    <Shell user={profile?.name}>
      {/* Printable Job Card Stylesheet */}
      <style jsx global>{`
        @media print {
          body * {
            visibility: hidden;
          }
          #printable-job-card,
          #printable-job-card * {
            visibility: visible;
          }
          #printable-job-card {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
            display: block !important;
            padding: 24px;
            color: #000;
            background: #fff;
          }
          .no-print {
            display: none !important;
          }
        }
      `}</style>

      {/* Hidden container for print stylesheet */}
      <div id="printable-job-card" style={{ display: 'none' }}>
        <div style={{ borderBottom: '2px solid #000', paddingBottom: 12, marginBottom: 16 }}>
          <h1 style={{ fontSize: 26, margin: 0 }}>CELLIVO REPAIR SERVICE</h1>
          <p style={{ margin: '4px 0', fontSize: 13 }}>Official Customer Repair Intake Job Card</p>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
            <div>
              <strong>Ticket No: {ticket.ticketNo}</strong>
              <div>Date: {date(ticket.createdAt)}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div>Status: {ticket.stage}</div>
              <div>Promised: {ticket.promisedDate ? date(ticket.promisedDate) : 'TBD'}</div>
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
          <div style={{ border: '1px solid #ccc', padding: 12, borderRadius: 6 }}>
            <h3 style={{ margin: '0 0 8px 0', fontSize: 14 }}>Customer Information</h3>
            <div><strong>Name:</strong> {ticket.customerId?.name || 'Walk-in'}</div>
            <div><strong>Phone:</strong> {ticket.customerId?.phone || '-'}</div>
            <div><strong>NIC:</strong> {ticket.customerId?.nic || '-'}</div>
          </div>

          <div style={{ border: '1px solid #ccc', padding: 12, borderRadius: 6 }}>
            <h3 style={{ margin: '0 0 8px 0', fontSize: 14 }}>Device Details</h3>
            <div><strong>Device:</strong> {ticket.device?.brand} {ticket.device?.model}</div>
            <div><strong>IMEI:</strong> {ticket.device?.imei || 'Not recorded'}</div>
            <div><strong>Serial:</strong> {ticket.device?.serial || '-'}</div>
            <div><strong>Accessories:</strong> {(ticket.accessories || []).join(', ') || 'None'}</div>
          </div>
        </div>

        <div style={{ border: '1px solid #ccc', padding: 12, borderRadius: 6, marginBottom: 20 }}>
          <h3 style={{ margin: '0 0 8px 0', fontSize: 14 }}>Reported Fault & Physical Condition</h3>
          <div><strong>Reported Fault:</strong> {ticket.faultDescription}</div>
          <div><strong>Condition Notes:</strong> {ticket.conditionNotes || 'No damages noted at intake'}</div>
        </div>

        <div style={{ border: '1px solid #ccc', padding: 12, borderRadius: 6, marginBottom: 24 }}>
          <h3 style={{ margin: '0 0 8px 0', fontSize: 14 }}>Financial Terms</h3>
          <div><strong>Estimate:</strong> {money(ticket.estimateCents || 0)}</div>
          <div><strong>Advance Deposited:</strong> {money(ticket.advanceCents || 0)} ({ticket.advancePaymentMethod || 'cash'})</div>
        </div>

        <div style={{ border: '1px solid #ccc', padding: 12, borderRadius: 6, marginBottom: 24, background: '#fafafa' }}>
          <h3 style={{ margin: '0 0 6px 0', fontSize: 13, textTransform: 'uppercase' }}>Online Repair Tracking</h3>
          <div style={{ fontSize: 12, color: '#333', marginBottom: 4 }}>
            Visit to view live status updates for your repair:
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#1d4ed8', wordBreak: 'break-all' }}>
            {typeof window !== 'undefined' ? `${window.location.origin}/status?token=${ticket.trackingToken || ''}` : `/status?token=${ticket.trackingToken || ''}`}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 40, marginTop: 40, paddingTop: 20, borderTop: '1px dashed #999' }}>
          <div>
            <div style={{ borderBottom: '1px solid #000', height: 40, marginBottom: 6 }} />
            <div style={{ fontSize: 12, textAlign: 'center' }}>Technician Signature & Stamp</div>
          </div>
          <div>
            <div style={{ borderBottom: '1px solid #000', height: 40, marginBottom: 6 }} />
            <div style={{ fontSize: 12, textAlign: 'center' }}>Customer Signature (Agreed to terms)</div>
          </div>
        </div>
      </div>

      {/* Screen View */}
      <div className="no-print" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <Link href="/repairs" style={{ color: 'var(--brand)', textDecoration: 'none', fontWeight: 600, minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>
          ← Back to Repairs Board
        </Link>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {ticket.trackingToken && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                const url = `${window.location.origin}/status?token=${ticket.trackingToken}`;
                navigator.clipboard.writeText(url);
                alert('Customer tracking link copied to clipboard!');
              }}
              style={{ minHeight: 44, padding: '0 16px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              Copy Tracking Link
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            onClick={() => window.print()}
            style={{ minHeight: 44, padding: '0 20px', display: 'inline-flex', alignItems: 'center', gap: 8 }}
          >
            Print Job Card
          </Button>
        </div>
      </div>

      {/* Header Info */}
      <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <h1 style={{ fontSize: 26, fontWeight: 800, color: 'var(--heading)' }}>
              Ticket {ticket.ticketNo}
            </h1>
            <Badge tone={isTerminal ? 'neutral' : ticket.stage === 'Ready' ? 'success' : 'warning'}>
              Stage: {ticket.stage}
            </Badge>
            {ticket.isInvoiceSettled && <Badge tone="success">Invoice Settled</Badge>}
            {ticket.shopOwnedUnit && <Badge>Shop-owned unit</Badge>}
            {ticket.shopOwnedUnit && (
              <Badge tone={['Ready', 'Delivered'].includes(ticket.stage) ? 'success' : 'warning'}>
                Stock: {['Ready', 'Delivered'].includes(ticket.stage) ? 'In Stock' : 'In Repair'}
              </Badge>
            )}
          </div>
          <p style={{ color: 'var(--secondary)', fontSize: 13, marginTop: 4 }}>
            Created {date(ticket.createdAt)} · Branch: {ticket.branchId?.name || 'Main Branch'}
          </p>
        </div>
      </div>

      {error && (
        <Alert tone="danger">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{error}</span>
            <button
              onClick={() => setError('')}
              style={{ background: 'transparent', border: 0, color: 'inherit', fontWeight: 700, cursor: 'pointer', minHeight: 44, minWidth: 44 }}
            >
              Dismiss
            </button>
          </div>
        </Alert>
      )}

      {successMsg && (
        <Alert tone="success">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{successMsg}</span>
            <button
              onClick={() => setSuccessMsg('')}
              style={{ background: 'transparent', border: 0, color: 'inherit', fontWeight: 700, cursor: 'pointer', minHeight: 44, minWidth: 44 }}
            >
              Dismiss
            </button>
          </div>
        </Alert>
      )}

      {/* Grid of Sections */}
      <div className="no-print" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 18 }}>
        {/* Section 1: Customer & Device */}
        <Card title="Customer & Device Overview">
          <div style={{ display: 'grid', gap: 10, fontSize: 14 }}>
            <div>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--label)', textTransform: 'uppercase' }}>Customer</span>
              <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--heading)' }}>
                {ticket.customerId?.name || 'Walk-in'}
              </div>
              <div style={{ color: 'var(--secondary)' }}>Phone: {ticket.customerId?.phone || '-'}</div>
              {ticket.customerId?.phone && (
                <a
                  href={`https://wa.me/${ticket.customerId.phone.replace(/\D/g, '')}?text=${encodeURIComponent(`Hello ${ticket.customerId.name}, regarding your repair ${ticket.ticketNo}:`)}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    marginTop: 6,
                    color: 'var(--success)',
                    fontWeight: 700,
                    textDecoration: 'none',
                    minHeight: 44,
                  }}
                >
                  WhatsApp Message
                </a>
              )}
            </div>

            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--label)', textTransform: 'uppercase' }}>Device</span>
              <div style={{ fontWeight: 700 }}>
                {ticket.device?.brand} {ticket.device?.model}
              </div>
              {ticket.device?.imei && <div>IMEI: <code>{ticket.device.imei}</code></div>}
              {ticket.device?.serial && <div>Serial: <code>{ticket.device.serial}</code></div>}
              {ticket.device?.colour && <div>Colour: {ticket.device.colour}</div>}
            </div>

            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--label)', textTransform: 'uppercase' }}>Reported Fault</span>
              <p style={{ margin: '4px 0', background: 'var(--bg)', padding: 8, borderRadius: 8 }}>
                {ticket.faultDescription}
              </p>
            </div>

            {ticket.accessories && ticket.accessories.length > 0 && (
              <div>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--label)', textTransform: 'uppercase' }}>Accessories</span>
                <div>{ticket.accessories.join(', ')}</div>
              </div>
            )}

            {ticket.conditionNotes && (
              <div>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--label)', textTransform: 'uppercase' }}>Physical Condition</span>
                <div>{ticket.conditionNotes}</div>
              </div>
            )}

            {/* Passcode with audited reveal */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--label)', textTransform: 'uppercase' }}>Device Passcode / PIN</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
                <strong style={{ fontSize: 16, fontFamily: 'monospace' }}>
                  {revealedPasscode !== null ? revealedPasscode : '••••••••'}
                </strong>
                {revealedPasscode === null && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleRevealPasscode}
                    disabled={revealingPasscode}
                    style={{ minHeight: 44, padding: '0 14px', fontSize: 12 }}
                  >
                    {revealingPasscode ? 'Auditing...' : 'Reveal Passcode'}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </Card>

        {/* Section 2: Technician & Stage Workflow */}
        <Card title="Workflow & Stage Transitions">
          {/* Technician Assignment */}
          <form onSubmit={handleAssignTechnician} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 14 }}>
            <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, fontWeight: 700, color: 'var(--label)', textTransform: 'uppercase' }}>
              Assigned Technician
              <select
                value={selectedTechId}
                onChange={(e) => setSelectedTechId(e.target.value)}
                disabled={!canEdit}
                style={{
                  border: '1px solid var(--input-border)',
                  borderRadius: 8,
                  padding: '8px 12px',
                  minHeight: 44,
                  fontSize: 14,
                  background: 'var(--surface)',
                }}
              >
                <option value="">-- Unassigned --</option>
                {technicians.map((t) => (
                  <option key={t._id} value={t._id}>
                    {t.name} ({t.activeTicketsCount ?? 0} active jobs)
                  </option>
                ))}
              </select>
            </label>
            {canEdit && (
              <Button type="submit" variant="secondary" disabled={assigningTech} style={{ minHeight: 44 }}>
                {assigningTech ? 'Assigning...' : 'Assign'}
              </Button>
            )}
          </form>

          {/* Stage Note */}
          <Field
            label="Transition Note (Optional, Required on cancellation)"
            value={stageNote}
            onChange={(e) => setStageNote(e.target.value)}
            placeholder="Add note for history timeline..."
            style={{ minHeight: 44, marginBottom: 12 }}
          />

          {/* State Moves Buttons */}
          <div>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--label)', textTransform: 'uppercase', display: 'block', marginBottom: 8 }}>
              Allowed Stage Transitions
            </span>

            {isTerminal ? (
              <div>
                <p style={{ fontSize: 13, color: 'var(--secondary)', marginBottom: 8 }}>
                  Ticket is in terminal stage <strong>{ticket.stage}</strong>.
                </p>
                {isOwner ? (
                  <Button
                    type="button"
                    onClick={() => handleStageChange('Diagnosing')}
                    disabled={transitioningStage}
                    style={{ minHeight: 44 }}
                  >
                    Reopen Ticket to Diagnosing (Owner)
                  </Button>
                ) : (
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                    Only the shop owner can reopen a terminal repair ticket.
                  </span>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {allowedTransitions.map((target) => {
                  const isCancel = target === 'Cancelled';
                  return (
                    <Button
                      key={target}
                      type="button"
                      variant={isCancel ? 'danger' : 'secondary'}
                      onClick={() => handleStageChange(target)}
                      disabled={transitioningStage}
                      style={{ minHeight: 44 }}
                    >
                      Move to {target}
                    </Button>
                  );
                })}
              </div>
            )}
          </div>
        </Card>

        {/* Section 3: Customer Approval */}
        <Card title="Estimate & Customer Approval">
          <div style={{ display: 'grid', gap: 10 }}>
            <div>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--label)', textTransform: 'uppercase' }}>Current Estimate</span>
              <div style={{ fontSize: 18, fontWeight: 800 }}>{money(ticket.estimateCents || 0)}</div>
            </div>

            <div>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--label)', textTransform: 'uppercase' }}>Approval Status</span>
              <div>
                <Badge
                  tone={
                    ticket.approval?.status === 'approved' || ticket.approval?.status === 'waived'
                      ? 'success'
                      : ticket.approval?.status === 'declined'
                      ? 'danger'
                      : 'warning'
                  }
                >
                  {ticket.approval?.status ? ticket.approval.status.toUpperCase() : 'PENDING'}
                </Badge>
                {ticket.approval?.at && <small style={{ marginLeft: 8, color: 'var(--muted)' }}>at {date(ticket.approval.at)}</small>}
              </div>
            </div>

            {!ticket.isInvoiceSettled && !isTerminal && ticket.approval?.status !== 'waived' && canEdit && (
              <form onSubmit={handleRecordApproval} style={{ borderTop: '1px solid var(--border)', paddingTop: 10, display: 'grid', gap: 10 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--label)', textTransform: 'uppercase' }}>
                    Decision
                    <select
                      value={approvalDecision}
                      onChange={(e) => setApprovalDecision(e.target.value)}
                      style={{ border: '1px solid var(--input-border)', borderRadius: 8, padding: '8px', minHeight: 44, width: '100%', marginTop: 4 }}
                    >
                      <option value="approved">Approved</option>
                      <option value="declined">Declined</option>
                    </select>
                  </label>

                  <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--label)', textTransform: 'uppercase' }}>
                    Channel
                    <select
                      value={approvalChannel}
                      onChange={(e) => setApprovalChannel(e.target.value)}
                      style={{ border: '1px solid var(--input-border)', borderRadius: 8, padding: '8px', minHeight: 44, width: '100%', marginTop: 4 }}
                    >
                      <option value="in_person">In Person</option>
                      <option value="phone">Phone Call</option>
                      <option value="whatsapp">WhatsApp</option>
                      <option value="sms">SMS</option>
                    </select>
                  </label>
                </div>

                <Button type="submit" disabled={recordingApproval} style={{ minHeight: 44 }}>
                  {recordingApproval ? 'Recording...' : 'Record Customer Approval'}
                </Button>
              </form>
            )}
          </div>
        </Card>

        {/* Section 4: Parts Used */}
        <Card title="Parts & Components">
          <div style={{ display: 'grid', gap: 12 }}>
            <Table head={['Part Name', 'Type', 'Qty', 'Unit Price', 'Total', ...(canViewCostMargin ? ['Cost'] : []), 'Action']}>
              {(ticket.parts || []).length === 0 ? (
                <tr>
                  <td colSpan={canViewCostMargin ? 7 : 6} style={{ textAlign: 'center', color: 'var(--muted)', padding: 14 }}>
                    No parts added yet.
                  </td>
                </tr>
              ) : (
                ticket.parts.map((p) => (
                  <tr key={p._id}>
                    <td>
                      <strong>{p.name}</strong>
                      {p.sku && <div style={{ fontSize: 11, color: 'var(--muted)' }}>SKU: {p.sku}</div>}
                    </td>
                    <td>
                      <Badge tone={p.inventoryManaged ? 'success' : 'neutral'}>
                        {p.inventoryManaged ? 'Inventory' : 'Custom'}
                      </Badge>
                    </td>
                    <td>{p.qty}</td>
                    <td>{money(p.unitPriceCents || 0)}</td>
                    <td>{money((p.qty || 1) * (p.unitPriceCents || 0))}</td>
                    {canViewCostMargin && <td>{money(p.unitCostCents || 0)}</td>}
                    <td>
                      {!ticket.isInvoiceSettled && !isTerminal && canEdit && !(ticket.shopOwnedUnit && ['Ready', 'Delivered'].includes(ticket.stage)) && (
                        <button
                          type="button"
                          onClick={() => handleRemovePart(p._id, p.name)}
                          disabled={removingPartId === p._id}
                          style={{
                            background: 'transparent',
                            border: 0,
                            color: 'var(--danger)',
                            fontWeight: 700,
                            cursor: 'pointer',
                            minHeight: 44,
                            minWidth: 44,
                          }}
                          aria-label={`Remove part ${p.name}`}
                        >
                          {removingPartId === p._id ? 'Removing...' : 'Delete'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </Table>

            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 14 }}>
              <span>Parts Total:</span>
              <span>{money(partsTotalCents)}</span>
            </div>

            {/* Shop-owned back in stock locked state */}
            {ticket.shopOwnedUnit && ['Ready', 'Delivered'].includes(ticket.stage) ? (
              <div style={{ background: 'var(--card-bg, #f8f9fa)', border: '1px solid var(--border)', padding: 14, borderRadius: 8, fontSize: 13, color: 'var(--muted)' }}>
                🔒 <strong>Parts Locked:</strong> This shop-owned unit is back in stock ({ticket.stage}). Parts cannot be added or removed.
              </div>
            ) : !ticket.isInvoiceSettled && !isTerminal && canEdit && (
              <form onSubmit={handleAddPart} style={{ borderTop: '1px solid var(--border)', paddingTop: 14, display: 'grid', gap: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--label)', textTransform: 'uppercase' }}>
                    + Add Part To Ticket (Max 50)
                  </span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Button
                      type="button"
                      variant={!isFreeTextPart ? 'primary' : 'secondary'}
                      onClick={() => { setIsFreeTextPart(false); handleClearSelectedProduct(); }}
                      style={{ fontSize: 12, minHeight: 36, padding: '0 12px' }}
                    >
                      Catalogue Part
                    </Button>
                    <Button
                      type="button"
                      variant={isFreeTextPart ? 'primary' : 'secondary'}
                      onClick={() => { setIsFreeTextPart(true); handleClearSelectedProduct(); }}
                      style={{ fontSize: 12, minHeight: 36, padding: '0 12px' }}
                    >
                      Custom Free-Text
                    </Button>
                  </div>
                </div>

                {!isFreeTextPart ? (
                  <div style={{ display: 'grid', gap: 10 }}>
                    {!selectedProduct ? (
                      <div style={{ display: 'grid', gap: 6, position: 'relative' }}>
                        <Field
                          label="Search Inventory Product *"
                          value={partSearchQuery}
                          onChange={(e) => {
                            const val = e.target.value;
                            setPartSearchQuery(val);
                            if (!val.trim()) {
                              setPartSearchResults([]);
                              setSearchingParts(false);
                            }
                          }}
                          placeholder="Type product name, brand, model or SKU..."
                          style={{ minHeight: 44 }}
                        />
                        {searchingParts && (
                          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: -4 }}>Searching catalogue...</div>
                        )}
                        {partSearchResults.length > 0 && (
                          <div
                            style={{
                              border: '1px solid var(--border)',
                              borderRadius: 8,
                              background: 'var(--card-bg, #fff)',
                              boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                              maxHeight: 220,
                              overflowY: 'auto',
                              display: 'grid',
                              gap: 1,
                            }}
                          >
                            {partSearchResults.map((prod) => (
                              <button
                                key={prod._id}
                                type="button"
                                onClick={() => handleSelectProduct(prod)}
                                style={{
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  alignItems: 'center',
                                  padding: '10px 14px',
                                  background: 'transparent',
                                  border: 0,
                                  borderBottom: '1px solid var(--border)',
                                  textAlign: 'left',
                                  cursor: 'pointer',
                                  minHeight: 44,
                                  width: '100%',
                                }}
                              >
                                <div>
                                  <strong>{prod.name}</strong>
                                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                                    {prod.sku ? `SKU: ${prod.sku} · ` : ''}Available stock: {prod.stockQty ?? 0}
                                  </div>
                                </div>
                                <div style={{ textAlign: 'right' }}>
                                  <div style={{ fontWeight: 700, color: 'var(--brand)' }}>
                                    {money(prod.sellingPriceCents || 0)}
                                  </div>
                                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>Click to pick</span>
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                        {partSearchQuery.trim().length > 1 && !searchingParts && partSearchResults.length === 0 && (
                          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                            No inventory parts found matching &quot;{partSearchQuery}&quot;. You can switch to Custom Free-Text above.
                          </div>
                        )}
                      </div>
                    ) : (
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '10px 14px',
                          background: 'var(--success-bg, #e8f5e9)',
                          border: '1px solid var(--success, #2e7d32)',
                          borderRadius: 8,
                        }}
                      >
                        <div>
                          <strong>{selectedProduct.name}</strong>
                          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                            {selectedProduct.sku ? `SKU: ${selectedProduct.sku} · ` : ''}
                            Available: {selectedProduct.stockQty ?? 0} in stock
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={handleClearSelectedProduct}
                          style={{ minHeight: 36, padding: '0 12px', fontSize: 12 }}
                        >
                          Change Part
                        </Button>
                      </div>
                    )}

                    {selectedProduct && (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
                        <Field
                          label="Quantity *"
                          type="number"
                          min="1"
                          max="1000"
                          value={partQty}
                          onChange={(e) => setPartQty(e.target.value)}
                          required
                          style={{ minHeight: 44 }}
                        />
                        <Field
                          label="Selling Price (Rs) *"
                          type="number"
                          step="any"
                          min="0"
                          value={partPriceRs}
                          onChange={(e) => setPartPriceRs(e.target.value)}
                          required
                          style={{ minHeight: 44 }}
                        />
                        {canViewCostMargin && partCostRs && (
                          <Field
                            label="Unit Cost (Rs, WAC)"
                            type="text"
                            value={partCostRs}
                            disabled
                            style={{ minHeight: 44, opacity: 0.8 }}
                          />
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
                    <Field
                      label="Part Name *"
                      value={partName}
                      onChange={(e) => setPartName(e.target.value)}
                      placeholder="e.g. OLED Display"
                      required
                      style={{ minHeight: 44 }}
                    />
                    <Field
                      label="SKU"
                      value={partSku}
                      onChange={(e) => setPartSku(e.target.value)}
                      placeholder="Optional"
                      style={{ minHeight: 44 }}
                    />
                    <Field
                      label="Qty (1..1000) *"
                      type="number"
                      min="1"
                      max="1000"
                      value={partQty}
                      onChange={(e) => setPartQty(e.target.value)}
                      required
                      style={{ minHeight: 44 }}
                    />
                    <Field
                      label="Unit Price (Rs) *"
                      type="number"
                      step="any"
                      min="0"
                      value={partPriceRs}
                      onChange={(e) => setPartPriceRs(e.target.value)}
                      placeholder="0.00"
                      required
                      style={{ minHeight: 44 }}
                    />
                    {canViewCostMargin && (
                      <Field
                        label="Unit Cost (Rs)"
                        type="number"
                        step="any"
                        min="0"
                        value={partCostRs}
                        onChange={(e) => setPartCostRs(e.target.value)}
                        placeholder="0.00"
                        style={{ minHeight: 44 }}
                      />
                    )}
                  </div>
                )}

                {(selectedProduct || isFreeTextPart) && (
                  <Button type="submit" disabled={addingPart} style={{ minHeight: 44, justifySelf: 'start' }}>
                    {addingPart ? 'Adding Part...' : 'Add Part'}
                  </Button>
                )}
              </form>
            )}
          </div>
        </Card>

        {/* Section 5: Invoice Settlement */}
        <Card title="Invoice & Billing Settlement">
          <div style={{ display: 'grid', gap: 10 }}>
            {ticket.isInvoiceSettled ? (
              <div style={{ background: 'var(--success-bg)', border: '1px solid var(--success)', padding: 14, borderRadius: 12 }}>
                <strong style={{ color: 'var(--success)', fontSize: 16 }}>✓ Invoice Settled</strong>
                <div style={{ marginTop: 4 }}>Total Invoiced: {money(ticket.invoiceTotalCents || 0)}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>Invoice ID: {ticket.invoiceId}</div>
              </div>
            ) : (
              <form onSubmit={handleSettleInvoice} style={{ display: 'grid', gap: 12 }}>
                <div style={{ display: 'grid', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Parts Subtotal:</span>
                    <strong>{money(partsTotalCents)}</strong>
                  </div>

                  <Field
                    label="Labour Fee (Rs)"
                    type="number"
                    step="any"
                    min="0"
                    value={labourRs}
                    onChange={(e) => setLabourRs(e.target.value)}
                    placeholder="0.00"
                    style={{ minHeight: 44 }}
                  />

                  <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: 6 }}>
                    <span>Total Job Amount:</span>
                    <strong>{money(grandTotalCents)}</strong>
                  </div>

                  {ticket.advanceCents > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--secondary)' }}>
                      <span>Advance Deposited ({ticket.advancePaymentMethod}):</span>
                      <span>-{money(ticket.advanceCents)}</span>
                    </div>
                  )}

                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 16, fontWeight: 800, borderTop: '2px solid var(--border)', paddingTop: 6 }}>
                    <span>{balanceDueCents >= 0 ? 'Balance Due:' : 'Refund Due to Customer:'}</span>
                    <span style={{ color: balanceDueCents >= 0 ? 'var(--brand)' : 'var(--success)' }}>
                      {money(Math.abs(balanceDueCents))}
                    </span>
                  </div>
                </div>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, fontWeight: 700, color: 'var(--label)', textTransform: 'uppercase' }}>
                  Payment Method for Final Settlement
                  <select
                    value={invoicePaymentMethod}
                    onChange={(e) => setInvoicePaymentMethod(e.target.value)}
                    style={{ border: '1px solid var(--input-border)', borderRadius: 8, padding: '10px 12px', minHeight: 44, fontSize: 14 }}
                  >
                    <option value="cash">Cash (1010)</option>
                    <option value="card">Card / POS (1020)</option>
                    <option value="bank">Bank Transfer (1030)</option>
                    <option value="cheque">Cheque (1040)</option>
                  </select>
                </label>

                {ticket.stage !== 'Ready' && (
                  <p style={{ fontSize: 12, color: 'var(--danger)', margin: 0 }}>
                    Notice: Invoice can only be settled when ticket is in <strong>Ready</strong> stage.
                  </p>
                )}

                <Button
                  type="submit"
                  disabled={settlingInvoice || ticket.stage !== 'Ready' || !canApprove}
                  style={{ minHeight: 48, fontSize: 15 }}
                >
                  {settlingInvoice
                    ? 'Settling Invoice...'
                    : !canApprove
                    ? 'Invoice Requires Approver Role'
                    : 'Settle Invoice (Post Journal)'}
                </Button>
              </form>
            )}
          </div>
        </Card>

        {/* Section 6: Warranty Period */}
        <Card title="Warranty Management">
          <form onSubmit={handleSaveWarranty} style={{ display: 'grid', gap: 10 }}>
            <Field
              label="Warranty Period (Days)"
              type="number"
              min="0"
              value={warrantyDaysInput}
              onChange={(e) => setWarrantyDaysInput(e.target.value)}
              placeholder="e.g. 30, 60, 90"
              disabled={!canEdit}
              hint="Calculates expiry date from delivery timestamp"
              style={{ minHeight: 44 }}
            />

            {ticket.warrantyExpiresAt ? (
              <div style={{ background: 'var(--tint)', padding: 10, borderRadius: 8 }}>
                <strong>Warranty Expires: {date(ticket.warrantyExpiresAt)}</strong>
              </div>
            ) : ticket.warrantyDays > 0 ? (
              <div style={{ fontSize: 12, color: 'var(--secondary)' }}>
                Warranty: {ticket.warrantyDays} days (will activate upon delivery)
              </div>
            ) : null}

            {canEdit && (
              <Button type="submit" variant="secondary" disabled={savingWarranty} style={{ minHeight: 44 }}>
                {savingWarranty ? 'Saving...' : 'Set Warranty Days'}
              </Button>
            )}
          </form>
        </Card>

        {/* Section 7: History Timeline */}
        <Card title="Audit History Timeline" style={{ gridColumn: '1 / -1' }}>
          <div style={{ display: 'grid', gap: 10 }}>
            {(ticket.history || []).length === 0 ? (
              <p style={{ color: 'var(--muted)' }}>No history recorded.</p>
            ) : (
              ticket.history.map((h, idx) => (
                <div
                  key={idx}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 12,
                    padding: '8px 0',
                    borderBottom: idx < ticket.history.length - 1 ? '1px solid var(--border)' : 'none',
                  }}
                >
                  <span
                    style={{
                      background: 'var(--tint)',
                      color: 'var(--brand)',
                      padding: '4px 8px',
                      borderRadius: 6,
                      fontSize: 11,
                      fontWeight: 700,
                      flex: 'none',
                    }}
                  >
                    {h.from} → {h.to}
                  </span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, color: 'var(--heading)' }}>{h.note || 'Stage transition'}</div>
                    <small style={{ color: 'var(--muted)' }}>{date(h.at)} · User ID: {h.userId}</small>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      {/* Advance Cancellation Modal Dialog */}
      {showAdvanceModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="advance-modal-title"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.5)',
            display: 'grid',
            placeItems: 'center',
            padding: 16,
            zIndex: 999,
          }}
        >
          <div
            style={{
              background: 'var(--surface)',
              borderRadius: 20,
              padding: 24,
              maxWidth: 480,
              width: '100%',
              display: 'grid',
              gap: 16,
              boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
            }}
          >
            <h2 id="advance-modal-title" style={{ fontSize: 18, fontWeight: 800, color: 'var(--heading)' }}>
              Advance Deposit Settlement ({targetAdvanceStage})
            </h2>
            <p style={{ fontSize: 13, color: 'var(--secondary)', margin: 0 }}>
              This ticket has an active advance deposit of <strong>{money(ticket.advanceCents)}</strong>.
              Choose how to handle the held deposit before moving to {targetAdvanceStage}.
            </p>

            <form onSubmit={handleAdvanceDecisionSubmit} style={{ display: 'grid', gap: 14 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 700, color: 'var(--label)', textTransform: 'uppercase' }}>
                Advance Decision
                <select
                  value={advanceDecision}
                  onChange={(e) => setAdvanceDecision(e.target.value)}
                  style={{ border: '1px solid var(--input-border)', borderRadius: 8, padding: '10px 12px', minHeight: 44, fontSize: 14 }}
                >
                  <option value="refund">Full Refund to Customer (Dr 2020 / Cr Payment)</option>
                  <option value="keep_fee">Retain Inspection/Cancellation Fee (Dr 2020 / Cr 4020)</option>
                </select>
              </label>

              {advanceDecision === 'keep_fee' && (
                <Field
                  label="Fee To Retain (Rs)"
                  type="number"
                  step="any"
                  min="0"
                  max={(ticket.advanceCents / 100).toString()}
                  value={advanceFeeRs}
                  onChange={(e) => setAdvanceFeeRs(e.target.value)}
                  hint={`Max fee: Rs ${(ticket.advanceCents / 100).toFixed(2)}. Remaining balance is refunded.`}
                  required
                  style={{ minHeight: 44 }}
                />
              )}

              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 700, color: 'var(--label)', textTransform: 'uppercase' }}>
                Payment Method for Refund
                <select
                  value={advanceRefundMethod}
                  onChange={(e) => setAdvanceRefundMethod(e.target.value)}
                  style={{ border: '1px solid var(--input-border)', borderRadius: 8, padding: '10px 12px', minHeight: 44, fontSize: 14 }}
                >
                  <option value="cash">Cash (1010)</option>
                  <option value="card">Card / POS (1020)</option>
                  <option value="bank">Bank Transfer (1030)</option>
                  <option value="cheque">Cheque (1040)</option>
                </select>
              </label>

              <Field
                label="Cancellation Note (Required) *"
                value={cancellationNote}
                onChange={(e) => setCancellationNote(e.target.value)}
                placeholder="Reason for cancellation..."
                required
                style={{ minHeight: 44 }}
              />

              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 10 }}>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setShowAdvanceModal(false)}
                  disabled={processingAdvanceDecision}
                  style={{ minHeight: 44 }}
                >
                  Cancel
                </Button>

                <Button
                  type="submit"
                  variant="danger"
                  disabled={processingAdvanceDecision}
                  style={{ minHeight: 44 }}
                >
                  {processingAdvanceDecision ? 'Processing...' : `Confirm & Move to ${targetAdvanceStage}`}
                </Button>
              </div>
            </form>
          </div>
        </div>
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
          Repairs
        </Link>
        <Link href="/pos" id="link-pos" style={{ fontWeight: 600, minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>
          Point of Sale
        </Link>
        {user && <User name={user} />}
      </AppHeader>
      <main
        style={{
          maxWidth: 1200,
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
