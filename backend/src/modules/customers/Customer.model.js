import mongoose from 'mongoose';

// SRS CRM-01
const customerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Customer name is required'],
      trim: true,
    },
    phone: {
      type: String,
      required: [true, 'Phone number is required'],
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: '',
    },
    address: {
      type: String,
      trim: true,
      default: '',
    },
    nic: {
      type: String,
      trim: true,
      default: '',
    },
    type: {
      type: String,
      enum: ['retail', 'wholesale'],
      default: 'retail',
    },
    notes: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

const Customer = mongoose.models.Customer || mongoose.model('Customer', customerSchema);

export default Customer;
