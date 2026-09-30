import Customer from './Customer.model.js';

// @desc    Get all customers
// @route   GET /api/customers
export const getCustomers = async (req, res, next) => {
  try {
    const { search, type } = req.query;
    const filter = {};

    if (search) {
      // Escape user input so it is matched literally, not as a regex.
      const term = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: { $regex: term, $options: 'i' } },
        { phone: { $regex: term, $options: 'i' } },
        { email: { $regex: term, $options: 'i' } },
        { nic: { $regex: term, $options: 'i' } },
      ];
    }

    if (type && type !== 'all') {
      filter.type = type;
    }

    const customers = await Customer.find(filter).sort({ createdAt: -1 });
    res.status(200).json({
      success: true,
      count: customers.length,
      data: customers,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get customer by ID
// @route   GET /api/customers/:id
export const getCustomerById = async (req, res, next) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found',
      });
    }
    res.status(200).json({
      success: true,
      data: customer,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new customer
// @route   POST /api/customers
export const createCustomer = async (req, res, next) => {
  try {
    const { name, phone, email, address, nic, type, notes } = req.body;

    const customer = await Customer.create({ name, phone, email, address, nic, type, notes });

    res.status(201).json({
      success: true,
      message: 'Customer created successfully',
      data: customer,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update customer
// @route   PUT /api/customers/:id
export const updateCustomer = async (req, res, next) => {
  try {
    const customer = await Customer.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found',
      });
    }

    res.status(200).json({
      success: true,
      message: 'Customer updated successfully',
      data: customer,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete customer
// @route   DELETE /api/customers/:id
export const deleteCustomer = async (req, res, next) => {
  try {
    const customer = await Customer.findByIdAndDelete(req.params.id);

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found',
      });
    }

    res.status(200).json({
      success: true,
      message: 'Customer deleted successfully',
      id: req.params.id,
    });
  } catch (error) {
    next(error);
  }
};
