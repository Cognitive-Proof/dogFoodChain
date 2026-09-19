import { describe, expect, test } from 'vitest';
import { ConcurrentWriteError, GcsLogStore, type RemoteFile } from '../src/gcsLogStore';
import type { LineEnvelope } from '../src/types';

function notFoundError(): Error & { code: number } {
  const err = new Error('not found') as Error & { code: number };
  err.code = 404;
  return err;
}

function preconditionFailedError(): Error & { code: number } {
  const err = new Error('precondition failed') as Error & { code: number };
  err.code = 412;
  return err;
}

/** In-memory stand-in for a GCS `File`, faithful enough to exercise GcsLogStore's
 *  concurrency logic without needing real GCP credentials or network access. */
class FakeRemoteFile implements RemoteFile {
  content: string | null = null;
  generation = 0;
  /** Fires once, right as save() is about to apply — used to simulate another writer
   *  landing a change in the gap between this store's read and its write. */
  beforeSave?: () => void;

  async download(): Promise<[Buffer]> {
    if (this.content === null) throw notFoundError();
    return [Buffer.from(this.content, 'utf8')];
  }

  async getMetadata(): Promise<[{ generation?: number }]> {
    if (this.content === null) throw notFoundError();
    return [{ generation: this.generation }];
  }

  async save(data: string, opts: { preconditionOpts: { ifGenerationMatch: number } }): Promise<void> {
    const hook = this.beforeSave;
    this.beforeSave = undefined;
    hook?.();

    const currentGeneration = this.content === null ? 0 : this.generation;
    if (opts.preconditionOpts.ifGenerationMatch !== currentGeneration) {
      throw preconditionFailedError();
    }
    this.content = data;
    this.generation = currentGeneration + 1;
  }
}

function line(seq: number): LineEnvelope {
  return {
    lineType: seq === 0 ? 'governance' : 'block',
    seq,
    chainId: 'urn:uuid:test',
    payload: { action: seq === 0 ? 'genesis' : 'block' } as never,
    manifest: `manifest-${seq}`,
  };
}

function storeWithFake(fake: FakeRemoteFile): GcsLogStore {
  return new GcsLogStore('gs://test-bucket/log.jsonl', () => fake);
}

describe('GcsLogStore', () => {
  test('readAll on a nonexistent object returns an empty array', async () => {
    const store = storeWithFake(new FakeRemoteFile());
    expect(await store.readAll()).toEqual([]);
    expect(await store.exists()).toBe(false);
  });

  test('init writes the genesis line and readAll sees it', async () => {
    const store = storeWithFake(new FakeRemoteFile());
    await store.init(line(0));
    expect(await store.readAll()).toEqual([line(0)]);
    expect(await store.exists()).toBe(true);
  });

  test('init refuses to overwrite an already-initialized log', async () => {
    const fake = new FakeRemoteFile();
    const store = storeWithFake(fake);
    await store.init(line(0));
    await expect(store.init(line(0))).rejects.toThrow(/already exists/);
  });

  test('append adds a line when seq matches the current length', async () => {
    const fake = new FakeRemoteFile();
    const store = storeWithFake(fake);
    await store.init(line(0));
    await store.append(line(1));
    expect(await store.readAll()).toEqual([line(0), line(1)]);
  });

  test('append rejects a seq that does not match the current length (semantic check)', async () => {
    const fake = new FakeRemoteFile();
    const store = storeWithFake(fake);
    await store.init(line(0));
    // Only 1 line exists (seq 0); appending seq 5 should be refused, not silently accepted.
    await expect(store.append(line(5))).rejects.toThrow(ConcurrentWriteError);
    expect(await store.readAll()).toEqual([line(0)]); // unchanged
  });

  test('append rejects when another writer commits between this store\'s read and its write', async () => {
    const fake = new FakeRemoteFile();
    const store = storeWithFake(fake);
    await store.init(line(0));

    // Simulate a concurrent writer landing seq 1 right as our own append(1) is about to save.
    fake.beforeSave = () => {
      fake.content = `${JSON.stringify(line(0))}\n${JSON.stringify(line(1))}\n`;
      fake.generation = 2;
    };

    await expect(store.append(line(1))).rejects.toThrow(ConcurrentWriteError);
    // The concurrent writer's line is still there — our store didn't clobber it.
    expect(await store.readAll()).toEqual([line(0), line(1)]);
  });
});
