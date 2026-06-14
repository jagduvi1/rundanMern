#!/usr/bin/env node
// Standalone question-library seed script — the `npm run seed` target.
//
// Connects to Mongo, runs the idempotent library seeder (a no-op if the
// QuestionTemplate collection is already populated), then disconnects and exits.
// Safe to run repeatedly. Usage:  npm run seed   (or:  node scripts/seedLibrary.js)

require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const librarySeeder = require('../src/services/librarySeeder');

async function main() {
  await connectDB();

  try {
    const seeded = await librarySeeder.seedIfEmpty();
    if (seeded) {
      console.log('Question library seeded.');
    } else {
      console.log('Question library already present (or JSON empty/missing) — nothing to do.');
    }
  } finally {
    // Always close the connection so the process can exit cleanly.
    await mongoose.disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Library seed failed:', err);
    // Best-effort disconnect on error too.
    mongoose.disconnect().finally(() => process.exit(1));
  });
