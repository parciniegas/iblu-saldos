#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../src/api/config.js';

const configPath = resolve('config.json');

let config: AppConfig;

try {
  const raw = readFileSync(configPath, 'utf-8');
  config = JSON.parse(raw);
} catch {
  config = {
    connectionString: { mariaDb: '' },
    apiKeys: { allowedKeys: [] },
    procesamientoMovimientos: { fechaDesdeDefault: '2000-01-01', batchSizeDefault: 1000 },
    logging: { level: 'info', filePath: 'logs/saldos-api-.json', rollingInterval: 'day' },
    server: { port: 3000, host: '0.0.0.0' },
  };
}

const apiKey = randomBytes(32).toString('hex');

if (!config.apiKeys) {
  config.apiKeys = { allowedKeys: [] };
}

if (!Array.isArray(config.apiKeys.allowedKeys)) {
  config.apiKeys.allowedKeys = [];
}

config.apiKeys.allowedKeys.push(apiKey);

writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

console.log(`\n✅ API Key generada y escrita en config.json:`);
console.log(`   ${apiKey}`);
console.log(`\nTotal de API keys configuradas: ${config.apiKeys.allowedKeys.length}`);
console.log(`\nPara usarla, agrega el header:`);
console.log(`   X-API-Key: ${apiKey}`);
