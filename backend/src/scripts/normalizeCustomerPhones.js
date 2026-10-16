import connectDB from '../core/db.js';
import Customer from '../modules/customers/Customer.model.js';
import { normalizePhone } from '../modules/customers/utils/phone.js';
import { runAsPlatform } from '../core/tenantContext.js';

/**
 * One-off script to normalise legacy customer phone numbers to E.164.
 * Dry-run by default. Pass --apply to persist changes to the database.
 *
 * Usage:
 *   npm run normalize-phones           # Dry-run
 *   npm run normalize-phones -- --apply # Apply changes
 */
async function run() {
  const isDryRun = !process.argv.includes('--apply');

  console.log(`=== Customer Phone Normalisation Script ===`);
  console.log(`Mode: ${isDryRun ? 'DRY-RUN (no changes will be written)' : 'APPLY (changes will be committed)'}\n`);

  await connectDB();

  await runAsPlatform(async () => {
    const customers = await Customer.find({}).lean();
    let scanned = customers.length;
    let needsUpdate = 0;
    let updated = 0;
    let conflicts = 0;

    for (const c of customers) {
      const current = c.phone;
      const normalized = normalizePhone(current);

      if (!normalized || normalized === current) {
        continue;
      }

      needsUpdate++;

      // Check if target phone already exists for another customer in this tenant
      const conflict = await Customer.findOne({
        tenantId: c.tenantId,
        phone: normalized,
        _id: { $ne: c._id },
      }).lean();

      if (conflict) {
        conflicts++;
        console.warn(
          `[CONFLICT] Tenant: ${c.tenantId} Customer "${c.name}" (${c._id}) phone "${current}" -> "${normalized}" conflicts with existing Customer "${conflict.name}" (${conflict._id}). Skipped.`
        );
        continue;
      }

      if (isDryRun) {
        console.log(
          `[WOULD UPDATE] Tenant: ${c.tenantId} Customer "${c.name}" (${c._id}): "${current}" -> "${normalized}"`
        );
        updated++;
      } else {
        await Customer.collection.updateOne({ _id: c._id }, { $set: { phone: normalized } });
        console.log(
          `[UPDATED] Tenant: ${c.tenantId} Customer "${c.name}" (${c._id}): "${current}" -> "${normalized}"`
        );
        updated++;
      }
    }

    console.log(`\n=== Summary ===`);
    console.log(`Total scanned:           ${scanned}`);
    console.log(`Needed normalisation:    ${needsUpdate}`);
    console.log(`${isDryRun ? 'Would normalise:       ' : 'Normalised:            '}  ${updated}`);
    console.log(`Conflicts (skipped):     ${conflicts}`);

    if (isDryRun) {
      console.log(`\nDry-run complete. Run with --apply to commit changes.`);
    } else {
      console.log(`\nSuccessfully applied normalisation.`);
    }
  });

  process.exit(0);
}

run().catch((err) => {
  console.error('Normalisation script failed:', err);
  process.exit(1);
});
