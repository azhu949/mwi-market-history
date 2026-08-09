import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(
  new URL("./sync-official-market.mjs", import.meta.url)
);

function buildSnapshot(timestamp, itemHrid = "/items/current") {
  return {
    timestamp,
    marketData: {
      [itemHrid]: {
        0: { a: 20, b: 18, p: 19, v: 4 }
      }
    }
  };
}

async function createTemporaryDataDir(t) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "mwi-market-history-test-")
  );
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

async function runSync(payload, dataDir, options = {}) {
  const sourceUrl = `data:application/json,${encodeURIComponent(JSON.stringify(payload))}`;
  const nodeArgs = [];
  if (options.nowMilliseconds != null) {
    const preloadSource = `Date.now = () => ${Number(options.nowMilliseconds)};`;
    nodeArgs.push(
      "--import",
      `data:text/javascript;base64,${Buffer.from(preloadSource).toString("base64")}`
    );
  }
  nodeArgs.push(
    scriptPath,
    "--source-url",
    sourceUrl,
    "--data-dir",
    dataDir
  );
  return execFileAsync(
    process.execPath,
    nodeArgs,
    { encoding: "utf8", windowsHide: true }
  );
}

async function writeRetiredArchive(dataDir, latestTimestamp, retiredRows) {
  const itemsDir = path.join(dataDir, "items");
  const relativePath = "items/items_retired__0.json";
  const shardPath = path.join(dataDir, relativePath);

  await fs.mkdir(itemsDir, { recursive: true });
  await fs.writeFile(
    shardPath,
    `${JSON.stringify({
      version: 1,
      source: "official_marketplace_json",
      itemHrid: "/items/retired",
      variant: 0,
      earliestTime: retiredRows[0].time,
      latestTime: retiredRows[retiredRows.length - 1].time,
      hourlyRetentionDays: 60,
      rows: retiredRows
    })}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(dataDir, "manifest.json"),
    `${JSON.stringify({
      version: 1,
      generatedAt: new Date(latestTimestamp * 1000).toISOString(),
      sourceName: "official_marketplace_json",
      latestTimestamp,
      latestSnapshotFingerprint: "previous-snapshot",
      latestHourlyRetentionDays: 60,
      items: {
        "/items/retired": {
          variants: {
            0: {
              path: relativePath,
              rows: retiredRows.length,
              earliestTime: retiredRows[0].time,
              latestTime: retiredRows[retiredRows.length - 1].time,
              maxDays: 1,
              hourlyRetentionDays: 60
            }
          }
        }
      }
    })}\n`,
    "utf8"
  );

  return { relativePath, shardPath };
}

test("normalizes millisecond payload timestamps to Unix seconds", async t => {
  const dataDir = await createTemporaryDataDir(t);
  const timestampMilliseconds = Date.now();
  const expectedTimestamp = Math.floor(timestampMilliseconds / 1000);

  await runSync(buildSnapshot(timestampMilliseconds), dataDir);

  const manifestPath = path.join(dataDir, "manifest.json");
  const firstManifestText = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(firstManifestText);
  const shard = JSON.parse(
    await fs.readFile(
      path.join(dataDir, "items", "items_current__0.json"),
      "utf8"
    )
  );
  assert.equal(manifest.latestTimestamp, expectedTimestamp);
  assert.equal(shard.rows[0].time, expectedTimestamp);

  await runSync(buildSnapshot(timestampMilliseconds), dataDir);
  assert.equal(await fs.readFile(manifestPath, "utf8"), firstManifestText);
});

test("rejects timestamps beyond the allowed future skew", async t => {
  const dataDir = await createTemporaryDataDir(t);
  const timestampMilliseconds = Date.now() + 2 * 86400 * 1000;

  await assert.rejects(
    runSync(buildSnapshot(timestampMilliseconds), dataDir),
    error => /seconds in the future/.test(error.stderr || "")
  );
  await assert.rejects(
    fs.access(path.join(dataDir, "manifest.json")),
    error => error?.code === "ENOENT"
  );
});

test("rejects invalid or ambiguous variant keys before writing data", async t => {
  const timestamp = Math.floor(Date.now() / 1000);

  for (const variantKey of ["invalid", "00", "1.5"]) {
    const dataDir = await createTemporaryDataDir(t);
    const payload = buildSnapshot(timestamp);
    payload.marketData["/items/current"][variantKey] = {
      a: 30,
      b: 28,
      p: 29,
      v: 2
    };

    await assert.rejects(
      runSync(payload, dataDir),
      error => /invalid variant key/.test(error.stderr || "")
    );
    await assert.rejects(
      fs.access(path.join(dataDir, "manifest.json")),
      error => error?.code === "ENOENT"
    );
  }
});

test("compacts archived variants missing from the latest snapshot", async t => {
  const dataDir = await createTemporaryDataDir(t);
  const timestamp = Math.floor(Date.now() / 1000);
  const oldDayStart = Math.floor((timestamp - 62 * 86400) / 86400) * 86400;
  const retiredRows = [
    { time: oldDayStart + 3600, a: 10, b: 8, p: 9, v: 2 },
    { time: oldDayStart + 7200, a: 14, b: 12, p: 13, v: 3 }
  ];
  const {
    relativePath: retiredRelativePath,
    shardPath: retiredPath
  } = await writeRetiredArchive(
    dataDir,
    timestamp - 3600,
    retiredRows
  );

  await runSync(buildSnapshot(timestamp), dataDir);

  const retiredShard = JSON.parse(await fs.readFile(retiredPath, "utf8"));
  assert.deepEqual(retiredShard.rows, [
    { time: oldDayStart + 7200, a: 12, b: 10, p: 11, v: 5 }
  ]);
  assert.equal(retiredShard.earliestTime, oldDayStart + 7200);
  assert.equal(retiredShard.latestTime, oldDayStart + 7200);

  const manifest = JSON.parse(
    await fs.readFile(path.join(dataDir, "manifest.json"), "utf8")
  );
  const retiredManifest = manifest.items["/items/retired"].variants["0"];
  assert.equal(retiredManifest.path, retiredRelativePath);
  assert.equal(retiredManifest.rows, 1);
  assert.equal(retiredManifest.earliestTime, oldDayStart + 7200);
  assert.equal(retiredManifest.latestTime, oldDayStart + 7200);
});

test("caps compaction time when an accepted snapshot crosses UTC midnight", async t => {
  const dataDir = await createTemporaryDataDir(t);
  const nowMilliseconds = Date.UTC(2026, 7, 9, 23, 58, 0);
  const nowTimestamp = Math.floor(nowMilliseconds / 1000);
  const snapshotTimestamp = nowTimestamp + 4 * 60;
  const cutoffDayStart =
    Math.floor((nowTimestamp - 60 * 86400) / 86400) * 86400;
  const retiredRows = [
    { time: cutoffDayStart + 3600, a: 10, b: 8, p: 9, v: 2 },
    { time: cutoffDayStart + 7200, a: 14, b: 12, p: 13, v: 3 }
  ];
  const { shardPath } = await writeRetiredArchive(
    dataDir,
    nowTimestamp - 3600,
    retiredRows
  );

  await runSync(buildSnapshot(snapshotTimestamp), dataDir, {
    nowMilliseconds
  });

  const retiredShard = JSON.parse(await fs.readFile(shardPath, "utf8"));
  assert.deepEqual(retiredShard.rows, retiredRows);
  const manifest = JSON.parse(
    await fs.readFile(path.join(dataDir, "manifest.json"), "utf8")
  );
  assert.equal(manifest.latestTimestamp, snapshotTimestamp);
});
