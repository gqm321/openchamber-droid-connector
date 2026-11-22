import fs from 'fs';
import os from 'os';
import path from 'path';
import { readAuthFile } from '../../opencode/auth.js';
import { buildResult, getAuthEntry, normalizeAuthEntry, toUsageWindow } from '../utils/index.js';

export const providerId = 'factory';
export const providerName = 'Factory (Droid)';
export const aliases = ['factory', 'factory-droid'];

const BILLING_URL = 'https://api.factory.ai/api/billing/limits';
// Key file managed by the openchamber-droid-connector deployment; the droid SDK
// also accepts this key via FACTORY_API_KEY (injected by bin/opencode-droid).
const ADAPTER_KEY_FILE = path.join(os.homedir(), '.config', 'openchamber-droid-connector', 'api-key');

const windowsByApiKey = {
  '5h': 'fiveHour',
  weekly: 'weekly',
  monthly: 'monthly',
};

export const parseFactoryUsage = (payload) => {
  if (!payload || typeof payload !== 'object') return {};
  const limits = payload.limits && typeof payload.limits === 'object' ? payload.limits : null;
  if (!limits) return {};
  const windows = {};
  for (const [tier, entries] of Object.entries({ standard: limits.standard, core: limits.core })) {
    if (!entries || typeof entries !== 'object') continue;
    for (const [key, apiKey] of Object.entries(windowsByApiKey)) {
      const entry = entries[apiKey];
      if (!entry || typeof entry !== 'object') continue;
      const usedPercent = entry.usedPercent;
      if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) continue;
      // Core (overage) windows have no reset timestamp while inactive — skip
      // them so the panel only shows windows the account is actually bound by.
      if (tier === 'core' && !(typeof entry.windowEnd === 'string' && Number.isFinite(new Date(entry.windowEnd).getTime()))) continue;
      const windowEndMs = typeof entry.windowEnd === 'string' ? new Date(entry.windowEnd).getTime() : NaN;
      const windowKey = tier === 'core' ? `core-${key}` : key;
      windows[windowKey] = toUsageWindow({
        usedPercent: Math.min(100, Math.max(0, usedPercent)),
        // The OpenChamber frontend schema requires resetAt to be epoch milliseconds, not an ISO string.
        resetAt: Number.isFinite(windowEndMs) ? windowEndMs : null,
        windowSeconds: null,
      });
    }
  }
  const extraCents = payload.extraUsageBalanceCents;
  if (payload.extraUsageAllowed === true && typeof extraCents === 'number' && Number.isFinite(extraCents)) {
    windows.extra_usage = toUsageWindow({
      usedPercent: null,
      resetAt: null,
      windowSeconds: null,
      valueLabel: `$${(extraCents / 100).toFixed(2)}`,
    });
  }
  return windows;
};

export const fetchFactoryUsage = async (apiKey, fetchImpl = fetch) => {
  const response = await fetchImpl(BILLING_URL, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': 'OpenChamber quota provider',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error('Factory authentication failed');
  }
  if (!response.ok) throw new Error(`Factory usage API returned HTTP ${response.status}`);
  const windows = parseFactoryUsage(await response.json().catch(() => null));
  if (Object.keys(windows).length === 0) throw new Error('Factory usage data could not be parsed');
  return windows;
};

const getApiKey = () => {
  const envKey = process.env.FACTORY_API_KEY;
  if (typeof envKey === 'string' && envKey.trim() !== '') return envKey.trim();
  try {
    if (fs.existsSync(ADAPTER_KEY_FILE)) {
      const content = fs.readFileSync(ADAPTER_KEY_FILE, 'utf8').trim();
      if (content !== '') return content;
    }
  } catch {
    // Fall through to the OpenCode auth entry.
  }
  const entry = normalizeAuthEntry(getAuthEntry(readAuthFile(), aliases));
  return entry?.key ?? entry?.token ?? null;
};

export const isConfigured = () => Boolean(getApiKey());

export const fetchQuota = async () => {
  try {
    const apiKey = getApiKey();
    if (!apiKey) return buildResult({ providerId, providerName, ok: false, configured: false, error: 'Not configured' });
    const windows = await fetchFactoryUsage(apiKey);
    return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows } });
  } catch (error) {
    return buildResult({ providerId, providerName, ok: false, configured: true, error: error instanceof Error ? error.message : 'Request failed' });
  }
};
