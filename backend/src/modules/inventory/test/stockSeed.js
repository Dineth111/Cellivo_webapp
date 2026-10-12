import Product from '../models/Product.model.js';
import StockLevel from '../models/StockLevel.model.js';
import SerialUnit from '../models/SerialUnit.model.js';

/**
 * Test helper to seed products, stock levels, and serial units in one call.
 */
export async function seedStock(items, session = null) {
  const list = Array.isArray(items) ? items : [items];
  const results = [];

  for (const item of list) {
    let product = await Product.findOne({ barcode: item.barcode }).session(session);
    const isSerialised = !!(item.isSerialised || (item.imeiList && item.imeiList.length));

    if (!product) {
      const created = await Product.create(
        [
          {
            name: item.name || `Product ${item.barcode}`,
            barcode: item.barcode,
            sku: item.sku || '',
            categoryId: item.categoryId || null,
            brandId: item.brandId || null,
            modelId: item.modelId || null,
            sellingPriceCents: item.sellingPriceCents ?? 1000,
            wholesalePriceCents: item.wholesalePriceCents ?? 0,
            costPriceCents: item.costPriceCents ?? 0,
            isSerialised,
            reorderLevel: item.reorderLevel ?? 0,
          },
        ],
        { session }
      );
      product = created[0];
    }

    let stockLevel = null;
    if (item.branchId) {
      const qty = item.qty !== undefined ? item.qty : (item.imeiList ? item.imeiList.length : 0);
      stockLevel = await StockLevel.findOneAndUpdate(
        { productId: product._id, branchId: item.branchId },
        {
          $set: {
            qty,
            averageCostCents: item.costPriceCents ?? product.costPriceCents ?? 0,
          },
        },
        { session, upsert: true, new: true }
      );
    }

    const createdImeis = [];
    if (item.imeiList && item.branchId) {
      for (const imeiEntry of item.imeiList) {
        const imeiStr = typeof imeiEntry === 'string' ? imeiEntry : imeiEntry.imei;
        const status = typeof imeiEntry === 'object' && imeiEntry.status ? imeiEntry.status : 'in_stock';
        const reservedUntil = typeof imeiEntry === 'object' ? imeiEntry.reservedUntil : null;
        const cartId = typeof imeiEntry === 'object' ? imeiEntry.cartId : null;

        let unit = await SerialUnit.findOne({ imei1: imeiStr }).session(session);
        if (!unit) {
          const createdUnits = await SerialUnit.create(
            [
              {
                imei1: imeiStr,
                productId: product._id,
                branchId: item.branchId,
                unitCostCents: item.costPriceCents ?? product.costPriceCents ?? 0,
                status,
                reservation: {
                  cartId,
                  reservedUntil,
                },
              },
            ],
            { session }
          );
          unit = createdUnits[0];
        } else {
          unit.status = status;
          unit.reservation = { cartId, reservedUntil };
          await unit.save({ session });
        }
        createdImeis.push(unit);
      }
    }

    results.push({
      product,
      stockLevel,
      serialUnits: createdImeis,
      // Compatibility helper properties matching FakeStock shape in tests
      _id: product._id,
      name: product.name,
      barcode: product.barcode,
      sellingPriceCents: product.sellingPriceCents,
      costPriceCents: product.costPriceCents,
      qty: stockLevel ? stockLevel.qty : 0,
      imeiList: createdImeis.map((u) => ({
        imei: u.imei1,
        status: u.status,
        reservedUntil: u.reservation?.reservedUntil,
      })),
    });
  }

  return Array.isArray(items) ? results : results[0];
}

export default { seedStock };
