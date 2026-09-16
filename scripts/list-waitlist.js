/** Print waitlist entries from local JSON DB (operator tool; not a public route). */
import * as db from '../src/db.js';

const rows = db.listWaitlist();
console.log(JSON.stringify({ count: rows.length, waitlist: rows }, null, 2));
