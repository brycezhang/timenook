import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { flock } from "fs-ext";

export interface JournalAuthority {
  databaseId: string;
  generation: number;
}
export interface PrivacyJournalConfig {
  root: string;
  /** Independent 32-byte base64 secret, supplied from outside Git/business backups. */
  key: string;
  /** Fixed for the lifetime of an active API/worker; absent means replay-only. */
  expectedAuthority?: JournalAuthority;
  lockTimeoutMs?: number;
}
export interface JournalEvent {
  eventId: string;
  projectId: string;
  kind: "revocation" | "deletion";
  occurredAt: string;
  payload: Record<string, unknown>;
}
export interface PublishedPrivacyEvent extends JournalEvent {
  sourceId: string;
  generation: number;
  hash: string;
}
export interface PrivacyJournalSnapshot {
  sourceId: string;
  generation: number;
  hash: string;
  authority: JournalAuthority;
  events: PublishedPrivacyEvent[];
}
export type PublicationWindow =
  | "temporary-written"
  | "temporary-synced"
  | "event-linked"
  | "event-directory-synced"
  | "head-temporary-synced"
  | "head-renamed"
  | "head-directory-synced";
/** I/O fault injection only, rejected outside NODE_ENV=test; never skips validation. */
export interface JournalTestFaults {
  at(window: PublicationWindow): Promise<void>;
}

interface Head {
  schemaVersion: 1;
  sourceId: string;
  generation: number;
  hash: string;
  authority: JournalAuthority;
}
interface StoredEvent extends JournalEvent {
  schemaVersion: 1;
  sourceId: string;
  generation: number;
  parentHash: string;
}
const EMPTY_HASH = "0".repeat(64);
const MAX_BYTES = 16 * 1024 * 1024;
type LocalWaiter = {
  deadline: number;
  resolve(release: () => void): void;
  reject(error: PrivacyJournalError): void;
  timer?: NodeJS.Timeout;
};
type LocalQueue = { waiters: LocalWaiter[] };
const inProcessLocks = new Map<string, LocalQueue>();
const TEMPORARY =
  /^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINAL = /^(\d{16})-([0-9a-f]{64})\.json$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PrivacyJournalError extends Error {
  constructor(message: string) {
    super(`Privacy journal: ${message}`);
    this.name = "PrivacyJournalError";
  }
}
function refuse(message: string): never {
  throw new PrivacyJournalError(message);
}
function localRelease(key: string, queue: LocalQueue): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (let next = queue.waiters.shift(); next; next = queue.waiters.shift()) {
      clearTimeout(next.timer);
      if (performance.now() >= next.deadline) {
        next.reject(new PrivacyJournalError("lock timeout"));
        continue;
      }
      // Reserve the slot before waking the next owner: a fresh snapshot cannot
      // bypass this waiter during an unlock/reacquire polling gap.
      next.resolve(localRelease(key, queue));
      return;
    }
    inProcessLocks.delete(key);
  };
}
function acquireLocal(key: string, deadline: number): Promise<() => void> {
  if (performance.now() >= deadline)
    return Promise.reject(new PrivacyJournalError("lock timeout"));
  const queue = inProcessLocks.get(key);
  if (!queue) {
    const created: LocalQueue = { waiters: [] };
    inProcessLocks.set(key, created);
    return Promise.resolve(localRelease(key, created));
  }
  return new Promise((resolve, reject) => {
    const waiter: LocalWaiter = { deadline, resolve, reject };
    queue.waiters.push(waiter);
    const expire = () => {
      const index = queue.waiters.indexOf(waiter);
      if (index < 0) return; // Already granted; a late timer cannot release it.
      const remaining = deadline - performance.now();
      if (remaining > 0) {
        waiter.timer = setTimeout(expire, Math.ceil(remaining));
        return;
      }
      queue.waiters.splice(index, 1);
      reject(new PrivacyJournalError("lock timeout"));
    };
    waiter.timer = setTimeout(
      expire,
      Math.max(1, Math.ceil(deadline - performance.now())),
    );
  });
}
function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${Array.from(value, canonical).join(",")}]`;
  if (
    typeof value === "object" &&
    value &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return refuse("unsupported JSON value");
}
function keys(
  value: unknown,
  expected: string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === expected.sort().join(",")
  );
}
function authority(value: unknown): value is JournalAuthority {
  return (
    keys(value, ["databaseId", "generation"]) &&
    typeof value.databaseId === "string" &&
    UUID.test(value.databaseId) &&
    Number.isSafeInteger(value.generation) &&
    Number(value.generation) > 0
  );
}
function validEvent(value: JournalEvent): void {
  if (
    !keys(value, ["eventId", "projectId", "kind", "occurredAt", "payload"]) ||
    ![value.eventId, value.projectId].every(
      (v) =>
        typeof v === "string" &&
        v.length > 0 &&
        v.length <= 200 &&
        !/[\x00-\x1f]/.test(v),
    ) ||
    !["revocation", "deletion"].includes(value.kind) ||
    typeof value.occurredAt !== "string" ||
    !Number.isFinite(Date.parse(value.occurredAt)) ||
    new Date(value.occurredAt).toISOString() !== value.occurredAt ||
    !value.payload ||
    typeof value.payload !== "object" ||
    Array.isArray(value.payload)
  )
    refuse("invalid event envelope");
  if (Buffer.byteLength(canonical(value)) > MAX_BYTES - 2048)
    refuse("event exceeds 16 MiB capacity; no targets published");
}
function sameAuthority(a: JournalAuthority, b: JournalAuthority): boolean {
  return a.databaseId === b.databaseId && a.generation === b.generation;
}
function flockAsync(fd: number, operation: "exnb" | "un"): Promise<void> {
  return new Promise((yes, no) =>
    flock(fd, operation, (error) => (error ? no(error) : yes())),
  );
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function privateDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    refuse("source directory is not private");
}
async function privateFile(path: string): Promise<FileHandle> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.() ||
      stat.size > MAX_BYTES
    )
      refuse("invalid source file");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** One local POSIX filesystem, one stable flock inode, no NFS/multi-host fallback. */
export class PrivacyJournal {
  private readonly root: string;
  private readonly key: Buffer;
  private readonly expected?: JournalAuthority;
  private readonly timeout: number;
  constructor(
    config: PrivacyJournalConfig,
    private readonly faults?: JournalTestFaults,
  ) {
    if (!isAbsolute(config.root)) refuse("source root must be absolute");
    this.root = resolve(config.root);
    this.key = Buffer.from(config.key, "base64");
    if (this.key.length !== 32 || this.key.toString("base64") !== config.key)
      refuse("key must be canonical 32-byte base64");
    if (config.expectedAuthority && !authority(config.expectedAuthority))
      refuse("invalid expected authority");
    this.expected = config.expectedAuthority
      ? { ...config.expectedAuthority }
      : undefined;
    this.timeout = config.lockTimeoutMs ?? 5000;
    if (
      !Number.isSafeInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 60000
    )
      refuse("invalid lock timeout");
    if (faults && process.env.NODE_ENV !== "test")
      refuse("fault injection requires test environment");
  }

  static async bootstrap(
    config: PrivacyJournalConfig,
    input: { databaseId: string },
  ): Promise<JournalAuthority> {
    const journal = new PrivacyJournal(config);
    const initial = { databaseId: input.databaseId, generation: 1 };
    if (!authority(initial)) refuse("invalid database identity");
    // Deliberately exclusive: a partially bootstrapped source is never silently reused.
    await mkdir(journal.root, { mode: 0o700 });
    await mkdir(join(journal.root, "events"), { mode: 0o700 });
    await mkdir(join(journal.root, "quarantine"), { mode: 0o700 });
    const lock = await open(join(journal.root, "lock"), "wx", 0o600);
    try {
      await lock.sync();
    } finally {
      await lock.close();
    }
    await journal.writeHead({
      schemaVersion: 1,
      sourceId: randomUUID(),
      generation: 0,
      hash: EMPTY_HASH,
      authority: initial,
    });
    await syncDirectory(join(journal.root, "events"));
    await syncDirectory(join(journal.root, "quarantine"));
    await syncDirectory(resolve(journal.root, ".."));
    return initial;
  }

  /** Caller proves its DB replay checkpoint before explicitly transferring publication authority. */
  static async promote(
    config: PrivacyJournalConfig,
    input: {
      expectedAuthority: JournalAuthority;
      databaseId: string;
      checkpoint: Pick<
        PrivacyJournalSnapshot,
        "sourceId" | "generation" | "hash"
      >;
    },
  ): Promise<JournalAuthority> {
    if (!authority(input.expectedAuthority) || !UUID.test(input.databaseId))
      refuse("invalid promotion identity");
    const journal = new PrivacyJournal(config);
    return journal.exclusive(async () => {
      const snapshot = await journal.readVerified();
      if (!sameAuthority(snapshot.authority, input.expectedAuthority))
        refuse("promotion authority conflict");
      if (
        snapshot.sourceId !== input.checkpoint.sourceId ||
        snapshot.generation !== input.checkpoint.generation ||
        snapshot.hash !== input.checkpoint.hash
      )
        refuse("recovery checkpoint is not caught up");
      if (snapshot.authority.databaseId === input.databaseId)
        refuse("recovery database must have a new installation identity");
      const next = {
        databaseId: input.databaseId,
        generation: snapshot.authority.generation + 1,
      };
      if (!authority(next)) refuse("authority generation exhausted");
      await journal.writeHead({
        schemaVersion: 1,
        sourceId: snapshot.sourceId,
        generation: snapshot.generation,
        hash: snapshot.hash,
        authority: next,
      });
      return next;
    });
  }

  async append(event: JournalEvent): Promise<PublishedPrivacyEvent> {
    validEvent(event);
    // Copy before waiting; callers cannot change the authorized body while queued.
    const immutable: JournalEvent = JSON.parse(canonical(event));
    return this.exclusive(async () => {
      const snapshot = await this.readVerified();
      this.requireAuthority(snapshot.authority);
      const old = snapshot.events.find(
        (item) => item.eventId === immutable.eventId,
      );
      if (old) {
        const {
          sourceId: _sourceId,
          generation: _generation,
          hash: _hash,
          ...body
        } = old;
        if (canonical(body) !== canonical(immutable))
          refuse("eventId payload conflict");
        return old;
      }
      const stored: StoredEvent = {
        ...immutable,
        schemaVersion: 1,
        sourceId: snapshot.sourceId,
        generation: snapshot.generation + 1,
        parentHash: snapshot.hash,
      };
      if (!Number.isSafeInteger(stored.generation))
        refuse("event sequence exhausted");
      const bytes = this.sign(stored);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const temporary = join(this.root, "events", `.tmp-${randomUUID()}`);
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await this.faults?.at("temporary-written");
        await file.sync();
        await this.faults?.at("temporary-synced");
      } finally {
        await file.close();
      }
      await link(
        temporary,
        join(this.root, "events", this.eventName(stored.generation, hash)),
      );
      await this.faults?.at("event-linked");
      await syncDirectory(join(this.root, "events"));
      await this.faults?.at("event-directory-synced");
      await this.writeHead({
        schemaVersion: 1,
        sourceId: stored.sourceId,
        generation: stored.generation,
        hash,
        authority: snapshot.authority,
      });
      await unlink(temporary);
      await syncDirectory(join(this.root, "events"));
      return {
        ...immutable,
        sourceId: stored.sourceId,
        generation: stored.generation,
        hash,
      };
    });
  }

  /** Detached verified snapshot; the file lock is released before any caller DB work. */
  async snapshot(): Promise<PrivacyJournalSnapshot> {
    return this.exclusive(async () => {
      const result = await this.readVerified();
      if (this.expected) this.requireAuthority(result.authority);
      return result;
    });
  }
  async assertHealthy(): Promise<void> {
    const snapshot = await this.snapshot();
    this.requireAuthority(snapshot.authority);
  }

  private requireAuthority(active: JournalAuthority): void {
    if (!this.expected || !sameAuthority(active, this.expected))
      refuse("active database authority mismatch");
  }
  private eventName(generation: number, hash: string): string {
    return `${String(generation).padStart(16, "0")}-${hash}.json`;
  }
  private sign(value: object): string {
    return canonical({
      ...value,
      mac: createHmac("sha256", this.key)
        .update(canonical(value))
        .digest("hex"),
    });
  }
  private async authenticated(
    path: string,
  ): Promise<{ body: Record<string, unknown>; bytes: string }> {
    const file = await privateFile(path);
    let bytes: string;
    try {
      bytes = await file.readFile("utf8");
    } finally {
      await file.close();
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(bytes);
    } catch {
      return refuse("source JSON is truncated or invalid");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      refuse("unknown source format");
    const { mac, ...body } = parsed;
    if (
      typeof mac !== "string" ||
      !/^[0-9a-f]{64}$/.test(mac) ||
      !timingSafeEqual(
        Buffer.from(mac, "hex"),
        createHmac("sha256", this.key).update(canonical(body)).digest(),
      ) ||
      canonical(parsed) !== bytes
    )
      refuse("source authentication failed");
    return { body, bytes };
  }
  private async writeHead(head: Head): Promise<void> {
    const temporary = join(this.root, `.tmp-${randomUUID()}`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(this.sign(head));
      await file.sync();
    } finally {
      await file.close();
    }
    await this.faults?.at("head-temporary-synced");
    await rename(temporary, join(this.root, "head.json"));
    await this.faults?.at("head-renamed");
    await syncDirectory(this.root);
    await this.faults?.at("head-directory-synced");
  }
  private async quarantineTemporary(
    directory: string,
    names: string[],
  ): Promise<void> {
    for (const name of names.filter((name) => TEMPORARY.test(name))) {
      const handle = await privateFile(join(directory, name));
      await handle.close();
      await rename(
        join(directory, name),
        join(this.root, "quarantine", `${randomUUID()}-${name}`),
      );
    }
    if (names.some((name) => TEMPORARY.test(name))) {
      await syncDirectory(directory);
      await syncDirectory(join(this.root, "quarantine"));
    }
  }
  private async readVerified(): Promise<PrivacyJournalSnapshot> {
    await privateDirectory(join(this.root, "events"));
    await privateDirectory(join(this.root, "quarantine"));
    const rootNames = await readdir(this.root);
    if (
      rootNames.some(
        (name) =>
          !["lock", "events", "quarantine", "head.json"].includes(name) &&
          !TEMPORARY.test(name),
      )
    )
      refuse("unknown source entry");
    const { body } = await this.authenticated(join(this.root, "head.json"));
    if (
      !keys(body, [
        "schemaVersion",
        "sourceId",
        "generation",
        "hash",
        "authority",
      ]) ||
      body.schemaVersion !== 1 ||
      typeof body.sourceId !== "string" ||
      !UUID.test(body.sourceId) ||
      !Number.isSafeInteger(body.generation) ||
      Number(body.generation) < 0 ||
      typeof body.hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(body.hash) ||
      !authority(body.authority)
    )
      refuse("unknown head format");
    let head = body as unknown as Head;
    const names = await readdir(join(this.root, "events"));
    if (names.some((name) => !TEMPORARY.test(name) && !FINAL.test(name)))
      refuse("unknown event format");
    const finals = names.filter((name) => FINAL.test(name)).sort();
    if (finals.length < head.generation || finals.length > head.generation + 1)
      refuse("missing events or publication fork");
    const events: PublishedPrivacyEvent[] = [];
    const ids = new Set<string>();
    let hash = EMPTY_HASH;
    for (let index = 0; index < finals.length; index++) {
      const { body: event, bytes } = await this.authenticated(
        join(this.root, "events", finals[index]),
      );
      if (
        !keys(event, [
          "schemaVersion",
          "sourceId",
          "generation",
          "parentHash",
          "eventId",
          "projectId",
          "kind",
          "occurredAt",
          "payload",
        ]) ||
        event.schemaVersion !== 1 ||
        event.sourceId !== head.sourceId ||
        event.generation !== index + 1 ||
        event.parentHash !== hash
      )
        refuse("event chain missing, forked or unknown");
      const {
        schemaVersion: _schema,
        sourceId,
        generation,
        parentHash: _parent,
        ...content
      } = event;
      validEvent(content as unknown as JournalEvent);
      if (ids.has(String(content.eventId)))
        refuse("duplicate eventId in source");
      ids.add(String(content.eventId));
      hash = createHash("sha256").update(bytes).digest("hex");
      if (finals[index] !== this.eventName(index + 1, hash))
        refuse("event filename authentication failed");
      events.push({
        ...content,
        sourceId,
        generation,
        hash,
      } as PublishedPrivacyEvent);
      if (index + 1 === head.generation && hash !== head.hash)
        refuse("authenticated head does not match event tail");
    }
    if (head.generation === 0 && head.hash !== EMPTY_HASH)
      refuse("invalid empty head");
    // Exactly one fully authenticated durable successor may be recovered. Prefix validation alone is insufficient.
    if (events.length > head.generation) {
      await syncDirectory(join(this.root, "events"));
      head = { ...head, generation: events.length, hash };
      await this.writeHead(head);
    }
    await this.quarantineTemporary(this.root, rootNames);
    await this.quarantineTemporary(join(this.root, "events"), names);
    return {
      sourceId: head.sourceId,
      generation: head.generation,
      hash: head.hash,
      authority: { ...head.authority },
      events,
    };
  }
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    let file: FileHandle | undefined;
    let releaseLocal: (() => void) | undefined;
    let acquired = false;
    const deadline = performance.now() + this.timeout;
    try {
      await privateDirectory(this.root);
      const key = await realpath(this.root);
      releaseLocal = await acquireLocal(key, deadline);
      file = await privateFile(join(this.root, "lock"));
      const inode = await file.stat();
      while (!acquired) {
        if (performance.now() >= deadline) refuse("lock timeout");
        try {
          await flockAsync(file.fd, "exnb");
          acquired = true;
        } catch (error) {
          if (
            !["EAGAIN", "EWOULDBLOCK"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          )
            throw error;
          if (performance.now() >= deadline) refuse("lock timeout");
          await delay(Math.min(10, Math.max(1, deadline - performance.now())));
        }
      }
      const current = await lstat(join(this.root, "lock"));
      if (
        !current.isFile() ||
        inode.ino !== current.ino ||
        inode.dev !== current.dev ||
        inode.nlink !== 1
      )
        refuse("fixed lock inode changed");
      return await work();
    } catch (error) {
      if (error instanceof PrivacyJournalError) throw error;
      // Never include parser fragments, private paths, secret material or event bodies in errors.
      throw new PrivacyJournalError(
        `source unavailable (${(error as NodeJS.ErrnoException).code ?? "I/O"})`,
      );
    } finally {
      try {
        if (file && acquired) await flockAsync(file.fd, "un");
      } finally {
        try {
          await file?.close();
        } finally {
          releaseLocal?.();
        }
      }
    }
  }
}
