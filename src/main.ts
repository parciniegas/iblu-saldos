#!/usr/bin/env node

import { start } from './api/server.js';

try {
  await start();
} catch (error) {
  console.error('Error iniciando API:', error);
  process.exit(1);
}