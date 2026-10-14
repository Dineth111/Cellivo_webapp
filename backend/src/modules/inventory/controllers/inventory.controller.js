import mongoose from 'mongoose';
import Category from '../models/Category.model.js';
import Brand from '../models/Brand.model.js';
import ProductModel from '../models/ProductModel.model.js';
import Product from '../models/Product.model.js';
import StockLevel from '../models/StockLevel.model.js';
import StockMovement from '../models/StockMovement.model.js';
import { str, pick, requireId, escapeRegex, pageParams } from '../../../core/validate.js';
import { badRequest, notFound } from '../../../core/errors.js';
import { record as recordAudit } from '../../../core/audit.js';
import { maskCost } from '../utils/maskCost.js';
import { resolveBranch } from '../../pos/utils/branch.js';

// ==========================================
// CATEGORIES
// ==========================================

export async function listCategories(req, res) {
  const categories = await Category.find({ isArchived: false }).sort({ name: 1 }).lean();
  res.json({ success: true, data: categories });
}

export async function createCategory(req, res) {
  const name = str(req.body.name);
  if (!name) throw badRequest('Category name is required');
  const description = str(req.body.description) || '';

  const exists = await Category.findOne({ name, isArchived: false });
  if (exists) throw badRequest('Category with this name already exists');

  const category = await Category.create({ name, description });
  res.status(201).json({ success: true, data: category });
}

export async function getCategory(req, res) {
  const id = requireId(req.params.id);
  const category = await Category.findOne({ _id: id, isArchived: false }).lean();
  if (!category) throw notFound('Category not found');
  res.json({ success: true, data: category });
}

export async function updateCategory(req, res) {
  const id = requireId(req.params.id);
  const category = await Category.findOne({ _id: id, isArchived: false });
  if (!category) throw notFound('Category not found');

  const name = str(req.body.name);
  if (name && name !== category.name) {
    const duplicate = await Category.findOne({ name, _id: { $ne: id }, isArchived: false });
    if (duplicate) throw badRequest('Category with this name already exists');
    category.name = name;
  }
  if (req.body.description !== undefined) {
    category.description = str(req.body.description) || '';
  }

  await category.save();
  res.json({ success: true, data: category });
}

export async function archiveCategory(req, res) {
  const id = requireId(req.params.id);
  const category = await Category.findOne({ _id: id, isArchived: false });
  if (!category) throw notFound('Category not found');

  category.isArchived = true;
  await category.save();
  res.json({ success: true, message: 'Category archived successfully' });
}

// ==========================================
// BRANDS
// ==========================================

export async function listBrands(req, res) {
  const brands = await Brand.find({ isArchived: false }).sort({ name: 1 }).lean();
  res.json({ success: true, data: brands });
}

export async function createBrand(req, res) {
  const name = str(req.body.name);
  if (!name) throw badRequest('Brand name is required');
  const description = str(req.body.description) || '';

  const exists = await Brand.findOne({ name, isArchived: false });
  if (exists) throw badRequest('Brand with this name already exists');

  const brand = await Brand.create({ name, description });
  res.status(201).json({ success: true, data: brand });
}

export async function getBrand(req, res) {
  const id = requireId(req.params.id);
  const brand = await Brand.findOne({ _id: id, isArchived: false }).lean();
  if (!brand) throw notFound('Brand not found');
  res.json({ success: true, data: brand });
}

export async function updateBrand(req, res) {
  const id = requireId(req.params.id);
  const brand = await Brand.findOne({ _id: id, isArchived: false });
  if (!brand) throw notFound('Brand not found');

  const name = str(req.body.name);
  if (name && name !== brand.name) {
    const duplicate = await Brand.findOne({ name, _id: { $ne: id }, isArchived: false });
    if (duplicate) throw badRequest('Brand with this name already exists');
    brand.name = name;
  }
  if (req.body.description !== undefined) {
    brand.description = str(req.body.description) || '';
  }

  await brand.save();
  res.json({ success: true, data: brand });
}

export async function archiveBrand(req, res) {
  const id = requireId(req.params.id);
  const brand = await Brand.findOne({ _id: id, isArchived: false });
  if (!brand) throw notFound('Brand not found');

  brand.isArchived = true;
  await brand.save();
  res.json({ success: true, message: 'Brand archived successfully' });
}

// ==========================================
// PRODUCT MODELS
// ==========================================

export async function listModels(req, res) {
  const filter = { isArchived: false };
  if (req.query.brandId) {
    filter.brandId = requireId(req.query.brandId);
  }
  const models = await ProductModel.find(filter).populate('brandId', 'name').sort({ name: 1 }).lean();
  res.json({ success: true, data: models });
}

export async function createModel(req, res) {
  const brandId = requireId(req.body.brandId, 'brandId');
  const name = str(req.body.name);
  if (!name) throw badRequest('Model name is required');
  const description = str(req.body.description) || '';

  const brand = await Brand.findOne({ _id: brandId, isArchived: false });
  if (!brand) throw badRequest('Brand not found');

  const exists = await ProductModel.findOne({ brandId, name, isArchived: false });
  if (exists) throw badRequest('Model with this name already exists under this brand');

  const model = await ProductModel.create({ brandId, name, description });
  res.status(201).json({ success: true, data: model });
}

export async function getModel(req, res) {
  const id = requireId(req.params.id);
  const model = await ProductModel.findOne({ _id: id, isArchived: false }).populate('brandId', 'name').lean();
  if (!model) throw notFound('Product model not found');
  res.json({ success: true, data: model });
}

export async function updateModel(req, res) {
  const id = requireId(req.params.id);
  const model = await ProductModel.findOne({ _id: id, isArchived: false });
  if (!model) throw notFound('Product model not found');

  const name = str(req.body.name);
  const brandId = req.body.brandId ? requireId(req.body.brandId, 'brandId') : model.brandId;

  if (name && (name !== model.name || String(brandId) !== String(model.brandId))) {
    const duplicate = await ProductModel.findOne({ brandId, name, _id: { $ne: id }, isArchived: false });
    if (duplicate) throw badRequest('Model with this name already exists under this brand');
    model.name = name;
  }
  if (brandId) {
    const brand = await Brand.findOne({ _id: brandId, isArchived: false });
    if (!brand) throw badRequest('Brand not found');
    model.brandId = brandId;
  }
  if (req.body.description !== undefined) {
    model.description = str(req.body.description) || '';
  }

  await model.save();
  res.json({ success: true, data: model });
}

export async function archiveModel(req, res) {
  const id = requireId(req.params.id);
  const model = await ProductModel.findOne({ _id: id, isArchived: false });
  if (!model) throw notFound('Product model not found');

  model.isArchived = true;
  await model.save();
  res.json({ success: true, message: 'Product model archived successfully' });
}

// ==========================================
// PRODUCTS
// ==========================================

export async function listProducts(req, res) {
  const { page, limit, skip } = pageParams(req.query, 100);
  const branch = await resolveBranch(req, { allowAll: true });

  const filter = { isArchived: false };
  if (req.query.categoryId) filter.categoryId = requireId(req.query.categoryId);
  if (req.query.brandId) filter.brandId = requireId(req.query.brandId);
  if (req.query.modelId) filter.modelId = requireId(req.query.modelId);
  if (req.query.isSerialised !== undefined) filter.isSerialised = req.query.isSerialised === 'true';

  if (req.query.search) {
    const search = String(req.query.search).trim();
    if (search.length > 100) throw badRequest('Search text is too long (max 100 characters)');
    const reg = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: reg }, { barcode: reg }, { sku: reg }];
  }

  const [total, rawProducts] = await Promise.all([
    Product.countDocuments(filter),
    Product.find(filter)
      .populate('categoryId', 'name')
      .populate('brandId', 'name')
      .populate('modelId', 'name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  const productIds = rawProducts.map((p) => p._id);
  const stockLevelFilter = { productId: { $in: productIds } };
  if (branch) stockLevelFilter.branchId = branch._id;

  const stockLevels = await StockLevel.find(stockLevelFilter).lean();
  const stockMap = new Map();
  stockLevels.forEach((sl) => {
    const pid = String(sl.productId);
    if (!stockMap.has(pid)) stockMap.set(pid, []);
    stockMap.get(pid).push(sl);
  });

  const products = rawProducts.map((p) => {
    const sls = stockMap.get(String(p._id)) || [];
    const totalQty = sls.reduce((sum, s) => sum + s.qty, 0);
    const branchStock = branch ? sls.find((s) => String(s.branchId) === String(branch._id)) : null;
    return {
      ...p,
      qty: branch ? (branchStock ? branchStock.qty : 0) : totalQty,
      stockLevels: sls,
    };
  });

  res.json({
    success: true,
    total,
    page,
    limit,
    data: maskCost(products, req.auth.role),
  });
}

export async function createProduct(req, res) {
  const fields = pick(req.body, [
    'name',
    'sku',
    'barcode',
    'categoryId',
    'brandId',
    'modelId',
    'description',
    'isSerialised',
    'variantAttributes',
    'sellingPriceCents',
    'wholesalePriceCents',
    'costPriceCents',
    'taxRatePercent',
    'reorderLevel',
  ]);

  const name = str(fields.name);
  if (!name) throw badRequest('Product name is required');
  const barcode = str(fields.barcode);
  if (!barcode) throw badRequest('Barcode is required');

  const sellingPriceCents = Number(fields.sellingPriceCents);
  if (sellingPriceCents == null || isNaN(sellingPriceCents) || sellingPriceCents < 0) {
    throw badRequest('Selling price in cents is required');
  }

  const existingBarcode = await Product.findOne({ barcode, isArchived: false });
  if (existingBarcode) throw badRequest('A product with this barcode already exists');

  if (fields.sku) {
    const existingSku = await Product.findOne({ sku: str(fields.sku), isArchived: false });
    if (existingSku) throw badRequest('A product with this SKU already exists');
  }

  const product = await Product.create({
    name,
    sku: str(fields.sku) || '',
    barcode,
    categoryId: fields.categoryId ? requireId(fields.categoryId) : null,
    brandId: fields.brandId ? requireId(fields.brandId) : null,
    modelId: fields.modelId ? requireId(fields.modelId) : null,
    description: str(fields.description) || '',
    isSerialised: !!fields.isSerialised,
    variantAttributes: fields.variantAttributes || {},
    sellingPriceCents,
    wholesalePriceCents: Number(fields.wholesalePriceCents) || 0,
    costPriceCents: Number(fields.costPriceCents) || 0,
    taxRatePercent: Number(fields.taxRatePercent) || 0,
    reorderLevel: Number(fields.reorderLevel) || 0,
  });

  await recordAudit({
    action: 'inventory.product_created',
    entity: 'Product',
    entityId: product._id,
    after: product.toObject(),
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
  });

  res.status(201).json({ success: true, data: maskCost(product, req.auth.role) });
}

export async function getProduct(req, res) {
  const id = requireId(req.params.id);
  const product = await Product.findOne({ _id: id, isArchived: false })
    .populate('categoryId', 'name')
    .populate('brandId', 'name')
    .populate('modelId', 'name')
    .lean();

  if (!product) throw notFound('Product not found');

  const stockLevels = await StockLevel.find({ productId: id }).populate('branchId', 'name').lean();
  const totalQty = stockLevels.reduce((sum, s) => sum + s.qty, 0);

  const result = {
    ...product,
    qty: totalQty,
    stockLevels,
  };

  res.json({ success: true, data: maskCost(result, req.auth.role) });
}

export async function updateProduct(req, res) {
  const id = requireId(req.params.id);
  const product = await Product.findOne({ _id: id, isArchived: false });
  if (!product) throw notFound('Product not found');

  const before = product.toObject();
  const allowed = [
    'name',
    'sku',
    'barcode',
    'categoryId',
    'brandId',
    'modelId',
    'description',
    'isSerialised',
    'variantAttributes',
    'sellingPriceCents',
    'wholesalePriceCents',
    'costPriceCents',
    'taxRatePercent',
    'reorderLevel',
  ];

  const updates = pick(req.body, allowed);

  if (updates.barcode && updates.barcode !== product.barcode) {
    const duplicate = await Product.findOne({ barcode: str(updates.barcode), _id: { $ne: id }, isArchived: false });
    if (duplicate) throw badRequest('A product with this barcode already exists');
    product.barcode = str(updates.barcode);
  }

  if (updates.sku !== undefined && str(updates.sku) !== product.sku) {
    const newSku = str(updates.sku) || '';
    if (newSku) {
      const duplicate = await Product.findOne({ sku: newSku, _id: { $ne: id }, isArchived: false });
      if (duplicate) throw badRequest('A product with this SKU already exists');
    }
    product.sku = newSku;
  }

  if (updates.name) product.name = str(updates.name);
  if (updates.categoryId !== undefined) product.categoryId = updates.categoryId ? requireId(updates.categoryId) : null;
  if (updates.brandId !== undefined) product.brandId = updates.brandId ? requireId(updates.brandId) : null;
  if (updates.modelId !== undefined) product.modelId = updates.modelId ? requireId(updates.modelId) : null;
  if (updates.description !== undefined) product.description = str(updates.description) || '';
  if (updates.isSerialised !== undefined) product.isSerialised = !!updates.isSerialised;
  if (updates.variantAttributes !== undefined) product.variantAttributes = updates.variantAttributes;
  if (updates.sellingPriceCents !== undefined) product.sellingPriceCents = Number(updates.sellingPriceCents);
  if (updates.wholesalePriceCents !== undefined) product.wholesalePriceCents = Number(updates.wholesalePriceCents);
  if (updates.costPriceCents !== undefined) product.costPriceCents = Number(updates.costPriceCents);
  if (updates.taxRatePercent !== undefined) product.taxRatePercent = Number(updates.taxRatePercent);
  if (updates.reorderLevel !== undefined) product.reorderLevel = Number(updates.reorderLevel);

  await product.save();

  // Audit price or cost changes
  if (before.sellingPriceCents !== product.sellingPriceCents || before.costPriceCents !== product.costPriceCents) {
    await recordAudit({
      action: 'inventory.price_changed',
      entity: 'Product',
      entityId: product._id,
      before: { sellingPriceCents: before.sellingPriceCents, costPriceCents: before.costPriceCents },
      after: { sellingPriceCents: product.sellingPriceCents, costPriceCents: product.costPriceCents },
      tenantId: req.auth.tenantId,
      userId: req.auth.userId,
    });
  }

  res.json({ success: true, data: maskCost(product, req.auth.role) });
}

export async function archiveProduct(req, res) {
  const id = requireId(req.params.id);
  const product = await Product.findOne({ _id: id, isArchived: false });
  if (!product) throw notFound('Product not found');

  product.isArchived = true;
  await product.save();

  await recordAudit({
    action: 'inventory.product_archived',
    entity: 'Product',
    entityId: product._id,
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
  });

  res.json({ success: true, message: 'Product archived successfully' });
}

// ==========================================
// STOCK LEVELS & MOVEMENTS
// ==========================================

export async function listStockLevels(req, res) {
  const branch = await resolveBranch(req, { allowAll: true });
  const filter = {};
  if (branch) filter.branchId = branch._id;
  if (req.query.productId) filter.productId = requireId(req.query.productId);

  const levels = await StockLevel.find(filter)
    .populate('productId', 'name barcode sku reorderLevel isSerialised sellingPriceCents')
    .populate('branchId', 'name')
    .lean();

  res.json({ success: true, data: maskCost(levels, req.auth.role) });
}

export async function listMovements(req, res) {
  const { page, limit, skip } = pageParams(req.query, 100);
  const branch = await resolveBranch(req, { allowAll: true });

  const filter = {};
  if (branch) filter.branchId = branch._id;
  if (req.query.productId) filter.productId = requireId(req.query.productId);
  if (req.query.type) filter.type = str(req.query.type);

  const [total, movements] = await Promise.all([
    StockMovement.countDocuments(filter),
    StockMovement.find(filter)
      .populate('productId', 'name barcode')
      .populate('branchId', 'name')
      .populate('userId', 'name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  res.json({
    success: true,
    total,
    page,
    limit,
    data: maskCost(movements, req.auth.role),
  });
}

export default {
  listCategories,
  createCategory,
  getCategory,
  updateCategory,
  archiveCategory,
  listBrands,
  createBrand,
  getBrand,
  updateBrand,
  archiveBrand,
  listModels,
  createModel,
  getModel,
  updateModel,
  archiveModel,
  listProducts,
  createProduct,
  getProduct,
  updateProduct,
  archiveProduct,
  listStockLevels,
  listMovements,
};
