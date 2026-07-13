#!/usr/bin/env node

import { start } from '../api/server.js';

start().catch((error: unknown) => {
  console.error('Error iniciando CLI:', error);
  process.exit(1);
});
