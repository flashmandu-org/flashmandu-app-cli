#!/usr/bin/env node
// Set this BEFORE any require() — Node checks it when the tls module loads,
// which can happen transitively via commander/ora/etc. imports. A separate
// prelude guarantees the env var is set before any module executes.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
// We set NODE_TLS_REJECT_UNAUTHORIZED=0 deliberately (local dev boxes use
// self-signed certs), so don't nag the user with Node's security warning.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  const text = typeof warning === 'string' ? warning : warning?.message ?? '';
  if (text.includes('NODE_TLS_REJECT_UNAUTHORIZED')) return;
  return emitWarning(warning, ...args);
};
require('../dist/index.js');
