'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  AppHeader,
  Button,
  Badge,
  Alert,
  Card,
  Field,
  Table,
  Spinner,
  money,
  date,
} from '../../components/ui';
import { getReportData, exportReportCsv, getBranches } from '../../lib/api';

function getDefaultDates() {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().slice(0, 10);
  return { todayStr, thirtyDaysAgoStr };
}

export default function ReportsPage() {
  const [reportType, setReportType] = useState('sales');
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [warningMsg, setWarningMsg] = useState('');
  const [branches, setBranches] = useState([]);
  const [branchId, setBranchId] = useState('');

  // Stable default date states
  const [startDate, setStartDate] = useState(() => getDefaultDates().thirtyDaysAgoStr);
  const [endDate, setEndDate] = useState(() => getDefaultDates().todayStr);

  // Data state
  const [reportData, setReportData] = useState(null);

  useEffect(() => {
    getBranches()
      .then((res) => {
        if (res && res.data) setBranches(res.data);
      })
      .catch(() => {});
  }, []);

  const loadData = useCallback((type, bId, sDate, eDate) => {
    const params = {};
    if (bId) params.branchId = bId;
    if (type === 'sales' || type === 'repairs') {
      if (sDate) params.startDate = sDate;
      if (eDate) params.endDate = eDate;
    }

    getReportData(type, params)
      .then((data) => {
        setReportData(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message || 'Failed to load report data');
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    loadData(reportType, branchId, startDate, endDate);
  }, [reportType, branchId, startDate, endDate, loadData]);

  const handleApplyFilters = () => {
    setLoading(true);
    setError('');
    loadData(reportType, branchId, startDate, endDate);
  };

  const handleExportCsv = async () => {
    setExporting(true);
    setError('');
    setWarningMsg('');
    try {
      const params = {};
      if (branchId) params.branchId = branchId;
      if (reportType === 'sales' || reportType === 'repairs') {
        if (startDate) params.startDate = startDate;
        if (endDate) params.endDate = endDate;
      }

      const blob = await exportReportCsv(reportType, params);
      if (blob.isTruncated) {
        setWarningMsg(
          `Notice: Export reached maximum limit of 5,000 rows (total records: ${blob.totalCount ? blob.totalCount.toLocaleString() : '5,000+'}).`
        );
      }
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${reportType}_report_${endDate}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message || 'Failed to export CSV');
    } finally {
      setExporting(false);
    }
  };

  const summary = reportData?.summary;
  const items = reportData?.data || [];

  return (
    <div style={{ paddingBottom: '3rem' }}>
      <AppHeader chip="Reports & Analytics">
        <Link href="/">
          <Button variant="secondary">Dashboard</Button>
        </Link>
      </AppHeader>

      <main style={{ maxWidth: '1200px', margin: '1.5rem auto', padding: '0 1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 600 }}>Business Reports</h1>
            <p style={{ margin: '0.25rem 0 0 0', color: 'var(--text-muted, #666)' }}>
              Comprehensive performance, valuation, repair metrics, and receivables.
            </p>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <Button
              variant="secondary"
              onClick={handleExportCsv}
              disabled={exporting || loading || !items.length}
            >
              {exporting ? 'Exporting...' : 'Export CSV'}
            </Button>
          </div>
        </div>

        {error && (
          <Alert tone="danger" style={{ marginBottom: '1rem' }}>
            {error}
          </Alert>
        )}

        {warningMsg && (
          <Alert tone="warning" style={{ marginBottom: '1rem' }}>
            {warningMsg}
          </Alert>
        )}

        {/* Tab switcher */}
        <div style={{ display: 'flex', gap: '0.5rem', borderBottom: '1px solid #e2e8f0', marginBottom: '1.5rem' }}>
          {[
            { id: 'sales', label: 'Sales Report' },
            { id: 'inventory', label: 'Inventory Valuation' },
            { id: 'repairs', label: 'Repairs Performance' },
            { id: 'receivables', label: 'Receivables & Aging' },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setLoading(true);
                setReportType(t.id);
              }}
              style={{
                padding: '0.75rem 1.25rem',
                border: 'none',
                background: 'none',
                borderBottom: reportType === t.id ? '2px solid var(--primary, #0ea5e9)' : '2px solid transparent',
                fontWeight: reportType === t.id ? 600 : 400,
                color: reportType === t.id ? 'var(--primary, #0ea5e9)' : '#64748b',
                cursor: 'pointer',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Filter bar */}
        <Card style={{ marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            {(reportType === 'sales' || reportType === 'repairs') && (
              <>
                <Field
                  label="Start Date"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />

                <Field
                  label="End Date"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </>
            )}

            {branches.length > 0 && (
              <Field
                label="Branch"
                as="select"
                value={branchId}
                onChange={(e) => {
                  setLoading(true);
                  setBranchId(e.target.value);
                }}
              >
                <option value="">All Branches</option>
                {branches.map((b) => (
                  <option key={b._id} value={b._id}>
                    {b.name}
                  </option>
                ))}
              </Field>
            )}

            <Button onClick={handleApplyFilters} disabled={loading}>
              {loading ? 'Refreshing...' : 'Apply Filters'}
            </Button>
          </div>
        </Card>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '3rem' }}>
            <Spinner />
          </div>
        ) : (
          <>
            {/* KPI Summary Cards */}
            {summary && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                  gap: '1rem',
                  marginBottom: '1.5rem',
                }}
              >
                {reportType === 'sales' && (
                  <>
                    <Card title="Net Sales">
                      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#0f172a' }}>
                        {money(summary.netSalesCents || 0)}
                      </div>
                      <small style={{ color: '#64748b' }}>
                        Gross: {money(summary.grossSalesCents || 0)} (Returns: {money(summary.totalRefundsCents || 0)})
                      </small>
                    </Card>

                    <Card title="Invoices">
                      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#0f172a' }}>
                        {summary.totalInvoices || 0}
                      </div>
                      <small style={{ color: '#64748b' }}>Returns: {summary.returnsCount || 0}</small>
                    </Card>

                    {summary.totalCostCents != null && (
                      <Card title="Cost of Goods">
                        <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#dc2626' }}>
                          {money(summary.totalCostCents)}
                        </div>
                        <small style={{ color: '#64748b' }}>Parts & Product Costs</small>
                      </Card>
                    )}

                    {summary.grossProfitCents != null && (
                      <Card title="Gross Profit">
                        <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#16a34a' }}>
                          {money(summary.grossProfitCents)}
                        </div>
                        <small style={{ color: '#16a34a' }}>Margin: {summary.marginPercent || 0}%</small>
                      </Card>
                    )}
                  </>
                )}

                {reportType === 'inventory' && (
                  <>
                    <Card title="Total Products">
                      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#0f172a' }}>
                        {summary.totalProducts || 0}
                      </div>
                      <small style={{ color: '#64748b' }}>Units on Hand: {summary.totalUnits || 0}</small>
                    </Card>

                    <Card title="Retail Value">
                      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#0ea5e9' }}>
                        {money(summary.totalRetailValueCents || 0)}
                      </div>
                      <small style={{ color: '#64748b' }}>Expected Revenue</small>
                    </Card>

                    {summary.totalCostValueCents != null && (
                      <Card title="Total Cost Value">
                        <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#dc2626' }}>
                          {money(summary.totalCostValueCents)}
                        </div>
                        <small style={{ color: '#64748b' }}>Stock Asset Value</small>
                      </Card>
                    )}

                    {summary.potentialProfitCents != null && (
                      <Card title="Potential Profit">
                        <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#16a34a' }}>
                          {money(summary.potentialProfitCents)}
                        </div>
                        <small style={{ color: '#64748b' }}>Retail - Cost Value</small>
                      </Card>
                    )}
                  </>
                )}

                {reportType === 'repairs' && (
                  <>
                    <Card title="Total Tickets">
                      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#0f172a' }}>
                        {summary.totalTickets || 0}
                      </div>
                      <small style={{ color: '#64748b' }}>
                        Active: {summary.activeCount || 0} | Delivered: {summary.deliveredCount || 0}
                      </small>
                    </Card>

                    <Card title="Total Revenue">
                      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#0ea5e9' }}>
                        {money(summary.totalRevenueCents || 0)}
                      </div>
                      <small style={{ color: '#64748b' }}>
                        Labour: {money(summary.totalLabourCents || 0)} | Parts: {money(summary.totalPartsSellingCents || 0)}
                      </small>
                    </Card>

                    {summary.totalPartsCostCents != null && (
                      <Card title="Parts Cost">
                        <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#dc2626' }}>
                          {money(summary.totalPartsCostCents)}
                        </div>
                        <small style={{ color: '#64748b' }}>Cost of Replacement Parts</small>
                      </Card>
                    )}

                    {summary.netRepairsProfitCents != null && (
                      <Card title="Repairs Margin">
                        <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#16a34a' }}>
                          {money(summary.netRepairsProfitCents)}
                        </div>
                        <small style={{ color: '#64748b' }}>Revenue - Parts Cost</small>
                      </Card>
                    )}
                  </>
                )}

                {reportType === 'receivables' && (
                  <>
                    <Card title="Total Receivables">
                      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#dc2626' }}>
                        {money(summary.totalReceivablesCents || 0)}
                      </div>
                      <small style={{ color: '#64748b' }}>Unpaid Invoices: {summary.totalInvoices || 0}</small>
                    </Card>

                    <Card title="Current (0-30 Days)">
                      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#0f172a' }}>
                        {money(summary.aging?.current0to30Cents || 0)}
                      </div>
                      <small style={{ color: '#64748b' }}>Within Payment Terms</small>
                    </Card>

                    <Card title="Overdue (31-60 Days)">
                      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#f59e0b' }}>
                        {money(summary.aging?.overdue31to60Cents || 0)}
                      </div>
                      <small style={{ color: '#f59e0b' }}>Follow-up Recommended</small>
                    </Card>

                    <Card title="Overdue (60+ Days)">
                      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#ef4444' }}>
                        {money((summary.aging?.overdue61to90Cents || 0) + (summary.aging?.overdue90PlusCents || 0))}
                      </div>
                      <small style={{ color: '#ef4444' }}>High Risk Collection</small>
                    </Card>
                  </>
                )}
              </div>
            )}

            {/* Table */}
            <Card>
              {items.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
                  No records found for the selected criteria.
                </div>
              ) : (
                <Table>
                  {reportType === 'sales' && (
                    <>
                      <thead>
                        <tr>
                          <th>Invoice #</th>
                          <th>Date</th>
                          <th>Customer</th>
                          <th>Branch</th>
                          <th>Total</th>
                          <th>Paid</th>
                          <th>Balance</th>
                          {items[0]?.costCents != null && <th>Cost</th>}
                          {items[0]?.profitCents != null && <th>Profit</th>}
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((inv) => (
                          <tr key={inv._id}>
                            <td style={{ fontWeight: 600 }}>{inv.invoiceNumber}</td>
                            <td>{date(inv.createdAt)}</td>
                            <td>{inv.customerName}</td>
                            <td>{inv.branchName}</td>
                            <td style={{ fontWeight: 600 }}>{money(inv.grandTotalCents)}</td>
                            <td>{money(inv.totalPaidCents)}</td>
                            <td style={{ color: inv.balanceDueCents > 0 ? '#dc2626' : 'inherit' }}>
                              {money(inv.balanceDueCents)}
                            </td>
                            {inv.costCents != null && <td>{money(inv.costCents)}</td>}
                            {inv.profitCents != null && (
                              <td style={{ color: '#16a34a', fontWeight: 600 }}>{money(inv.profitCents)}</td>
                            )}
                            <td>
                              <Badge
                                tone={
                                  inv.paymentStatus === 'paid'
                                    ? 'success'
                                    : inv.paymentStatus === 'partially_paid'
                                    ? 'warning'
                                    : 'danger'
                                }
                              >
                                {inv.paymentStatus}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}

                  {reportType === 'inventory' && (
                    <>
                      <thead>
                        <tr>
                          <th>Product</th>
                          <th>Barcode</th>
                          <th>SKU</th>
                          <th>Qty on Hand</th>
                          <th>Retail Price</th>
                          <th>Total Retail Value</th>
                          {items[0]?.averageCostCents != null && <th>Avg Cost</th>}
                          {items[0]?.totalCostValueCents != null && <th>Total Cost Value</th>}
                          <th>Stock Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((prod) => (
                          <tr key={prod._id}>
                            <td style={{ fontWeight: 600 }}>{prod.name}</td>
                            <td>{prod.barcode}</td>
                            <td>{prod.sku || '—'}</td>
                            <td style={{ fontWeight: 600 }}>{prod.qtyOnHand}</td>
                            <td>{money(prod.sellingPriceCents)}</td>
                            <td style={{ fontWeight: 600 }}>{money(prod.totalRetailValueCents)}</td>
                            {prod.averageCostCents != null && <td>{money(prod.averageCostCents)}</td>}
                            {prod.totalCostValueCents != null && <td>{money(prod.totalCostValueCents)}</td>}
                            <td>
                              {prod.isLowStock ? (
                                <Badge tone="danger">Low Stock</Badge>
                              ) : (
                                <Badge tone="success">In Stock</Badge>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}

                  {reportType === 'repairs' && (
                    <>
                      <thead>
                        <tr>
                          <th>Ticket #</th>
                          <th>Tracking</th>
                          <th>Date</th>
                          <th>Device</th>
                          <th>Customer</th>
                          <th>Stage</th>
                          <th>Labour</th>
                          <th>Parts</th>
                          {items[0]?.partsCostCents != null && <th>Parts Cost</th>}
                          <th>Total</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((t) => (
                          <tr key={t._id}>
                            <td style={{ fontWeight: 600 }}>
                              <Link href={`/repairs/${t._id}`} style={{ color: 'var(--primary, #0ea5e9)' }}>
                                {t.ticketNo}
                              </Link>
                            </td>
                            <td><code>{t.publicCode || '—'}</code></td>
                            <td>{date(t.createdAt)}</td>
                            <td>{t.device}</td>
                            <td>{t.customerName}</td>
                            <td>
                              <Badge
                                tone={
                                  t.stage === 'Delivered'
                                    ? 'success'
                                    : t.stage === 'Cancelled' || t.stage === 'Unrepairable'
                                    ? 'danger'
                                    : 'warning'
                                }
                              >
                                {t.stage}
                              </Badge>
                            </td>
                            <td>{money(t.labourCents)}</td>
                            <td>{money(t.partsSellingCents)}</td>
                            {t.partsCostCents != null && <td>{money(t.partsCostCents)}</td>}
                            <td style={{ fontWeight: 600 }}>{money(t.grandTotalCents)}</td>
                            <td>
                              <Badge tone={t.paymentStatus === 'paid' ? 'success' : 'warning'}>
                                {t.paymentStatus}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}

                  {reportType === 'receivables' && (
                    <>
                      <thead>
                        <tr>
                          <th>Invoice #</th>
                          <th>Date</th>
                          <th>Customer</th>
                          <th>Phone</th>
                          <th>Total</th>
                          <th>Paid</th>
                          <th>Outstanding</th>
                          <th>Days Outstanding</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((ar) => (
                          <tr key={ar._id}>
                            <td style={{ fontWeight: 600 }}>{ar.invoiceNumber}</td>
                            <td>{date(ar.createdAt)}</td>
                            <td>{ar.customerName}</td>
                            <td>{ar.customerPhone || '—'}</td>
                            <td>{money(ar.grandTotalCents)}</td>
                            <td>{money(ar.totalPaidCents)}</td>
                            <td style={{ fontWeight: 700, color: '#dc2626' }}>
                              {money(ar.balanceDueCents)}
                            </td>
                            <td>{ar.daysOutstanding} days</td>
                            <td>
                              <Badge tone="danger">{ar.paymentStatus}</Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}
                </Table>
              )}
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
