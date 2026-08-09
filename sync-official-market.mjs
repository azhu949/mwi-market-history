#!/usr/bin/env node

// MWI official market sync.
// Downloads the latest official market JSON and merges it into per-item
// history shards under items/, then updates manifest.json.

import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const DEFAULT_SOURCE_URL =
  "https://www.milkywayidle.com/game_data/marketplace.json";
const DEFAULT_DATA_DIR = "data";
// Compaction is lossy, so the archive policy is intentionally fixed.
const HOURLY_RETENTION_DAYS = 60;
const MAX_FUTURE_SKEW_SECONDS = 5 * 60;
const UNIX_MILLISECONDS_THRESHOLD = 100_000_000_000;

function parseArgs(argv) {
  const args = {
    sourceUrl: process.env.MWI_OFFICIAL_MARKET_URL || DEFAULT_SOURCE_URL,
    dataDir: DEFAULT_DATA_DIR
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source-url") args.sourceUrl = argv[++i];
    else if (arg === "--data-dir") args.dataDir = path.resolve(argv[++i]);
    else if (arg === "--help") {
      console.log(`Usage:
  node sync-official-market.mjs [--source-url <url>] [--data-dir <dir>]

What it does:
  1. Downloads the latest official market snapshot JSON.
  2. Appends per-item/per-variant history shards.
  3. Compacts complete UTC dates older than the retention window into daily points.
  4. Rebuilds manifest.json.

Retention policy:
  The archive keeps ${HOURLY_RETENTION_DAYS} days of hourly samples.
  Older complete UTC dates are compacted into one daily point.

Environment:
  MWI_OFFICIAL_MARKET_URL can override the snapshot URL.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function validateUnixTimestampSeconds(value, label) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new Error(`${label} must be a positive finite Unix timestamp`);
  }

  const normalized = Math.floor(timestamp);
  const latestAllowed = Math.floor(Date.now() / 1000) + MAX_FUTURE_SKEW_SECONDS;
  if (normalized > latestAllowed) {
    throw new Error(
      `${label} ${normalized} is more than ${MAX_FUTURE_SKEW_SECONDS} seconds in the future`
    );
  }
  return normalized;
}

function normalizePayloadTimestamp(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    throw new Error("Snapshot payload timestamp must be a positive finite number");
  }

  const seconds = numericValue >= UNIX_MILLISECONDS_THRESHOLD
    ? numericValue / 1000
    : numericValue;
  return validateUnixTimestampSeconds(seconds, "Snapshot payload timestamp");
}

function resolveSnapshotTimestamp(payload, response) {
  const payloadTimestamp = payload?.timestamp;
  if (
    payloadTimestamp !== undefined &&
    payloadTimestamp !== null &&
    payloadTimestamp !== ""
  ) {
    return normalizePayloadTimestamp(payloadTimestamp);
  }

  const lastModified = response?.headers?.get?.("last-modified");
  const lastModifiedMs = lastModified ? Date.parse(lastModified) : NaN;
  if (Number.isFinite(lastModifiedMs) && lastModifiedMs > 0) {
    return validateUnixTimestampSeconds(
      lastModifiedMs / 1000,
      "Snapshot Last-Modified timestamp"
    );
  }

  const responseDate = response?.headers?.get?.("date");
  const responseDateMs = responseDate ? Date.parse(responseDate) : NaN;
  if (Number.isFinite(responseDateMs) && responseDateMs > 0) {
    return validateUnixTimestampSeconds(
      responseDateMs / 1000,
      "Snapshot Date timestamp"
    );
  }

  return validateUnixTimestampSeconds(
    Date.now() / 1000,
    "Snapshot fallback timestamp"
  );
}

function snapshotFingerprint(payload, response) {
  const lastModified = response?.headers?.get?.("last-modified");
  const contentHash = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
  return lastModified
    ? `last-modified:${lastModified}:hash:${contentHash}`
    : `hash:${contentHash}`;
}

function normalizeSnapshot(payload, response, sourceUrl) {
  const timestamp = resolveSnapshotTimestamp(payload, response);
  const fingerprint = snapshotFingerprint(payload, response);
  const marketData = payload?.marketData;
  if (!marketData || typeof marketData !== "object") {
    throw new Error("Snapshot payload missing marketData");
  }

  const items = [];
  for (const [itemHrid, variants] of Object.entries(marketData)) {
    if (!itemHrid?.startsWith("/items/")) continue;
    for (const [variantKey, point] of Object.entries(variants || {})) {
      const variant = Number(variantKey);
      if (
        !Number.isSafeInteger(variant) ||
        variant < 0 ||
        String(variant) !== variantKey
      ) {
        throw new Error(
          `Snapshot item ${itemHrid} has invalid variant key: ${variantKey}`
        );
      }
      items.push({
        itemHrid,
        variant,
        row: {
          time: timestamp,
          a: point?.a ?? -1,
          b: point?.b ?? -1,
          p: point?.p ?? null,
          v: point?.v ?? null
        }
      });
    }
  }

  if (!items.length) {
    throw new Error("Snapshot marketData has no item rows");
  }

  return {
    timestamp,
    fingerprint,
    payload: {
      timestamp,
      marketData,
      meta: {
        sourceUrl,
        lastModified: response?.headers?.get?.("last-modified") || null,
        fetchedAt: new Date().toISOString(),
        fingerprint
      }
    },
    items
  };
}

function sameHistoryRow(left, right) {
  return (
    Number(left?.time) === Number(right?.time) &&
    toNumberOrNull(left?.a) === toNumberOrNull(right?.a) &&
    toNumberOrNull(left?.b) === toNumberOrNull(right?.b) &&
    toNumberOrNull(left?.p) === toNumberOrNull(right?.p) &&
    toNumberOrNull(left?.v) === toNumberOrNull(right?.v)
  );
}

function mergeRow(rows, nextRow) {
  // If the new row shares a timestamp with an existing row, replace it in
  // place (keep the newest value for that timestamp) instead of appending a
  // duplicate point. This avoids duplicate time points in a shard when the
  // official snapshot re-emits the same timestamp with different data.
  const time = toNumberOrNull(nextRow.time);
  if (time != null) {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const existing = rows[i];
      if (toNumberOrNull(existing?.time) === time) {
        if (sameHistoryRow(existing, nextRow)) {
          return { rows, changed: false }; // identical, no-op
        }
        rows[i] = { ...nextRow }; // same timestamp, updated value
        return { rows, changed: true };
      }
    }
  }

  // New timestamp (or unparsable time): append, with trailing-row dedupe.
  const lastRow = rows[rows.length - 1];
  if (lastRow && sameHistoryRow(lastRow, nextRow)) {
    return { rows, changed: false };
  }

  rows.push(nextRow);
  return { rows, changed: true };
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getMedian(values) {
  const valid = values
    .map(toNumberOrNull)
    .filter(value => value != null && value > 0)
    .sort((left, right) => left - right);
  if (!valid.length) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 === 0 ? (valid[mid - 1] + valid[mid]) / 2 : valid[mid];
}

function buildDayKeyUtc(unixTimeSeconds) {
  const date = new Date(Number(unixTimeSeconds) * 1000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function lowerBoundTime(rows, cutoff) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (Number(rows[mid].time) < cutoff) low = mid + 1;
    else high = mid;
  }
  return low;
}

function sameRows(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  return left.every((row, index) => sameHistoryRow(row, right[index]));
}

function compactHistoryRows(rows, options = {}) {
  const nowTime = Number(options.nowTime) || Math.floor(Date.now() / 1000);
  const hourlyCutoff = nowTime - HOURLY_RETENTION_DAYS * 86400;

  if (!Array.isArray(rows) || !rows.length) {
    return { rows: [], changed: false };
  }

  const sortedRows = rows
    .map(row => {
      const time = Number(row?.time) || 0;
      if (!time) return null;
      return {
        time,
        a: toNumberOrNull(row?.a),
        b: toNumberOrNull(row?.b),
        p: toNumberOrNull(row?.p),
        v: toNumberOrNull(row?.v)
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.time - right.time);
  const orderChanged = !sameRows(rows, sortedRows);

  // Keep the entire UTC date containing the cutoff in hourly form. The cutoff
  // moves between syncs, so aggregating only part of that date would feed a
  // previous daily median back into the next aggregation and corrupt it.
  const cutoffDayStart = Math.floor(hourlyCutoff / 86400) * 86400;
  const firstRecentIndex = lowerBoundTime(sortedRows, cutoffDayStart);
  if (firstRecentIndex === 0) {
    return { rows: sortedRows, changed: orderChanged };
  }

  const olderRows = sortedRows.slice(0, firstRecentIndex);
  const recentRows = sortedRows.slice(firstRecentIndex);
  const aggregatedOlderRows = aggregateRowsByDay(olderRows);
  return {
    rows: [...aggregatedOlderRows, ...recentRows],
    changed: orderChanged || !sameRows(olderRows, aggregatedOlderRows)
  };
}

function aggregateRowsByDay(rows) {
  const sortedRows = (Array.isArray(rows) ? rows : [])
    .map(row => {
      const time = Number(row?.time) || 0;
      if (!time) return null;
      return {
        time,
        a: toNumberOrNull(row?.a),
        b: toNumberOrNull(row?.b),
        p: toNumberOrNull(row?.p),
        v: toNumberOrNull(row?.v)
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.time - right.time);

  if (!sortedRows.length) return [];

  const groups = new Map();
  for (const row of sortedRows) {
    const dayKey = buildDayKeyUtc(row.time);
    const group = groups.get(dayKey) || [];
    group.push(row);
    groups.set(dayKey, group);
  }

  return Array.from(groups.values()).map(groupRows => {
    const latestTime = groupRows[groupRows.length - 1].time;
    return {
      time: latestTime,
      a: getMedian(groupRows.map(row => row.a)),
      b: getMedian(groupRows.map(row => row.b)),
      p: getMedian(groupRows.map(row => row.p)),
      v: groupRows.reduce(
        (sum, row) => sum + Math.max(0, toNumberOrNull(row.v) || 0),
        0
      )
    };
  });
}

function toSafeFilename(value) {
  return String(value)
    .replace(/^\/+/, "")
    .replace(/[\\/:%?&#=+ ]/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

function updateVariantManifestEntry(existingEntry, rows, relativePath, hourlyRetentionDays) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const earliestTime = normalizedRows[0]?.time ?? null;
  const latestTime = normalizedRows[normalizedRows.length - 1]?.time ?? null;
  const maxDays = earliestTime && latestTime
    ? Math.max(1, Math.ceil((Number(latestTime) - Number(earliestTime)) / 86400) + 1)
    : 0;

  return {
    ...(existingEntry || {}),
    path: relativePath,
    rows: normalizedRows.length,
    earliestTime,
    latestTime,
    maxDays,
    hourlyRetentionDays
  };
}

function updateManifestVariant(manifest, itemHrid, variant, rows, relativePath) {
  const itemEntry = manifest.items[itemHrid] || { variants: {} };
  if (!itemEntry.variants || typeof itemEntry.variants !== "object") {
    itemEntry.variants = {};
  }
  itemEntry.variants[String(variant)] = updateVariantManifestEntry(
    itemEntry.variants[String(variant)],
    rows,
    relativePath,
    HOURLY_RETENTION_DAYS
  );
  manifest.items[itemHrid] = itemEntry;
}

function updateShardMetadata(shard, itemHrid, variant, rows, emptyTime = null) {
  const earliestTime = rows[0]?.time ?? emptyTime;
  const latestTime = rows[rows.length - 1]?.time ?? emptyTime;
  const changed =
    shard.version !== 1 ||
    shard.source !== "official_marketplace_json" ||
    shard.itemHrid !== itemHrid ||
    shard.variant !== variant ||
    shard.earliestTime !== earliestTime ||
    shard.latestTime !== latestTime ||
    shard.hourlyRetentionDays !== HOURLY_RETENTION_DAYS;

  shard.version = 1;
  shard.source = "official_marketplace_json";
  shard.itemHrid = itemHrid;
  shard.variant = variant;
  shard.rows = rows;
  shard.earliestTime = earliestTime;
  shard.latestTime = latestTime;
  shard.hourlyRetentionDays = HOURLY_RETENTION_DAYS;
  return changed;
}

function collectManifestRetentionDays(manifest) {
  const values = [];
  const addValue = value => {
    const normalized = toNumberOrNull(value);
    if (normalized != null) values.push(normalized);
  };

  addValue(manifest?.latestHourlyRetentionDays);
  for (const itemEntry of Object.values(manifest?.items || {})) {
    for (const variantEntry of Object.values(itemEntry?.variants || {})) {
      addValue(variantEntry?.hourlyRetentionDays);
    }
  }

  return [...new Set(values)];
}

async function listShardFiles(itemsDir) {
  const entries = await fs.readdir(itemsDir, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
    .map(entry => entry.name);
}

async function collectShardRetentionDays(itemsDir) {
  const shardFiles = await listShardFiles(itemsDir);
  const values = [];

  for (const filename of shardFiles) {
    const shard = await readJsonIfExists(path.join(itemsDir, filename), null);
    const normalized = toNumberOrNull(shard?.hourlyRetentionDays);
    if (normalized != null) values.push(normalized);
  }

  return {
    values: [...new Set(values)],
    hasShardFiles: shardFiles.length > 0
  };
}

async function compactArchivedShardsNotInSnapshot(options) {
  const {
    itemsDir,
    manifest,
    compactionTimestamp,
    importedShardFiles
  } = options;
  const shardFiles = await listShardFiles(itemsDir);
  let touchedVariants = 0;

  for (const filename of shardFiles) {
    if (importedShardFiles.has(filename)) continue;

    const itemPath = path.join(itemsDir, filename);
    const shard = await readJsonIfExists(itemPath, null);
    if (!shard || typeof shard !== "object" || Array.isArray(shard)) {
      throw new Error(`Archived shard ${filename} must contain a JSON object`);
    }
    if (typeof shard.itemHrid !== "string" || !shard.itemHrid.startsWith("/items/")) {
      throw new Error(`Archived shard ${filename} has an invalid itemHrid`);
    }

    const variant = toNumberOrNull(shard.variant);
    if (variant == null || !Number.isInteger(variant)) {
      throw new Error(`Archived shard ${filename} has an invalid variant`);
    }
    if (!Array.isArray(shard.rows)) {
      throw new Error(`Archived shard ${filename} has an invalid rows array`);
    }

    const compacted = compactHistoryRows(shard.rows, {
      nowTime: compactionTimestamp
    });
    const metadataChanged = updateShardMetadata(
      shard,
      shard.itemHrid,
      variant,
      compacted.rows
    );
    const relativePath = `items/${filename}`;
    updateManifestVariant(
      manifest,
      shard.itemHrid,
      variant,
      compacted.rows,
      relativePath
    );

    if (compacted.changed || metadataChanged) {
      await fs.writeFile(itemPath, `${JSON.stringify(shard)}\n`, "utf8");
      touchedVariants += 1;
    }
  }

  return touchedVariants;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const itemsDir = path.join(args.dataDir, "items");
  const manifestPath = path.join(args.dataDir, "manifest.json");

  await fs.mkdir(itemsDir, { recursive: true });

  console.log(`Fetching official market snapshot from ${args.sourceUrl}`);
  const response = await fetch(args.sourceUrl, {
    headers: { "cache-control": "no-cache" }
  });
  if (!response.ok) {
    throw new Error(`Snapshot download failed with HTTP ${response.status}`);
  }

  const snapshotPayload = await response.json();
  const snapshot = normalizeSnapshot(snapshotPayload, response, args.sourceUrl);
  const compactionTimestamp = Math.min(
    snapshot.timestamp,
    Math.floor(Date.now() / 1000)
  );
  const manifest = await readJsonIfExists(manifestPath, {
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceName: "official_marketplace_json",
    latestTimestamp: null,
    items: {}
  });
  delete manifest.latestSnapshot;

  const latestArchivedTimestamp = toNumberOrNull(manifest.latestTimestamp);
  if (
    latestArchivedTimestamp != null &&
    snapshot.timestamp < latestArchivedTimestamp
  ) {
    throw new Error(
      `Snapshot ${snapshot.timestamp} is older than the archived snapshot ${latestArchivedTimestamp}`
    );
  }

  let retentionValues = collectManifestRetentionDays(manifest);
  const manifestHasArchivedData =
    manifest?.latestSnapshotFingerprint != null ||
    Object.keys(manifest?.items || {}).length > 0;
  let hasShardFiles = false;
  if (!retentionValues.length) {
    const shardRetention = await collectShardRetentionDays(itemsDir);
    retentionValues = shardRetention.values;
    hasShardFiles = shardRetention.hasShardFiles;
  }
  if (retentionValues.length > 1) {
    throw new Error(
      `Archive contains inconsistent hourly-retention-days values: ${retentionValues.join(", ")}`
    );
  }

  const hasArchivedData =
    manifestHasArchivedData || hasShardFiles;
  const configuredRetentionDays = retentionValues[0] ?? null;
  if (hasArchivedData && configuredRetentionDays == null) {
    throw new Error(
      `Existing archive has no hourly-retention-days configuration; this script requires a ${HOURLY_RETENTION_DAYS}-day archive`
    );
  }
  if (
    configuredRetentionDays != null &&
    configuredRetentionDays !== HOURLY_RETENTION_DAYS
  ) {
    throw new Error(
      `Archive uses hourly-retention-days=${configuredRetentionDays}; this script only supports ${HOURLY_RETENTION_DAYS} days`
    );
  }

  const hasSnapFingerprint = manifest?.latestSnapshotFingerprint != null;
  const retentionConfigNeedsMigration =
    manifest?.latestHourlyRetentionDays == null && configuredRetentionDays != null;

  const isSameSnapshot =
    hasSnapFingerprint &&
    manifest.latestSnapshotFingerprint === snapshot.fingerprint &&
    !retentionConfigNeedsMigration;

  if (isSameSnapshot) {
    // 数据未变化时完全静默返回：不更新时间、不重写 manifest.json。否则
    // generatedAt 每次运行都会变化，ci 里 git add data 会检测到 manifest.json
    // 变更并产生无意义的提交。manifest.generatedAt 只反映最后一次实际导入。
    console.log(
      `Snapshot ${snapshot.timestamp} already imported, skipped shard rewrite`
    );
    return;
  }

  let touchedVariants = 0;
  const importedShardFiles = new Set();
  for (const entry of snapshot.items) {
    const itemFilename = `${toSafeFilename(entry.itemHrid)}__${entry.variant}.json`;
    importedShardFiles.add(itemFilename);
    const itemRelativePath = `items/${itemFilename}`;
    const itemPath = path.join(args.dataDir, itemRelativePath);
    const existingShard = await readJsonIfExists(itemPath, {
      version: 1,
      source: "official_marketplace_json",
      itemHrid: entry.itemHrid,
      variant: entry.variant,
      earliestTime: entry.row.time,
      latestTime: entry.row.time,
      rows: []
    });

    const rows = Array.isArray(existingShard.rows) ? existingShard.rows : [];
    const merged = mergeRow(rows, entry.row);
    const mergedRows = merged.rows;
    const compacted = compactHistoryRows(mergedRows, {
      nowTime: compactionTimestamp
    });
    const compactedRows = compacted.rows;
    const shardChanged = merged.changed || compacted.changed;
    const shardMetadataChanged = updateShardMetadata(
      existingShard,
      entry.itemHrid,
      entry.variant,
      compactedRows,
      entry.row.time
    );

    // 无论分片数据是否变化，都重算并刷新 manifest 条目。这样当上一次运行在
    // 写完部分分片之后、写 manifest 之前崩溃时，本次重试不会因为「分片未变化」
    // 被 continue 跳过，从而能修复缺失或过期的 manifest 条目。
    updateManifestVariant(
      manifest,
      entry.itemHrid,
      entry.variant,
      compactedRows,
      itemRelativePath
    );

    if (shardChanged || shardMetadataChanged) {
      await fs.writeFile(itemPath, `${JSON.stringify(existingShard)}\n`, "utf8");
      touchedVariants += 1;
    }
  }

  // Retired or temporarily absent variants still need the same retention
  // maintenance as variants present in the latest full snapshot.
  touchedVariants += await compactArchivedShardsNotInSnapshot({
    itemsDir,
    manifest,
    compactionTimestamp,
    importedShardFiles
  });

  manifest.version = 1;
  manifest.generatedAt = new Date().toISOString();
  manifest.sourceName = "official_marketplace_json";
  manifest.latestTimestamp = snapshot.timestamp;
  manifest.latestSnapshotFingerprint = snapshot.fingerprint;
  manifest.latestHourlyRetentionDays = HOURLY_RETENTION_DAYS;

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
  console.log(
    `Imported snapshot ${snapshot.timestamp} and updated ${touchedVariants} item variants`
  );
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
