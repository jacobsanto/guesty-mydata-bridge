'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('production Compose forwards every runtime identity and separate policy approval credential', () => {
  const compose = fs.readFileSync(path.join(root, 'compose.yaml'), 'utf8');
  for (const name of [
    'ADMIN_API_TOKEN', 'POLICY_ACCOUNTING_APPROVER_TOKEN', 'POLICY_ACCOUNTING_ACTOR',
    'POLICY_TECHNICAL_APPROVER_TOKEN', 'POLICY_TECHNICAL_ACTOR', 'GUESTY_ACCOUNT_ID',
    'DATA_ENCRYPTION_KEY', 'DB_POOL_MAX', 'DAILY_CLOSE_LEASE_SECONDS',
  ]) assert.match(compose, new RegExp(`\\b${name}:`), `${name} must reach the app container`);
});

test('host backup, restore drill and monitor scripts remain shell-valid and monitor units exist', () => {
  const scripts = [
    'scripts/ops/backup-postgres.sh',
    'scripts/ops/restore-drill-postgres.sh',
    'scripts/ops/monitor-bridge-health.sh',
  ].map((relative) => path.join(root, relative));
  execFileSync('bash', ['-n', ...scripts], { stdio: 'pipe' });
  for (const file of [...scripts, path.join(root, 'scripts/ops/monitor-bridge-health.service'), path.join(root, 'scripts/ops/monitor-bridge-health.timer')]) {
    assert.equal(fs.existsSync(file), true, `${file} must exist`);
  }
});
