#!/usr/bin/env node

import { start } from './dist/api/server.js';

start().catch((error) => {
  console.error('Error iniciando API:', error);
  process.exit(1);
});
