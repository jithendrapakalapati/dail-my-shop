'use strict';

const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function setup() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query(sql);
    console.log('✅  Database schema created successfully');
  } catch (err) {
    console.error('❌  Schema creation failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

setup();
