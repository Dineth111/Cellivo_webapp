/**
 * Default notification templates across channels (SMS, Email, In-app).
 * Supports English, Sinhala, and Tamil default texts with merge fields.
 * Uses {customer_name} as standard customer name merge field.
 */

export const DEFAULT_TEMPLATES = {
  sale_completed: {
    event: 'sale_completed',
    channels: {
      sms: {
        body: 'Thank you for your purchase from {shop}! Invoice: {invoice_no}, Amount: {amount}. {link}',
      },
      email: {
        subject: 'Receipt for Invoice {invoice_no} - {shop}',
        body: 'Dear {customer_name},\n\nThank you for shopping at {shop}.\nInvoice: {invoice_no}\nTotal Amount: {amount}\nDate: {due_date}\n\nView and download your digital receipt here:\n{link}\n\nWe appreciate your business!',
      },
    },
  },
  repair_created: {
    event: 'repair_created',
    channels: {
      sms: {
        body: 'Hi {customer_name}, your repair ticket #{ticket_no} has been received at {shop}. Track live status: {link}',
      },
      email: {
        subject: 'Repair Ticket #{ticket_no} Created - {shop}',
        body: 'Dear {customer_name},\n\nYour device repair ticket #{ticket_no} has been created at {shop}.\nReported faults: {status}\n\nTrack your repair progress anytime at:\n{link}',
      },
    },
  },
  repair_status_changed: {
    event: 'repair_status_changed',
    channels: {
      sms: {
        body: 'Hi {customer_name}, your repair #{ticket_no} status is now: {status}. - {shop}',
      },
      email: {
        subject: 'Repair #{ticket_no} Status Update - {shop}',
        body: 'Dear {customer_name},\n\nYour repair job #{ticket_no} at {shop} has been updated to: {status}.\nCheck full details here: {link}\n\nThank you for choosing {shop}.',
      },
    },
  },
  repair_overdue: {
    event: 'repair_overdue',
    channels: {
      in_app: {
        subject: 'Repair Overdue',
        body: 'Repair ticket #{ticket_no} for customer {customer_name} has passed the promised date.',
      },
    },
  },
  installment_due: {
    event: 'installment_due',
    channels: {
      sms: {
        body: 'Dear {customer_name}, your installment payment of {amount} is due on {due_date}. - {shop}',
      },
    },
  },
  installment_overdue: {
    event: 'installment_overdue',
    channels: {
      sms: {
        body: 'Dear {customer_name}, your installment payment of {amount} was due on {due_date} and remains overdue. Please settle promptly. - {shop}',
      },
    },
  },
  loyalty_points_expiring: {
    event: 'loyalty_points_expiring',
    channels: {
      sms: {
        body: 'Dear {customer_name}, your loyalty points at {shop} will expire soon. Visit us to redeem your savings!',
      },
    },
  },
  low_stock: {
    event: 'low_stock',
    channels: {
      in_app: {
        subject: 'Low Stock Alert',
        body: 'Item {item_name} has fallen to {quantity} units, at or below the reorder level.',
      },
      email: {
        subject: 'Low Stock Alert: {item_name} - {shop}',
        body: 'Attention Manager,\n\nThe stock for {item_name} at {shop} has dropped to {quantity} units, reaching the configured reorder threshold. Please place a purchase order soon.',
      },
    },
  },
  cheque_maturing: {
    event: 'cheque_maturing',
    channels: {
      in_app: {
        subject: 'Cheque Maturing',
        body: 'Cheque #{cheque_no} ({bank_name}) for {amount} matures on {due_date}.',
      },
    },
  },
  approval_request: {
    event: 'approval_request',
    channels: {
      in_app: {
        subject: 'Approval Required',
        body: '{requester_name} requested approval for {reason}: {details}.',
      },
    },
  },
  failed_login_lock: {
    event: 'failed_login_lock',
    channels: {
      email: {
        subject: 'Security Alert: Account Locked - {shop}',
        body: 'Security Notice: The user account for {customer_name} ({email}) was locked for 15 minutes after 5 consecutive failed login attempts.',
      },
    },
  },
  trial_ending: {
    event: 'trial_ending',
    channels: {
      email: {
        subject: 'Your Cellivo Free Trial Ends Soon - {shop}',
        body: 'Hello {customer_name},\n\nYour Cellivo free trial for {shop} will end on {due_date}. Subscribe to continue without interruption.\n{link}',
      },
      in_app: {
        subject: 'Free Trial Ending',
        body: 'Your free trial ends on {due_date}. Upgrade in Settings > Subscription to keep using all features.',
      },
    },
  },
  payment_failed: {
    event: 'payment_failed',
    channels: {
      email: {
        subject: 'Subscription Payment Failed - {shop}',
        body: 'Hello {customer_name},\n\nWe were unable to charge your payment method for your {shop} subscription. Please update your billing details:\n{link}',
      },
      in_app: {
        subject: 'Payment Failed',
        body: 'Your recent subscription payment failed. Please check your billing settings.',
      },
    },
  },
  suspended: {
    event: 'suspended',
    channels: {
      email: {
        subject: 'Cellivo Account Suspended - {shop}',
        body: 'Hello {customer_name},\n\nYour shop account for {shop} has been suspended due to overdue subscription payments. Please settle your invoice to restore access:\n{link}',
      },
      in_app: {
        subject: 'Shop Suspended',
        body: 'Your shop subscription is suspended. Access is restricted to billing until paid.',
      },
    },
  },
  supplier_payment_reminder: {
    event: 'supplier_payment_reminder',
    channels: {
      in_app: {
        subject: 'Supplier Payment Due',
        body: 'Payment of {amount} to supplier {supplier_name} is due on {due_date}.',
      },
      email: {
        subject: 'Supplier Payment Reminder: {supplier_name} - {shop}',
        body: 'Reminder: A supplier payment of {amount} to {supplier_name} is due on {due_date}.',
      },
    },
  },
  repair_warranty_expiry: {
    event: 'repair_warranty_expiry',
    channels: {
      sms: {
        body: 'Dear {customer_name}, the repair warranty for ticket #{ticket_no} at {shop} will expire on {due_date}. Contact us if you experience any issues.',
      },
      in_app: {
        subject: 'Repair Warranty Expiring',
        body: 'Warranty for repair #{ticket_no} ({customer_name}) expires on {due_date}.',
      },
    },
  },
  // Platform events (templates only)
  new_lead: {
    event: 'new_lead',
    channels: {
      email: {
        subject: 'New Lead: {lead_name}',
        body: 'A new lead was submitted by {lead_name} ({email}, {phone}):\n\n{details}',
      },
    },
  },
  demo_booking: {
    event: 'demo_booking',
    channels: {
      email: {
        subject: 'Demo Booking: {lead_name}',
        body: 'A demo was requested by {lead_name} ({email}, {phone}) for {due_date}:\n\n{details}',
      },
    },
  },
  system_threshold_breach: {
    event: 'system_threshold_breach',
    channels: {
      email: {
        subject: 'System Alert: {reason}',
        body: 'System threshold breach detected: {reason}\nDetails: {details}',
      },
    },
  },
  // System transactional emails
  password_reset: {
    event: 'password_reset',
    channels: {
      email: {
        subject: 'Reset Your Password - {shop}',
        body: 'Hello {customer_name},\n\nWe received a request to reset your password. Click the link below to set a new password:\n{link}\n\nThis link is valid for 30 minutes and can be used only once.',
      },
    },
  },
  signup_verification: {
    event: 'signup_verification',
    channels: {
      email: {
        subject: 'Your Cellivo Verification Code: {code}',
        body: 'Welcome to Cellivo!\n\nYour 6-digit verification code is: {code}\n\nThis code will expire in 15 minutes.',
      },
    },
  },
  staff_invite: {
    event: 'staff_invite',
    channels: {
      email: {
        subject: 'You have been invited to join {shop} on Cellivo',
        body: 'Hello {customer_name},\n\nYou have been invited to join {shop} on Cellivo. Click the link below to set your password and access your account:\n{link}\n\nThis link is valid for 48 hours.',
      },
    },
  },
};

export default DEFAULT_TEMPLATES;
