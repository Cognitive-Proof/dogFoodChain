// Opt-in integration test against a REAL GCS bucket — not run by default (npm test
// skips it) since it needs actual gcloud credentials and a real bucket. Run it with:
//
//   DOGFOODCHAIN_GCS_SMOKE_BUCKET=dogfood1 npx vitest run test/gcsLogStore.smoke.test.ts
//
// It exercises exactly the thing test/gcsLogStore.test.ts can only fake: a real
// concurrent-write race resolved by GCS's generation preconditions, not an in-memory
// simulation of them.
import { randomUUID } from 'node:crypto';
import { Storage } from '@google-cloud/storage';
import { describe, expect, test } from 'vitest';
import { ConcurrentWriteError, GcsLogStore } from '../src/gcsLogStore';
import type { LineEnvelope } from '../src/types';

const bucket = process.env.DOGFOODCHAIN_GCS_SMOKE_BUCKET;

function line(seq: number): LineEnvelope {
  return {
    lineType: seq === 0 ? 'governance' : 'block',
    seq,
    chainId: 'urn:uuid:gcs-smoke-test',
    payload: { action: seq === 0 ? 'genesis' : 'block' } as never,
    manifest: `manifest-${seq}`,
  };
}

describe.skipIf(!bucket)('GcsLogStore against a real GCS bucket', () => {
  const objectPath = `smoke-test-${randomUUID()}.jsonl`;
  const ref = `gs://${bucket}/${objectPath}`;

  test('init + append + readAll round-trip against real GCS', async () => {
    const store = new GcsLogStore(ref);
    await store.init(line(0));
    await store.append(line(1));
    expect(await store.readAll()).toEqual([line(0), line(1)]);
  });

  test('two concurrent appends for the same seq: exactly one wins, the other is rejected', async () => {
    const store = new GcsLogStore(ref);
    // Two different stores hitting the same object, racing to append seq 2 — mirrors two
    // separate node processes (or two concurrent requests to one node) rather than two
    // calls on the same in-memory object.
    const storeA = new GcsLogStore(ref);
    const storeB = new GcsLogStore(ref);

    const results = await Promise.allSettled([storeA.append(line(2)), storeB.append(line(2))]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConcurrentWriteError);

    const finalLines = await store.readAll();
    expect(finalLines).toHaveLength(3); // seq 0, 1, 2 — not 4
  });

  test('cleanup: delete the smoke-test object', async () => {
    await new Storage().bucket(bucket!).file(objectPath).delete();
    const store = new GcsLogStore(ref);
    expect(await store.exists()).toBe(false);
  });
});
