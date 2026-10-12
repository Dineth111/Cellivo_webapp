import mongoose from 'mongoose';
import StockTransfer, { TRANSFER_STATUSES } from '../models/StockTransfer.model.js';
import Product from '../models/Product.model.js';
import SerialUnit from '../models/SerialUnit.model.js';
import Branch from '../../branches/Branch.model.js';
import * as stockService from './stock.service.js';
import * as imeiService from './imei.service.js';
import * as ledgerService from '../../pos/services/ledger.service.js';
import { runWithContext } from '../../../core/tenantContext.js';
import { badRequest, notFound } from '../../../core/errors.js';

function generateNumber(prefix = 'TRF') {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rnd = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${d}-${rnd}`;
}

async function withTenant(tenantId, fn) {
  const tid = tenantId instanceof mongoose.Types.ObjectId ? tenantId : new mongoose.Types.ObjectId(String(tenantId));
  return await runWithContext({ tenantId: tid }, fn);
}

async function executeWithSession(passedSession, fn) {
  if (passedSession) {
    return await fn(passedSession);
  }
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const res = await fn(session);
    await session.commitTransaction();
    return res;
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}

/**
 * 1. Request a transfer from one branch to another.
 */
export async function requestTransfer({
  tenantId,
  fromBranchId,
  toBranchId,
  items = [],
  notes = '',
  userId = null,
  session = null,
}) {
  return await withTenant(tenantId, async () => {
    return await executeWithSession(session, async (s) => {
      if (String(fromBranchId) === String(toBranchId)) {
        throw badRequest('Source and destination branches cannot be the same');
      }

      const fromBranch = await Branch.findById(fromBranchId).session(s);
      const toBranch = await Branch.findById(toBranchId).session(s);

      if (!fromBranch) throw notFound('Source branch not found');
      if (!toBranch) throw notFound('Destination branch not found');

      if (!Array.isArray(items) || items.length === 0) {
        throw badRequest('Transfer must contain at least one item');
      }

      const transferNumber = generateNumber('TRF');
      let totalCostCents = 0;
      const processedItems = [];

      for (const item of items) {
        const product = await Product.findOne({ _id: item.productId, isArchived: false }).session(s);
        if (!product) throw notFound(`Product ${item.productId} not found`);

        const reqQty = Math.max(1, parseInt(item.requestedQty, 10) || 1);
        const unitCostCents = product.costPriceCents || 0;
        totalCostCents += reqQty * unitCostCents;

        processedItems.push({
          productId: product._id,
          name: product.name,
          barcode: product.barcode || '',
          unitCostCents,
          requestedQty: reqQty,
          dispatchedQty: 0,
          receivedQty: 0,
          imeis: [],
          receivedImeis: [],
          discrepancyQty: 0,
          discrepancyNote: '',
        });
      }

      const [transfer] = await StockTransfer.create(
        [
          {
            transferNumber,
            fromBranchId,
            toBranchId,
            branchId: fromBranchId,
            status: 'requested',
            items: processedItems,
            totalTransferCostCents: totalCostCents,
            notes,
            requestedBy: userId,
            requestedAt: new Date(),
          },
        ],
        { session: s }
      );

      return transfer;
    });
  });
}

/**
 * 2. Approve a requested transfer.
 */
export async function approveTransfer({
  tenantId,
  transferId,
  userId = null,
  session = null,
}) {
  return await withTenant(tenantId, async () => {
    return await executeWithSession(session, async (s) => {
      const transfer = await StockTransfer.findById(transferId).session(s);
      if (!transfer) throw notFound('Transfer not found');

      if (transfer.status !== 'requested') {
        throw badRequest(`Cannot approve transfer in status '${transfer.status}'`);
      }

      transfer.status = 'approved';
      transfer.approvedBy = userId;
      transfer.approvedAt = new Date();
      await transfer.save({ session: s });

      return transfer;
    });
  });
}

/**
 * 3. Dispatch an approved transfer: deducts stock from source branch and marks IMEIs as in_transit.
 */
export async function dispatchTransfer({
  tenantId,
  transferId,
  dispatchItems = null, // Optional override with specific quantities/IMEIs
  userId = null,
  session = null,
}) {
  return await withTenant(tenantId, async () => {
    return await executeWithSession(session, async (s) => {
      const transfer = await StockTransfer.findById(transferId).session(s);
      if (!transfer) throw notFound('Transfer not found');

      if (transfer.status !== 'approved') {
        throw badRequest(`Cannot dispatch transfer in status '${transfer.status}'`);
      }

      let totalCostCents = 0;

      for (const item of transfer.items) {
        // If specific dispatch info provided, merge it
        let dispatchQty = item.requestedQty;
        let scannedImeis = [];

        if (Array.isArray(dispatchItems)) {
          const match = dispatchItems.find((d) => String(d.productId) === String(item.productId));
          if (match) {
            if (match.dispatchedQty !== undefined) dispatchQty = Math.max(0, parseInt(match.dispatchedQty, 10));
            if (Array.isArray(match.imeis)) scannedImeis = match.imeis;
          }
        }

        const product = await Product.findById(item.productId).session(s);
        if (!product) throw notFound(`Product ${item.productId} not found`);

        if (product.isSerialised) {
          if (scannedImeis.length !== dispatchQty) {
            throw badRequest(`Serialised product ${product.name} requires ${dispatchQty} scanned IMEI(s)`);
          }

          // Validate each IMEI is currently in source branch and in_stock
          for (const imei of scannedImeis) {
            const unit = await SerialUnit.findOne({
              imei1: imei,
              branchId: transfer.fromBranchId,
            }).session(s);

            if (!unit) {
              throw badRequest(`IMEI ${imei} does not belong to sending branch`);
            }
            if (unit.status !== 'in_stock') {
              throw badRequest(`IMEI ${imei} is not available for transfer (status: ${unit.status})`);
            }

            // Transition IMEI to in_transit
            await imeiService.transitionStatus({
              tenantId,
              imei,
              newStatus: 'in_transit',
              branchId: transfer.fromBranchId,
              userId,
              session: s,
            });
          }
          item.imeis = scannedImeis;
        } else if (dispatchQty > 0) {
          // Atomically deduct stock from sending branch for non-serialised items
          await stockService.adjustStockLevel({
            tenantId,
            productId: item.productId,
            branchId: transfer.fromBranchId,
            type: 'transfer_out',
            qtyChange: -dispatchQty,
            unitCostCents: item.unitCostCents,
            referenceType: 'transfer',
            referenceId: transfer.transferNumber,
            note: `Transfer dispatch to branch ${transfer.toBranchId}`,
            userId,
            session: s,
          });
        }

        item.dispatchedQty = dispatchQty;
        totalCostCents += dispatchQty * (item.unitCostCents || 0);
      }

      transfer.totalTransferCostCents = totalCostCents;
      transfer.status = 'dispatched';
      transfer.dispatchedBy = userId;
      transfer.dispatchedAt = new Date();
      await transfer.save({ session: s });

      return transfer;
    });
  });
}

/**
 * 4. Receive transfer at destination branch: increments stock, moves IMEIs, and records discrepancies.
 */
export async function receiveTransfer({
  tenantId,
  transferId,
  receivedItems = [],
  notes = '',
  userId = null,
  session = null,
}) {
  return await withTenant(tenantId, async () => {
    return await executeWithSession(session, async (s) => {
      const transfer = await StockTransfer.findById(transferId).session(s);
      if (!transfer) throw notFound('Transfer not found');

      if (!['dispatched', 'partially_received'].includes(transfer.status)) {
        throw badRequest(`Cannot receive transfer in status '${transfer.status}'`);
      }

      let totalReceivedCostCents = 0;

      for (const rItem of receivedItems) {
        const itemLine = transfer.items.find((i) => String(i.productId) === String(rItem.productId));
        if (!itemLine) {
          throw badRequest(`Product ${rItem.productId} is not part of this transfer`);
        }

        const product = await Product.findById(itemLine.productId).session(s);
        if (!product) throw notFound(`Product ${itemLine.productId} not found`);

        const newlyReceivedQty = Math.max(0, parseInt(rItem.receivedQty, 10) || 0);
        const scannedImeis = Array.isArray(rItem.receivedImeis) ? rItem.receivedImeis : [];

        if (product.isSerialised) {
          if (scannedImeis.length !== newlyReceivedQty) {
            throw badRequest(`Serialised product ${product.name} requires ${newlyReceivedQty} scanned IMEI(s)`);
          }

          // Validate each IMEI is part of dispatched items
          for (const imei of scannedImeis) {
            if (!itemLine.imeis.includes(imei)) {
              throw badRequest(`IMEI ${imei} was not dispatched in this transfer`);
            }
            if (itemLine.receivedImeis.includes(imei)) {
              throw badRequest(`IMEI ${imei} has already been received`);
            }

            // Transition IMEI to in_stock and update branch to toBranchId
            await imeiService.transitionStatus({
              tenantId,
              imei,
              newStatus: 'in_stock',
              newBranchId: transfer.toBranchId,
              userId,
              session: s,
            });

            itemLine.receivedImeis.push(imei);
          }
        } else if (newlyReceivedQty > 0) {
          // Increment stock at receiving branch for non-serialised items
          await stockService.adjustStockLevel({
            tenantId,
            productId: itemLine.productId,
            branchId: transfer.toBranchId,
            type: 'transfer_in',
            qtyChange: newlyReceivedQty,
            unitCostCents: itemLine.unitCostCents,
            referenceType: 'transfer',
            referenceId: transfer.transferNumber,
            note: `Transfer received from branch ${transfer.fromBranchId}`,
            userId,
            session: s,
          });
        }

        itemLine.receivedQty = (itemLine.receivedQty || 0) + newlyReceivedQty;
        itemLine.discrepancyQty = Math.max(0, itemLine.dispatchedQty - itemLine.receivedQty);
        if (rItem.discrepancyNote) {
          itemLine.discrepancyNote = rItem.discrepancyNote;
        }

        totalReceivedCostCents += newlyReceivedQty * (itemLine.unitCostCents || 0);
      }

      // Check overall transfer completion status
      const allFullyReceived = transfer.items.every((i) => i.receivedQty >= i.dispatchedQty);
      transfer.status = allFullyReceived ? 'completed' : 'partially_received';
      transfer.receivedBy = userId;
      transfer.receivedAt = new Date();
      if (notes) transfer.notes = transfer.notes ? `${transfer.notes}\n${notes}` : notes;

      await transfer.save({ session: s });

      // Double-entry ledger journal for transfer between branches: Dr 1050 (Destination) / Cr 1050 (Source)
      if (totalReceivedCostCents > 0) {
        await ledgerService.postJournal({
          tenantId,
          branchId: transfer.toBranchId,
          referenceType: 'transfer',
          referenceId: transfer.transferNumber,
          description: `Stock transfer ${transfer.transferNumber} received at branch`,
          lines: [
            { accountCode: '1050', debit: totalReceivedCostCents, credit: 0 },
            { accountCode: '1050', debit: 0, credit: totalReceivedCostCents },
          ],
          createdBy: userId,
          session: s,
        });
      }

      return transfer;
    });
  });
}

/**
 * 5. Cancel or reject transfer.
 */
export async function cancelTransfer({
  tenantId,
  transferId,
  reason = '',
  userId = null,
  session = null,
}) {
  return await withTenant(tenantId, async () => {
    return await executeWithSession(session, async (s) => {
      const transfer = await StockTransfer.findById(transferId).session(s);
      if (!transfer) throw notFound('Transfer not found');

      if (['completed', 'cancelled', 'rejected'].includes(transfer.status)) {
        throw badRequest(`Cannot cancel transfer in status '${transfer.status}'`);
      }

      if (transfer.status === 'dispatched') {
        // Reverse dispatched stock and IMEIs back to source branch
        for (const item of transfer.items) {
          if (Array.isArray(item.imeis) && item.imeis.length > 0) {
            for (const imei of item.imeis) {
              await imeiService.transitionStatus({
                tenantId,
                imei,
                newStatus: 'in_stock',
                userId,
                session: s,
              });
            }
          } else if (item.dispatchedQty > 0) {
            await stockService.adjustStockLevel({
              tenantId,
              productId: item.productId,
              branchId: transfer.fromBranchId,
              type: 'transfer_in',
              qtyChange: item.dispatchedQty,
              unitCostCents: item.unitCostCents,
              referenceType: 'transfer',
              referenceId: transfer.transferNumber,
              note: `Cancelled transfer return: ${reason}`,
              userId,
              session: s,
            });
          }
        }
      }

      transfer.status = 'cancelled';
      transfer.notes = transfer.notes ? `${transfer.notes}\nCancelled: ${reason}` : `Cancelled: ${reason}`;
      await transfer.save({ session: s });

      return transfer;
    });
  });
}

export default {
  requestTransfer,
  approveTransfer,
  dispatchTransfer,
  receiveTransfer,
  cancelTransfer,
};
