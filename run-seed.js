import { seed } from './seed.js';
import { driverName } from '../db/index.js';

const force = process.argv.includes('--force');

seed({ force })
  .then((result) => {
    if (!result.seeded) {
      console.log(`[seed] skipped — ${result.reason}`);
    } else {
      console.log(`[seed] demo data loaded into ${driverName}:`);
      for (const [k, v] of Object.entries(result)) {
        if (k !== 'seeded') console.log(`        ${k.padEnd(16)} ${v}`);
      }
      console.log('\n  Demo logins (Staff ID / password / role):');
      console.log('    DR001 / doctor123    / Doctor');
      console.log('    NR001 / nurse123     / Nurse');
      console.log('    PH001 / pharm123     / Pharmacist');
      console.log('    AD001 / admin123     / Admin');
      console.log('    BC001 / billing123   / BillingClerk');
      console.log('    LT001 / labtech123   / LabTech\n');
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error('[seed] failed:', err);
    process.exit(1);
  });