#!/usr/bin/env node
// Set this BEFORE any require() — Node checks it when the tls module loads,
// which can happen transitively via commander/ora/etc. imports. A separate
// prelude guarantees the env var is set before any module executes.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
require('../dist/index.js');
