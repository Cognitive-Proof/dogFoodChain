import { Storage } from '@google-cloud/storage';
import type { LineEnvelope } from './types';
import { parseJsonl } from './jsonl';

export function isGcsRef(ref: string): boolean {
  return ref.startsWith('gs://');
}

function parseGcsRef(ref: string): { bucket: string; object: string } {
  const withoutScheme = ref.slice('gs://'.length);
  const slash = withoutScheme.indexOf('/');
  if (slash <= 0 || slash === withoutScheme.length - 1) {
    throw new Error(`invalid gs:// ref (expected gs://bucket/object.jsonl): ${ref}`);
  }
  return { bucket: withoutScheme.slice(0, slash), object: withoutScheme.slice(slash + 1) };
}

/** Thrown when an append loses a race to another writer — the caller must recompute
 *  (re-read the log, re-derive seq/ingredient references, re-sign) and retry the whole
 *  operation. A blind retry of the same pre-signed line would be wrong: it was signed
 *  referencing a specific seq and parent that may no longer be current. */
export class ConcurrentWriteError extends Error {}

/** The subset of the GCS `File` API this store needs — small enough to fake in tests
 *  without mocking the whole @google-cloud/storage SDK. */
export interface RemoteFile {
  download(): Promise<[Buffer]>;
  getMetadata(): Promise<[{ generation?: string | number | null }]>;
  save(
    data: string,
    opts: { contentType: string; preconditionOpts: { ifGenerationMatch: number } }
  ): Promise<unknown>;
}

export type FileFactory = (bucket: string, object: string) => RemoteFile;

const defaultStorage = new Storage(); // uses Application Default Credentials
const defaultFileFactory: FileFactory = (bucket, object) =>
  defaultStorage.bucket(bucket).file(object) as unknown as RemoteFile;

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 404;
}

function isPreconditionFailed(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 412;
}

export class GcsLogStore {
  private readonly bucket: string;
  private readonly object: string;
  private readonly ref: string;
  private readonly file: RemoteFile;

  constructor(ref: string, fileFactory: FileFactory = defaultFileFactory) {
    const { bucket, object } = parseGcsRef(ref);
    this.bucket = bucket;
    this.object = object;
    this.ref = ref;
    this.file = fileFactory(bucket, object);
  }

  private async readWithGeneration(): Promise<{ text: string; generation: number }> {
    try {
      const [metadata] = await this.file.getMetadata();
      const [buf] = await this.file.download();
      return { text: buf.toString('utf8'), generation: Number(metadata.generation ?? 0) };
    } catch (err) {
      if (isNotFound(err)) return { text: '', generation: 0 };
      throw err;
    }
  }

  async readAll(): Promise<LineEnvelope[]> {
    const { text } = await this.readWithGeneration();
    return parseJsonl(text);
  }

  async exists(): Promise<boolean> {
    const { generation } = await this.readWithGeneration();
    return generation !== 0;
  }

  async init(genesis: LineEnvelope): Promise<void> {
    try {
      await this.file.save(JSON.stringify(genesis) + '\n', {
        contentType: 'application/x-ndjson',
        preconditionOpts: { ifGenerationMatch: 0 }, // only succeeds if the object doesn't exist yet
      });
    } catch (err) {
      if (isPreconditionFailed(err)) {
        throw new Error(`${this.ref} already exists — refusing to overwrite an existing log`);
      }
      throw err;
    }
  }

  /**
   * Appends one line, guarded two ways: a semantic check that `line.seq` is actually
   * the next expected position, and an atomic generation-precondition write so a
   * concurrent writer can't silently clobber this one. Throws `ConcurrentWriteError`
   * on either kind of conflict — it does not retry, since retrying safely would require
   * re-deriving and re-signing the line against the now-current tip, which only the
   * caller (which built the line in the first place) can do.
   */
  async append(line: LineEnvelope): Promise<void> {
    const { text, generation } = await this.readWithGeneration();
    const existingCount = text.trim().length === 0 ? 0 : text.trim().split('\n').length;
    if (line.seq !== existingCount) {
      throw new ConcurrentWriteError(
        `refusing to append seq ${line.seq} to ${this.ref}: it already has ${existingCount} line(s) — ` +
          'another writer appended first; recompute and retry'
      );
    }

    const newText = text + JSON.stringify(line) + '\n';
    try {
      await this.file.save(newText, {
        contentType: 'application/x-ndjson',
        preconditionOpts: { ifGenerationMatch: generation },
      });
    } catch (err) {
      if (isPreconditionFailed(err)) {
        throw new ConcurrentWriteError(
          `refusing to append seq ${line.seq} to ${this.ref}: concurrent write detected, recompute and retry`
        );
      }
      throw err;
    }
  }
}

const storeCache = new Map<string, GcsLogStore>();

export function getGcsStore(ref: string): GcsLogStore {
  let store = storeCache.get(ref);
  if (!store) {
    store = new GcsLogStore(ref);
    storeCache.set(ref, store);
  }
  return store;
}
