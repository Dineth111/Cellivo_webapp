import crypto from 'crypto';
import mongoose from 'mongoose';
import RepairTicket, { publicCodeHelper } from '../models/RepairTicket.model.js';
import RepairSequence from '../models/RepairSequence.model.js';
import Customer from '../../customers/Customer.model.js';
import User from '../../users/User.model.js';
import Tenant from '../../tenants/Tenant.model.js';
import { normalizePhone, phoneVariants } from '../../customers/utils/phone.js';
import { encryptPasscode, decryptPasscode, hasPasscodeKey } from '../utils/passcode.js';
import { validateImei } from '../utils/imei.js';
import { reservePart, releasePart } from '../adapters/stock.adapter.js';
import {
  postAdvanceDeposit,
  postRepairInvoice,
  postAdvanceCancellation,
  postRepairPartWriteOff,
} from '../adapters/ledger.adapter.js';
import { PAYMENT_ACCOUNTS } from '../../pos/services/ledger.service.js';
import * as stockService from '../../inventory/services/stock.service.js';
import * as imeiService from '../../inventory/services/imei.service.js';
import SerialUnit from '../../inventory/models/SerialUnit.model.js';
import * as notificationsService from '../../notifications/services/notifications.service.js';
import { runWithContext, runAsPlatform, getContext } from '../../../core/tenantContext.js';
import { badRequest, notFound, forbidden, conflict } from '../../../core/errors.js';
import { escapeRegex, requireId, pick } from '../../../core/validate.js';
import { hasPermission, hasSpecial } from '../../../core/permissions.js';

export const ALLOWED_PAYMENT_METHODS = Object.keys(PAYMENT_ACCOUNTS);

export const ALLOWED_STAGES = [
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

export const TERMINAL_STAGES = ['Delivered', 'Unrepairable', 'Cancelled'];

export const STAGE_TRANSITIONS = {
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

function isTransient(err) {
  return (
    err?.errorLabels?.has?.('TransientTransactionError') ||
    err?.errorLabelSet?.has?.('TransientTransactionError') ||
    (Array.isArray(err?.errorLabels) && err.errorLabels.includes('TransientTransactionError')) ||
    err?.code === 112
  );
}

function isPublicCodeDuplicate(err) {
  if (!err) return false;
  const isDup = err.code === 11000 || err.codeName === 'DuplicateKey';
  if (!isDup) return false;
  return Boolean(
    err.keyPattern?.publicCode ||
    err.keyValue?.publicCode ||
    String(err.message || '').includes('publicCode')
  );
}


/**
 * Creates a repair ticket with atomic sequence numbering, customer lookup/creation (or shop-owned unit),
 * passcode encryption, advance payment posting, and shop-owned device status transition to in_repair.
 */
export async function createTicket({
  tenantId,
  branchId,
  customerId = null,
  customerData = null,
  device,
  accessories = [],
  conditionNotes = '',
  photoUrls = [],
  faultDescription,
  estimateCents = 0,
  advanceCents = 0,
  advancePaymentMethod = 'cash',
  promisedDate = null,
  technicianId = null,
  passcode = null,
  internalNotes = '',
  user,
}) {
  if (customerId) {
    requireId(customerId, 'customerId');
  }

  // advancePaymentMethod must be in ALLOWED_PAYMENT_METHODS
  if (advancePaymentMethod && !ALLOWED_PAYMENT_METHODS.includes(advancePaymentMethod)) {
    throw badRequest(`Invalid advance payment method: ${advancePaymentMethod}`, 'INVALID_PAYMENT_METHOD');
  }

  // advanceCents and estimateCents must be integers 0..100000000 (reject, do not coerce)
  if (estimateCents !== undefined && estimateCents !== null) {
    if (!Number.isInteger(estimateCents) || estimateCents < 0 || estimateCents > 100000000) {
      throw badRequest('estimateCents must be an integer between 0 and 100000000', 'INVALID_ESTIMATE');
    }
  }
  if (advanceCents !== undefined && advanceCents !== null) {
    if (!Number.isInteger(advanceCents) || advanceCents < 0 || advanceCents > 100000000) {
      throw badRequest('advanceCents must be an integer between 0 and 100000000', 'INVALID_ADVANCE');
    }
  }

  // device validation
  if (!device || !device.brand || !device.model) {
    throw badRequest('Device brand and model are required');
  }
  if (
    typeof device.brand !== 'string' ||
    device.brand.trim().length > 100 ||
    typeof device.model !== 'string' ||
    device.model.trim().length > 100
  ) {
    throw badRequest('Device brand and model must not exceed 100 characters', 'INVALID_DEVICE');
  }
  if (device.imei && (typeof device.imei !== 'string' || device.imei.trim().length > 50)) {
    throw badRequest('Device IMEI must not exceed 50 characters', 'INVALID_IMEI_LENGTH');
  }
  if (device.serial && (typeof device.serial !== 'string' || device.serial.trim().length > 50)) {
    throw badRequest('Device serial must not exceed 50 characters', 'INVALID_SERIAL_LENGTH');
  }
  if (device.colour && (typeof device.colour !== 'string' || device.colour.trim().length > 50)) {
    throw badRequest('Device colour must not exceed 50 characters', 'INVALID_COLOUR_LENGTH');
  }

  // Validate IMEI if provided
  const cleanedImei = device.imei ? String(device.imei).trim() : null;
  if (cleanedImei) {
    if (!validateImei(cleanedImei)) {
      throw badRequest('Invalid IMEI number (failed Luhn checksum)', 'INVALID_IMEI');
    }
  }

  // faultDescription non-empty, <= 1000
  if (!faultDescription || typeof faultDescription !== 'string' || !faultDescription.trim() || faultDescription.trim().length > 1000) {
    throw badRequest('Fault description is required and must not exceed 1000 characters', 'INVALID_FAULT_DESCRIPTION');
  }

  // conditionNotes and internalNotes <= 2000
  if (conditionNotes && (typeof conditionNotes !== 'string' || conditionNotes.length > 2000)) {
    throw badRequest('Condition notes must not exceed 2000 characters', 'INVALID_CONDITION_NOTES');
  }
  if (internalNotes && (typeof internalNotes !== 'string' || internalNotes.length > 2000)) {
    throw badRequest('Internal notes must not exceed 2000 characters', 'INVALID_INTERNAL_NOTES');
  }

  // photoUrls: only http/https URLs <= 500 chars, max 6
  if (photoUrls) {
    if (!Array.isArray(photoUrls) || photoUrls.length > 6) {
      throw badRequest('Maximum 6 photo URLs allowed', 'INVALID_PHOTO_URLS');
    }
    for (const u of photoUrls) {
      if (typeof u !== 'string' || u.length > 500 || !/^https?:\/\//i.test(u)) {
        throw badRequest('Photo URLs must be valid http/https URLs of at most 500 characters', 'INVALID_PHOTO_URL');
      }
    }
  }

  // accessories: <= 20 items of <= 50 chars
  if (accessories) {
    if (!Array.isArray(accessories) || accessories.length > 20 || accessories.some((a) => typeof a !== 'string' || a.trim().length > 50)) {
      throw badRequest('Accessories must be an array of at most 20 items, each up to 50 characters', 'INVALID_ACCESSORIES');
    }
  }

  // promisedDate
  let parsedPromisedDate = null;
  if (promisedDate) {
    const d = new Date(promisedDate);
    const year = d.getFullYear();
    if (isNaN(d.getTime()) || year < 2000 || year > 2100) {
      throw badRequest('Invalid promisedDate', 'INVALID_PROMISED_DATE');
    }
    parsedPromisedDate = d;
  }

  // Check shop-owned unit & active repair before transaction
  let isShopOwned = false;
  let preCheckUnit = null;

  if (cleanedImei) {
    const activeTicket = await runWithContext({ tenantId }, async () => {
      return await RepairTicket.findOne({
        tenantId,
        'device.imei': cleanedImei,
        stage: { $nin: TERMINAL_STAGES },
      }).lean();
    });
    if (activeTicket) {
      throw badRequest(`Device with IMEI ${cleanedImei} is already in repair (ticket ${activeTicket.ticketNo})`, 'DEVICE_ALREADY_IN_REPAIR');
    }

    preCheckUnit = await runWithContext({ tenantId }, async () => {
      return await SerialUnit.findOne({
        tenantId,
        branchId,
        $or: [{ imei1: cleanedImei }, { imei2: cleanedImei }],
      }).lean();
    });

    if (preCheckUnit) {
      if (preCheckUnit.status === 'in_repair') {
        throw badRequest(`Device with IMEI ${cleanedImei} is already in repair`, 'DEVICE_ALREADY_IN_REPAIR');
      }
      if (['in_stock', 'reserved'].includes(preCheckUnit.status)) {
        isShopOwned = true;
      }
    }
  }

  // Permission and requirements validation:
  if (isShopOwned) {
    const userRole = user?.role || getContext()?.role;
    if (!hasPermission(userRole, 'repairs.create') || !hasPermission(userRole, 'inventory.edit')) {
      throw forbidden('Creating a shop-owned repair ticket requires repairs.create and inventory.edit permissions');
    }
    if (advanceCents && Number(advanceCents) > 0) {
      throw badRequest('Shop-owned repairs cannot have an advance payment', 'ADVANCE_NOT_ALLOWED');
    }
  } else {
    // If not shop owned: customer is required!
    if (!customerId && !customerData) {
      throw badRequest('Customer is required for customer repair tickets', 'CUSTOMER_REQUIRED');
    }
  }

  let resolvedCustomer = null;
  let createdTicket = null;
  let passcodeWarning = null;
  let attempts = 0;

  while (attempts < 5) {
    attempts++;
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      await runWithContext({ tenantId }, async () => {
        // Re-check under transaction lock
        if (cleanedImei) {
          const activeTicket = await RepairTicket.findOne({
            tenantId,
            'device.imei': cleanedImei,
            stage: { $nin: TERMINAL_STAGES },
          }).session(session);
          if (activeTicket) {
            throw badRequest(`Device with IMEI ${cleanedImei} is already in repair (ticket ${activeTicket.ticketNo})`, 'DEVICE_ALREADY_IN_REPAIR');
          }

          if (isShopOwned) {
            const unit = await SerialUnit.findOne({
              tenantId,
              branchId,
              $or: [{ imei1: cleanedImei }, { imei2: cleanedImei }],
            }).session(session);

            if (!unit || !['in_stock', 'reserved'].includes(unit.status)) {
              throw badRequest(`Device with IMEI ${cleanedImei} is already in repair`, 'DEVICE_ALREADY_IN_REPAIR');
            }
          }
        }

        // 1. Resolve or create customer (for non-shop-owned tickets)
        if (!isShopOwned) {
          if (customerId) {
            resolvedCustomer = await Customer.findById(customerId).session(session);
            if (!resolvedCustomer) throw notFound('Customer not found');
          } else if (customerData) {
            const rawPhone = customerData.phone || '';
            const normalized = normalizePhone(rawPhone);
            if (!normalized) {
              throw badRequest('A valid phone number is required for the customer');
            }

            const variants = phoneVariants(rawPhone);
            resolvedCustomer = await Customer.findOne({
              phone: { $in: variants },
              isArchived: false,
            }).session(session);

            if (!resolvedCustomer) {
              const newCust = new Customer({
                name: customerData.name?.trim() || 'Walk-in Customer',
                phone: normalized,
                email: customerData.email?.trim() || '',
                address: typeof customerData.address === 'string' ? customerData.address.trim() : '',
                marketingOptIn: Boolean(customerData.marketingOptIn),
                createdBy: user._id,
              });
              resolvedCustomer = await newCust.save({ session });
            }
          }
        }

        // 2. Validate technician if supplied
        if (technicianId) {
          const tech = await User.findOne({
            _id: technicianId,
            isActive: true,
            branchIds: branchId,
          })
            .populate('roleId')
            .session(session);
          if (!tech || !hasPermission(tech.roleId, 'repairs.edit')) {
            throw badRequest('Technician must be an active user assigned to this branch with repairs.edit permission', 'INVALID_TECHNICIAN');
          }
        }

        // 3. Generate atomic ticket number (tenant-scoped)
        const ticketNo = await RepairSequence.getNextNumber(tenantId, null, 'JOB-', session);

        // 4. Shop-owned device transition to in_repair
        let serialUnitId = null;
        if (isShopOwned && cleanedImei) {
          const transitioned = await imeiService.transitionStatus({
            tenantId,
            imei: cleanedImei,
            newStatus: 'in_repair',
            branchId,
            userId: user._id,
            reason: `Repair intake ticket ${ticketNo}`,
            session,
          });
          serialUnitId = transitioned?._id || null;
        } else if (cleanedImei && preCheckUnit) {
          serialUnitId = preCheckUnit._id;
        }

        // 5. Encrypt passcode if provided
        let passcodeEncrypted = null;
        if (passcode) {
          if (!hasPasscodeKey()) {
            passcodeWarning = 'Passcode key not configured; passcode was not stored';
          } else {
            passcodeEncrypted = encryptPasscode(passcode);
          }
        }

        // 6. Post advance journal if advance > 0 (customer tickets only)
        const advCents = (!isShopOwned && advanceCents) ? advanceCents : 0;
        if (advCents > 0) {
          await postAdvanceDeposit({
            tenantId,
            branchId,
            ticketNo,
            amountCents: advCents,
            paymentMethod: advancePaymentMethod,
            createdBy: user._id,
            session,
          });
        }

        // 7. Create ticket document
        createdTicket = new RepairTicket({
          ticketNo,
          branchId,
          customerId: isShopOwned ? null : resolvedCustomer?._id,
          shopOwnedUnit: isShopOwned,
          serialUnitId,
          device: {
            brand: device.brand.trim(),
            model: device.model.trim(),
            imei: cleanedImei,
            serial: device.serial ? String(device.serial).trim() : null,
            colour: device.colour ? String(device.colour).trim() : null,
          },
          passcodeEncrypted,
          accessories: Array.isArray(accessories) ? accessories : [],
          conditionNotes: conditionNotes ? String(conditionNotes).trim() : '',
          photoUrls: Array.isArray(photoUrls) ? photoUrls.slice(0, 6) : [],
          faultDescription: faultDescription.trim(),
          estimateCents: estimateCents || 0,
          advanceCents: advCents,
          advancePaymentMethod,
          advanceSettled: false,
          promisedDate: parsedPromisedDate,
          stage: 'Received',
          technicianId: technicianId || null,
          approval: isShopOwned ? { status: 'not_applicable', at: new Date() } : { status: 'none' },
          history: [
            {
              from: 'None',
              to: 'Received',
              at: new Date(),
              userId: user._id,
              note: isShopOwned ? 'Shop-owned ticket created at intake' : 'Ticket created at intake',
            },
          ],
          internalNotes: internalNotes ? String(internalNotes).trim() : '',
          trackingToken: crypto.randomBytes(24).toString('hex'),
          publicCode: publicCodeHelper.generate(),
          createdBy: user._id,
        });

        await createdTicket.save({ session });
      });

      await session.commitTransaction();
      session.endSession();
      break;
    } catch (err) {
      try {
        await session.abortTransaction();
      } catch {
        // preserve original error
      }
      session.endSession();
      if ((isTransient(err) || isPublicCodeDuplicate(err)) && attempts < 5) {
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 50));
        continue;
      }
      throw err;
    }
  }

  // 8. Post-commit notification (customer tickets only)
  if (!isShopOwned && resolvedCustomer && resolvedCustomer.phone) {
    try {
      const tenantDoc = await runAsPlatform(async () => Tenant.findById(tenantId).select('name').lean());
      const shopName = tenantDoc?.name || 'Cellivo Shop';

      await notificationsService.notify({
        tenantId,
        branchId,
        channel: 'sms',
        to: resolvedCustomer.phone,
        template: 'repair_created',
        data: {
          ticket_no: createdTicket.ticketNo,
          customer_name: resolvedCustomer.name,
          status: createdTicket.stage,
          shop: shopName,
          public_code: createdTicket.publicCode,
        },
      });
    } catch (e) {
      // Notification errors must never fail ticket creation
    }
  }

  return {
    ticket: createdTicket,
    customer: resolvedCustomer,
    warning: passcodeWarning,
  };
}

/**
 * Updates a repair ticket (PUT /:id).
 * Enforces TICKET_LOCKED, ESTIMATE_LOCKED, approval reset, and field length/type validations.
 */
export async function updateTicket({ tenantId, ticketId, data = {}, user }) {
  return await runWithContext({ tenantId }, async () => {
    const ticket = await RepairTicket.findById(ticketId);
    if (!ticket) throw notFound('Repair ticket not found');

    const allowed = pick(data, ['conditionNotes', 'faultDescription', 'estimateCents', 'promisedDate', 'accessories', 'internalNotes']);

    // 1. If ticket.isInvoiceSettled or stage is terminal, reject every field except internalNotes (400 TICKET_LOCKED)
    const isLocked = ticket.isInvoiceSettled || TERMINAL_STAGES.includes(ticket.stage);
    if (isLocked) {
      const nonInternalKeys = Object.keys(data).filter((k) => k !== 'internalNotes');
      if (nonInternalKeys.length > 0) {
        throw badRequest('Ticket is locked; only internal notes may be updated', 'TICKET_LOCKED');
      }
    }

    // 2. Validate conditionNotes & internalNotes <= 2000 chars
    if (allowed.conditionNotes !== undefined) {
      if (typeof allowed.conditionNotes !== 'string' || allowed.conditionNotes.length > 2000) {
        throw badRequest('Condition notes must not exceed 2000 characters', 'INVALID_CONDITION_NOTES');
      }
    }
    if (allowed.internalNotes !== undefined) {
      if (typeof allowed.internalNotes !== 'string' || allowed.internalNotes.length > 2000) {
        throw badRequest('Internal notes must not exceed 2000 characters', 'INVALID_INTERNAL_NOTES');
      }
    }

    // 3. Validate faultDescription: non-empty and <= 1000 chars
    if (allowed.faultDescription !== undefined) {
      if (typeof allowed.faultDescription !== 'string' || !allowed.faultDescription.trim() || allowed.faultDescription.trim().length > 1000) {
        throw badRequest('Fault description must be non-empty and not exceed 1000 characters', 'INVALID_FAULT_DESCRIPTION');
      }
    }

    // 4. Validate accessories: <= 20 items of <= 50 chars
    if (allowed.accessories !== undefined) {
      if (!Array.isArray(allowed.accessories) || allowed.accessories.length > 20 || allowed.accessories.some((a) => typeof a !== 'string' || a.trim().length > 50)) {
        throw badRequest('Accessories must be an array of at most 20 items, each up to 50 characters', 'INVALID_ACCESSORIES');
      }
    }

    // 5. Validate promisedDate: valid date (400 otherwise)
    if (allowed.promisedDate !== undefined) {
      if (allowed.promisedDate === null || allowed.promisedDate === '') {
        ticket.promisedDate = null;
      } else {
        const d = new Date(allowed.promisedDate);
        const year = d.getFullYear();
        if (isNaN(d.getTime()) || year < 2000 || year > 2100) {
          throw badRequest('Invalid promisedDate', 'INVALID_PROMISED_DATE');
        }
        ticket.promisedDate = d;
      }
    }

    // 6. Validate estimateCents
    if (allowed.estimateCents !== undefined) {
      if (!Number.isInteger(allowed.estimateCents) || allowed.estimateCents < 0 || allowed.estimateCents > 100000000) {
        throw badRequest('estimateCents must be an integer between 0 and 100000000', 'INVALID_ESTIMATE');
      }
      if (allowed.estimateCents !== ticket.estimateCents) {
        const inRepairOrLater = ['In repair', 'Quality check', 'Ready', 'Delivered', 'Unrepairable', 'Cancelled'];
        if (inRepairOrLater.includes(ticket.stage)) {
          throw badRequest(`Cannot modify estimate once ticket has reached "${ticket.stage}" stage`, 'ESTIMATE_LOCKED');
        }
        // Before In repair, if estimateCents changes and approval.status is 'approved', reset approval to 'none' and add history entry
        if (ticket.approval?.status === 'approved') {
          ticket.approval = {
            status: 'none',
            at: null,
            by: null,
            recordedBy: null,
            waivedBy: null,
            waivedAt: null,
          };
          ticket.history.push({
            from: ticket.stage,
            to: ticket.stage,
            at: new Date(),
            userId: user._id,
            note: 'Estimate changed; re-approval needed',
          });
        }
        ticket.estimateCents = allowed.estimateCents;
      }
    }

    const before = {
      conditionNotes: ticket.conditionNotes,
      faultDescription: ticket.faultDescription,
      estimateCents: ticket.estimateCents,
      promisedDate: ticket.promisedDate,
      accessories: ticket.accessories,
      internalNotes: ticket.internalNotes,
    };

    if (allowed.conditionNotes !== undefined) ticket.conditionNotes = allowed.conditionNotes.trim();
    if (allowed.faultDescription !== undefined) ticket.faultDescription = allowed.faultDescription.trim();
    if (Array.isArray(allowed.accessories)) ticket.accessories = allowed.accessories.map((a) => a.trim());
    if (allowed.internalNotes !== undefined) ticket.internalNotes = allowed.internalNotes.trim();

    await ticket.save();

    return { ticket, before, after: allowed };
  });
}

/**
 * Changes repair ticket stage with transition validation, shop-owned IMEI status updates,
 * COGS/parts write-off on cancellation, and optional notification.
 */
export async function changeStage({
  tenantId,
  ticketId,
  to,
  note = '',
  advanceDecision = 'none',
  feeCents = 0,
  paymentMethod = null,
  waiveApproval = false,
  user,
}) {
  if (!ALLOWED_STAGES.includes(to)) {
    throw badRequest(`Invalid stage: "${to}". Allowed stages: ${ALLOWED_STAGES.join(', ')}`);
  }

  let attempts = 0;
  let updatedTicket = null;
  let customerPhone = null;
  let customerName = '';
  let isReopen = false;

  while (attempts < 3) {
    attempts++;
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      await runWithContext({ tenantId }, async () => {
        const ticket = await RepairTicket.findById(ticketId).session(session);
        if (!ticket) throw notFound('Repair ticket not found');

        const currentStage = ticket.stage;

        // 1. Reject cancellation if invoice is already settled
        if (to === 'Cancelled' && ticket.isInvoiceSettled) {
          throw badRequest('Cannot cancel a repair ticket after the invoice has been settled', 'INVOICE_SETTLED');
        }

        // 2. Check allowed transition
        const allowedMoves = STAGE_TRANSITIONS[currentStage] || [];
        if (!allowedMoves.includes(to)) {
          throw badRequest(
            `Cannot move ticket from ${currentStage} to ${to}. Allowed moves from ${currentStage}: ${allowedMoves.join(', ')}`,
            'INVALID_STAGE_TRANSITION'
          );
        }

        // 3. Reopening from terminal stage: Owner only
        if (TERMINAL_STAGES.includes(currentStage)) {
          if (user.role?.key !== 'owner') {
            throw forbidden('Only the shop owner can reopen a terminal repair ticket', 'OWNER_ONLY');
          }
          if (to !== 'Diagnosing') {
            throw badRequest('Reopened tickets must move to Diagnosing stage');
          }
          isReopen = true;
        }

        // 4. Approval gate for In repair
        if (to === 'In repair') {
          if (ticket.shopOwnedUnit) {
            // Shop-owned tickets: skip customer approval gate
            ticket.approval = { status: 'not_applicable', at: new Date() };
          } else {
            const isApproved = ticket.approval?.status === 'approved' || ticket.approval?.status === 'waived';
            if (!isApproved) {
              const canApprove = user.role?.key === 'owner' || hasPermission(user.role, 'repairs.approve');
              if (waiveApproval && canApprove) {
                ticket.approval.status = 'waived';
                ticket.approval.waivedBy = user._id;
                ticket.approval.waivedAt = new Date();
              } else {
                throw badRequest(
                  'Cannot move to In repair without customer approval or approval waiver by an authorized user',
                  'APPROVAL_REQUIRED'
                );
              }
            }
          }
        }

        // 5. Moving to Delivered
        if (to === 'Delivered') {
          // Shop-owned units close without customer invoice
          if (!ticket.shopOwnedUnit && !ticket.isInvoiceSettled) {
            throw badRequest(
              'Cannot mark ticket as Delivered until the invoice has been settled',
              'INVOICE_NOT_SETTLED'
            );
          }
          ticket.deliveredAt = new Date();
          if (ticket.warrantyDays > 0) {
            ticket.warrantyExpiresAt = new Date(ticket.deliveredAt.getTime() + ticket.warrantyDays * 24 * 60 * 60 * 1000);
          }
        }

        // 6. Moving from In repair, Quality check or Ready to Cancelled requires repairs.approve or owner + note
        if (to === 'Cancelled' && ['In repair', 'Quality check', 'Ready'].includes(currentStage)) {
          const canApprove = user.role?.key === 'owner' || hasPermission(user.role, 'repairs.approve');
          if (!canApprove) {
            throw forbidden('Cancellation from In repair, Quality check, or Ready requires approval permission', 'APPROVAL_REQUIRED');
          }
          if (!note || !note.trim()) {
            throw badRequest('A cancellation note is required when cancelling an in-progress repair', 'NOTE_REQUIRED');
          }
        }

        // 7. Shop-owned unit IMEI status lifecycle transitions
        if (ticket.shopOwnedUnit && ticket.device?.imei) {
          const cleanedImei = ticket.device.imei.trim();

          if (isReopen) {
            // Reopening a shop-owned ticket: check unit status
            const unit = await SerialUnit.findOne({
              branchId: ticket.branchId,
              $or: [{ imei1: cleanedImei }, { imei2: cleanedImei }],
            }).session(session);

            if (!unit) {
              throw notFound(`Serial unit for IMEI ${cleanedImei} not found`);
            }
            if (unit.status === 'in_stock') {
              await imeiService.transitionStatus({
                tenantId,
                imei: cleanedImei,
                newStatus: 'in_repair',
                branchId: ticket.branchId,
                userId: user._id,
                reason: `Reopened repair ticket ${ticket.ticketNo}`,
                session,
              });
            } else if (unit.status === 'in_repair') {
              // already in_repair -> do nothing
            } else {
              throw badRequest(
                `Cannot reopen shop repair: unit status is '${unit.status}', expected 'in_stock' or 'in_repair'`,
                'CANNOT_REOPEN_UNIT_STATUS'
              );
            }
          } else if (to === 'Ready') {
            await imeiService.transitionStatus({
              tenantId,
              imei: cleanedImei,
              newStatus: 'in_stock',
              branchId: ticket.branchId,
              userId: user._id,
              reason: `Repair ready ticket ${ticket.ticketNo}`,
              session,
            });
          } else if (to === 'Cancelled' || to === 'Delivered') {
            const unit = await SerialUnit.findOne({
              branchId: ticket.branchId,
              $or: [{ imei1: cleanedImei }, { imei2: cleanedImei }],
            }).session(session);

            if (unit && unit.status === 'in_repair') {
              await imeiService.transitionStatus({
                tenantId,
                imei: cleanedImei,
                newStatus: 'in_stock',
                branchId: ticket.branchId,
                userId: user._id,
                reason: `Repair ${to.toLowerCase()} ticket ${ticket.ticketNo}`,
                session,
              });
            }
          } else if (to === 'Unrepairable') {
            // Leave unit in in_repair; do not transition back to stock
          }
        }

        // 8. Advance handling on Cancelled or Unrepairable (customer tickets only)
        if (['Cancelled', 'Unrepairable'].includes(to) && !ticket.shopOwnedUnit && ticket.advanceCents > 0 && !ticket.advanceSettled) {
          const canApprove = user.role?.key === 'owner' || hasPermission(user.role, 'repairs.approve');
          if (!canApprove) {
            throw forbidden('Handling advance settlement on cancelled/unrepairable tickets requires approval permission', 'APPROVAL_REQUIRED');
          }
          if (!['refund', 'keep_fee'].includes(advanceDecision)) {
            throw badRequest('Advance decision must be specified: "refund" or "keep_fee"', 'ADVANCE_DECISION_REQUIRED');
          }

          const fee = Math.max(0, Math.round(feeCents || 0));
          const cancelMethod = paymentMethod || ticket.advancePaymentMethod || 'cash';
          await postAdvanceCancellation({
            tenantId,
            branchId: ticket.branchId,
            ticketNo: ticket.ticketNo,
            advanceCents: ticket.advanceCents,
            decision: advanceDecision,
            feeCents: fee,
            paymentMethod: cancelMethod,
            createdBy: user._id,
            session,
          });

          ticket.advanceSettled = true;
          ticket.advanceDecision = advanceDecision;
          ticket.advanceFeeCents = fee;
        }

        // 9. Parts write-off on Cancelled or Unrepairable (for customer tickets)
        if (['Cancelled', 'Unrepairable'].includes(to) && !ticket.shopOwnedUnit) {
          const invCost = ticket.parts
            .filter((p) => p.inventoryManaged)
            .reduce((sum, p) => sum + (p.qty || 1) * (p.unitCostCents || 0), 0);
          const deltaCogs = Math.max(0, invCost - (ticket.cogsPostedCents || 0));
          if (deltaCogs > 0) {
            await postRepairPartWriteOff({
              tenantId,
              branchId: ticket.branchId,
              ticketNo: ticket.ticketNo,
              costCents: deltaCogs,
              createdBy: user._id,
              session,
            });
            ticket.cogsPostedCents = (ticket.cogsPostedCents || 0) + deltaCogs;
          }
        }

        // 10. Update ticket stage and append history
        ticket.stage = to;
        ticket.history.push({
          from: currentStage,
          to,
          at: new Date(),
          userId: user._id,
          note: note ? String(note).trim() : isReopen ? 'Ticket reopened by owner' : '',
        });

        await ticket.save({ session });
        updatedTicket = ticket;

        // Fetch customer for notification (customer tickets only)
        if (!ticket.shopOwnedUnit && ticket.customerId) {
          const cust = await Customer.findById(ticket.customerId).session(session).lean();
          if (cust) {
            customerPhone = cust.phone;
            customerName = cust.name;
          }
        }
      });

      await session.commitTransaction();
      session.endSession();
      break;
    } catch (err) {
      try {
        await session.abortTransaction();
      } catch {
        // preserve original error
      }
      session.endSession();
      if (isTransient(err) && attempts < 3) {
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 50));
        continue;
      }
      throw err;
    }
  }

  // 11. Post-commit notification (non-blocking, customer tickets only, not on reopen)
  if (!isReopen && !updatedTicket.shopOwnedUnit && customerPhone) {
    try {
      const tenantDoc = await runAsPlatform(async () => Tenant.findById(tenantId).select('name').lean());
      const shopName = tenantDoc?.name || 'Cellivo Shop';

      await notificationsService.notify({
        tenantId,
        branchId: updatedTicket.branchId,
        channel: 'sms',
        to: customerPhone,
        template: 'repair_status_changed',
        data: {
          ticket_no: updatedTicket.ticketNo,
          status: to,
          customer_name: customerName,
          shop: shopName,
          public_code: updatedTicket.publicCode,
        },
      });
    } catch {
      // Non-blocking notification failure
    }
  }

  return { ticket: updatedTicket, isReopen };
}

/**
 * Assigns technician to a repair ticket.
 */
export async function assignTechnician({ tenantId, ticketId, technicianId, user }) {
  return await runWithContext({ tenantId }, async () => {
    const ticket = await RepairTicket.findById(ticketId);
    if (!ticket) throw notFound('Repair ticket not found');

    if (technicianId) {
      const tech = await User.findOne({
        _id: technicianId,
        isActive: true,
        branchIds: ticket.branchId,
      }).populate('roleId');
      if (!tech || !hasPermission(tech.roleId, 'repairs.edit')) {
        throw badRequest('Technician must be an active user assigned to this branch with repairs.edit permission', 'INVALID_TECHNICIAN');
      }
      ticket.technicianId = tech._id;
    } else {
      ticket.technicianId = null;
    }

    ticket.history.push({
      from: ticket.stage,
      to: ticket.stage,
      at: new Date(),
      userId: user._id,
      note: technicianId ? `Assigned to technician ${technicianId}` : 'Unassigned technician',
    });

    await ticket.save();
    return ticket;
  });
}

/**
 * Records customer approval or decline for repair estimate.
 */
export async function recordApproval({ tenantId, ticketId, decision, by = 'in_person', user }) {
  if (!['approved', 'declined'].includes(decision)) {
    throw badRequest('Approval decision must be "approved" or "declined"');
  }

  return await runWithContext({ tenantId }, async () => {
    const ticket = await RepairTicket.findById(ticketId);
    if (!ticket) throw notFound('Repair ticket not found');

    if (ticket.shopOwnedUnit) {
      throw badRequest('Customer approval is not applicable to shop-owned repair tickets', 'NOT_APPLICABLE');
    }
    if (ticket.isInvoiceSettled) {
      throw badRequest('Cannot record approval after invoice has been settled', 'INVOICE_SETTLED');
    }
    if (TERMINAL_STAGES.includes(ticket.stage)) {
      throw badRequest(`Cannot record approval when ticket is in terminal stage "${ticket.stage}"`, 'TERMINAL_STAGE');
    }
    if (ticket.approval?.status === 'waived') {
      throw badRequest('Customer estimate approval has already been waived and cannot be overwritten', 'APPROVAL_ALREADY_WAIVED');
    }
    const lockedStages = ['In repair', 'Quality check', 'Ready'];
    if (lockedStages.includes(ticket.stage)) {
      throw badRequest(`Cannot modify approval once ticket has reached "${ticket.stage}" stage`, 'APPROVAL_LOCKED');
    }

    ticket.approval = {
      status: decision,
      at: new Date(),
      by: by || 'in_person',
      recordedBy: user._id,
      waivedBy: null,
      waivedAt: null,
    };

    ticket.history.push({
      from: ticket.stage,
      to: ticket.stage,
      at: new Date(),
      userId: user._id,
      note: `Customer estimate ${decision} (${by})`,
    });

    await ticket.save();
    return ticket;
  });
}

/**
 * Adds a part to the repair ticket and decrements inventory if managed.
 * Retries up to 3 times on TransientTransactionError with a new session for each attempt.
 */
export async function addPart({ tenantId, ticketId, partData, user }) {
  let attempts = 0;
  let updatedTicket = null;

  while (attempts < 3) {
    attempts++;
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      await runWithContext({ tenantId }, async () => {
        const ticket = await RepairTicket.findById(ticketId).session(session);
        if (!ticket) throw notFound('Repair ticket not found');

        if (ticket.isInvoiceSettled) {
          throw badRequest('Cannot add parts after invoice has been settled', 'INVOICE_SETTLED');
        }
        if (TERMINAL_STAGES.includes(ticket.stage)) {
          throw badRequest(`Cannot add parts when ticket is in terminal stage "${ticket.stage}"`, 'TERMINAL_STAGE');
        }
        if (ticket.parts && ticket.parts.length >= 50) {
          throw badRequest('Cannot add more than 50 parts to a repair ticket', 'MAX_PARTS_EXCEEDED');
        }

        // Shop-owned ticket: block part changes once unit is back in stock (Ready or Delivered)
        if (ticket.shopOwnedUnit && ['Ready', 'Delivered'].includes(ticket.stage)) {
          throw badRequest('Cannot add parts once shop-owned unit is back in stock', 'PART_LOCKED');
        }

        const qty = partData.qty !== undefined ? partData.qty : 1;
        if (!Number.isInteger(qty) || qty < 1 || qty > 1000) {
          throw badRequest('Part quantity must be an integer between 1 and 1000', 'INVALID_PART_QTY');
        }
        if (partData.unitCostCents !== undefined && partData.unitCostCents !== null) {
          if (!Number.isInteger(partData.unitCostCents) || partData.unitCostCents < 0 || partData.unitCostCents > 100_000_000) {
            throw badRequest('Part unit cost must be an integer between 0 and 100,000,000 cents', 'INVALID_PART_COST');
          }
        }
        if (partData.unitPriceCents !== undefined && partData.unitPriceCents !== null) {
          if (!Number.isInteger(partData.unitPriceCents) || partData.unitPriceCents < 0 || partData.unitPriceCents > 100_000_000) {
            throw badRequest('Part unit price must be an integer between 0 and 100,000,000 cents', 'INVALID_PART_PRICE');
          }
        }

        const reserved = await reservePart({
          tenantId,
          branchId: ticket.branchId,
          ticketNo: ticket.ticketNo,
          ...partData,
          qty,
          addedBy: user._id,
          session,
        });

        ticket.parts.push(reserved);
        ticket.partsCostCents = ticket.parts.reduce((sum, p) => sum + (p.qty || 1) * (p.unitCostCents || 0), 0);

        await ticket.save({ session });
        updatedTicket = ticket;
      });

      await session.commitTransaction();
      session.endSession();
      break;
    } catch (err) {
      try {
        await session.abortTransaction();
      } catch {
        // preserve original error
      }
      session.endSession();
      if (isTransient(err) && attempts < 3) {
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 50));
        continue;
      }
      throw err;
    }
  }

  return updatedTicket;
}

/**
 * Removes a part from the repair ticket and restores inventory stock if managed.
 * Retries up to 3 times on TransientTransactionError with a new session for each attempt.
 */
export async function removePart({ tenantId, ticketId, partId, user }) {
  let attempts = 0;
  let updatedTicket = null;

  while (attempts < 3) {
    attempts++;
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      await runWithContext({ tenantId }, async () => {
        const ticket = await RepairTicket.findById(ticketId).session(session);
        if (!ticket) throw notFound('Repair ticket not found');

        if (ticket.isInvoiceSettled) {
          throw badRequest('Cannot remove parts after invoice has been settled', 'INVOICE_SETTLED');
        }
        if (TERMINAL_STAGES.includes(ticket.stage)) {
          throw badRequest(`Cannot remove parts when ticket is in terminal stage "${ticket.stage}"`, 'TERMINAL_STAGE');
        }

        // Block removal if COGS has already been posted
        if (ticket.cogsPostedCents > 0) {
          throw badRequest('Cannot remove parts after cost has been recognised', 'COGS_ALREADY_POSTED');
        }

        // Shop-owned ticket: block part changes once unit is back in stock (Ready or Delivered)
        if (ticket.shopOwnedUnit && ['Ready', 'Delivered'].includes(ticket.stage)) {
          throw badRequest('Cannot remove parts once shop-owned unit is back in stock', 'PART_LOCKED');
        }

        const part = ticket.parts.id(partId);
        if (!part) throw notFound('Part not found on ticket');

        await releasePart({
          tenantId,
          branchId: ticket.branchId,
          ticketNo: ticket.ticketNo,
          part,
          userId: user._id,
          session,
        });

        part.deleteOne();
        ticket.partsCostCents = ticket.parts.reduce((sum, p) => sum + (p.qty || 1) * (p.unitCostCents || 0), 0);

        await ticket.save({ session });
        updatedTicket = ticket;
      });

      await session.commitTransaction();
      session.endSession();
      break;
    } catch (err) {
      try {
        await session.abortTransaction();
      } catch {
        // preserve original error
      }
      session.endSession();
      if (isTransient(err) && attempts < 3) {
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 50));
        continue;
      }
      throw err;
    }
  }

  return updatedTicket;
}

/**
 * Settles invoice for a repair ticket (idempotent, balanced double-entry).
 * Posts Dr 5010 / Cr 1050 for delta COGS of inventory-managed parts.
 */
export async function settleInvoice({
  tenantId,
  ticketId,
  paymentMethod = 'cash',
  labourCents = null,
  user,
}) {
  let attempts = 0;
  let updatedTicket = null;

  while (attempts < 3) {
    attempts++;
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      await runWithContext({ tenantId }, async () => {
        const ticket = await RepairTicket.findById(ticketId).session(session);
        if (!ticket) throw notFound('Repair ticket not found');

        if (ticket.shopOwnedUnit) {
          throw badRequest('Shop-owned repair tickets cannot be invoiced to a customer', 'SHOP_OWNED_CANNOT_INVOICE');
        }

        if (ticket.isInvoiceSettled) {
          throw badRequest('Invoice is already settled for this repair ticket', 'ALREADY_INVOICED');
        }

        // Only allowed when ticket stage is 'Ready'
        if (ticket.stage !== 'Ready') {
          throw badRequest(`Cannot settle invoice while ticket is in "${ticket.stage}". Ticket must be in "Ready" stage.`, 'INVOICE_STAGE_INVALID');
        }

        if (paymentMethod && !ALLOWED_PAYMENT_METHODS.includes(paymentMethod)) {
          throw badRequest(`Invalid payment method: ${paymentMethod}`, 'INVALID_PAYMENT_METHOD');
        }

        if (labourCents !== null && labourCents !== undefined) {
          if (!Number.isInteger(labourCents) || labourCents < 0 || labourCents > 100_000_000) {
            throw badRequest('Labour cents must be an integer between 0 and 100000000', 'INVALID_LABOUR');
          }
          ticket.labourCents = labourCents;
        }

        const partsTotal = ticket.parts.reduce(
          (acc, p) => acc + (p.qty || 1) * (p.unitPriceCents || 0),
          0
        );
        const totalCents = ticket.labourCents + partsTotal;

        if (totalCents <= 0) {
          throw badRequest('Total repair amount must be greater than 0 to generate invoice', 'INVALID_INVOICE_TOTAL');
        }

        // Calculate delta COGS for inventory-managed parts
        const invCost = ticket.parts
          .filter((p) => p.inventoryManaged)
          .reduce((sum, p) => sum + (p.qty || 1) * (p.unitCostCents || 0), 0);
        const deltaCogs = Math.max(0, invCost - (ticket.cogsPostedCents || 0));

        // Held advance = ticket.advanceSettled ? 0 : ticket.advanceCents
        const effectiveAdvance = ticket.advanceSettled ? 0 : (ticket.advanceCents || 0);

        // Post journal inside transaction (including COGS if deltaCogs > 0)
        await postRepairInvoice({
          tenantId,
          branchId: ticket.branchId,
          ticketNo: ticket.ticketNo,
          totalCents,
          advanceCents: effectiveAdvance,
          paymentMethod,
          costCents: deltaCogs,
          createdBy: user._id,
          session,
        });

        ticket.isInvoiceSettled = true;
        ticket.invoiceId = ticket.ticketNo;
        ticket.invoiceSettledAt = new Date();
        ticket.invoiceTotalCents = totalCents;
        ticket.advanceSettled = true;
        ticket.cogsPostedCents = (ticket.cogsPostedCents || 0) + deltaCogs;

        ticket.history.push({
          from: ticket.stage,
          to: ticket.stage,
          at: new Date(),
          userId: user._id,
          note: `Invoice settled for total Rs ${(totalCents / 100).toFixed(2)} via ${paymentMethod}`,
        });

        await ticket.save({ session });
        updatedTicket = ticket;
      });

      await session.commitTransaction();
      session.endSession();
      break;
    } catch (err) {
      try {
        await session.abortTransaction();
      } catch {
        // preserve original error
      }
      session.endSession();
      if (isTransient(err) && attempts < 3) {
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 50));
        continue;
      }
      throw err;
    }
  }

  return updatedTicket;
}

/**
 * Searches inventory products for parts addition on a repair ticket.
 * Masks averageCostCents unless caller has view_cost_margin permission.
 */
export async function searchParts({ tenantId, branchId, query, role }) {
  return await runWithContext({ tenantId }, async () => {
    const products = await stockService.searchProducts(tenantId, branchId, query, 50);
    const canViewMargins = hasSpecial(role, 'view_cost_margin');
    return products.map((p) => {
      const item = {
        _id: p._id,
        productId: p._id,
        name: p.name,
        sku: p.sku || null,
        barcode: p.barcode || null,
        sellingPriceCents: p.sellingPriceCents || 0,
        qty: p.qty || 0,
      };
      if (canViewMargins) {
        item.averageCostCents = p.averageCostCents || 0;
      }
      return item;
    });
  });
}

/**
 * Sets warranty period in days and calculates warrantyExpiresAt.
 * Before delivery, stores only warrantyDays.
 * When deliveredAt is present, warrantyExpiresAt = deliveredAt + warrantyDays.
 */
export async function setWarranty({ tenantId, ticketId, days, user }) {
  const warrantyDays = Math.max(0, parseInt(days, 10) || 0);

  return await runWithContext({ tenantId }, async () => {
    const ticket = await RepairTicket.findById(ticketId);
    if (!ticket) throw notFound('Repair ticket not found');

    if (ticket.shopOwnedUnit) {
      return ticket;
    }

    if (ticket.warrantyDays !== warrantyDays) {
      ticket.warrantyAlertSentAt = null;
    }
    ticket.warrantyDays = warrantyDays;
    if (ticket.deliveredAt && warrantyDays > 0) {
      ticket.warrantyExpiresAt = new Date(ticket.deliveredAt.getTime() + warrantyDays * 24 * 60 * 60 * 1000);
    } else {
      ticket.warrantyExpiresAt = null;
    }

    ticket.history.push({
      from: ticket.stage,
      to: ticket.stage,
      at: new Date(),
      userId: user._id,
      note: `Warranty set to ${warrantyDays} days`,
    });

    await ticket.save();
    return ticket;
  });
}

/**
 * Checks for repair tickets whose warranty is expiring soon (within 24 hours).
 * Skips tickets already alerted (warrantyAlertSentAt != null) and shop-owned tickets.
 * Sets warrantyAlertSentAt only after notify() succeeds.
 */
export async function checkWarrantyExpiry(tenantId) {
  return await runWithContext({ tenantId }, async () => {
    const now = new Date();
    const nextDay = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const expiring = await RepairTicket.find({
      warrantyExpiresAt: { $gte: now, $lte: nextDay },
      warrantyAlertSentAt: null,
      shopOwnedUnit: false,
      isArchived: false,
    }).populate('customerId', 'name phone');

    const tenantDoc = await runAsPlatform(async () => Tenant.findById(tenantId).select('name').lean());
    const shopName = tenantDoc?.name || 'Cellivo Shop';

    const results = [];
    for (const t of expiring) {
      if (t.customerId?.phone) {
        try {
          const res = await notificationsService.notify({
            tenantId,
            branchId: t.branchId,
            channel: 'sms',
            to: t.customerId.phone,
            template: 'repair_warranty_expiry',
            data: {
              ticket_no: t.ticketNo,
              customer_name: t.customerId.name,
              due_date: t.warrantyExpiresAt ? t.warrantyExpiresAt.toLocaleDateString() : '',
              shop: shopName,
            },
          });
          t.warrantyAlertSentAt = new Date();
          await t.save();

          results.push({ ticketNo: t.ticketNo, sent: true, logId: res.logId });
        } catch (err) {
          results.push({ ticketNo: t.ticketNo, sent: false, error: err.message });
        }
      }
    }
    return results;
  });
}

/**
 * Returns technicians workload for a branch (only users whose role has repairs.edit).
 */
export async function getTechniciansWorkload({ tenantId, branchId }) {
  return await runWithContext({ tenantId }, async () => {
    const query = { isActive: true };
    if (branchId) {
      query.branchIds = branchId;
    }

    const users = await User.find(query).populate('roleId').select('name email roleId branchIds').lean();
    const eligibleTechs = users.filter((u) => hasPermission(u.roleId, 'repairs.edit'));
    const activeStages = ['Received', 'Diagnosing', 'Waiting approval', 'Waiting parts', 'In repair', 'Quality check', 'Ready'];

    const workloadCounts = await RepairTicket.aggregate([
      {
        $match: {
          stage: { $in: activeStages },
          isArchived: false,
          technicianId: { $ne: null },
          ...(branchId ? { branchId: new mongoose.Types.ObjectId(String(branchId)) } : {}),
        },
      },
      {
        $group: {
          _id: '$technicianId',
          activeCount: { $sum: 1 },
        },
      },
    ]);

    const countMap = new Map(workloadCounts.map((w) => [String(w._id), w.activeCount]));

    return eligibleTechs.map((u) => ({
      _id: u._id,
      name: u.name,
      email: u.email,
      activeTicketsCount: countMap.get(String(u._id)) || 0,
    }));
  });
}

export default {
  ALLOWED_STAGES,
  TERMINAL_STAGES,
  STAGE_TRANSITIONS,
  ALLOWED_PAYMENT_METHODS,
  createTicket,
  updateTicket,
  changeStage,
  assignTechnician,
  recordApproval,
  addPart,
  removePart,
  settleInvoice,
  searchParts,
  setWarranty,
  checkWarrantyExpiry,
  getTechniciansWorkload,
};
