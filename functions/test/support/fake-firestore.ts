/**
 * A small in-memory Firestore with the subset of the Admin SDK API this backend uses: documents,
 * subcollections, set/merge/update/delete, FieldValue transforms, where/orderBy/limit queries,
 * getAll, batches and (serialised) transactions. Good enough to run the real services end to end
 * where the Firestore emulator isn't available. Not a full implementation.
 */
import { randomBytes } from "crypto";
import { Timestamp } from "firebase-admin/firestore";

type Data = Record<string, unknown>;

const isPlain = (v: unknown): v is Data =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

const transformName = (v: unknown) => (v && typeof v === "object" ? (v as object).constructor.name : "");

function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clone) as T;
  if (isPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) as T;
  if (Buffer.isBuffer(v)) return Buffer.from(v) as T;
  return v;
}

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Applies a value or FieldValue transform on top of the current one. Returns undefined for delete. */
function resolve(current: unknown, v: unknown): unknown {
  switch (transformName(v)) {
    case "ServerTimestampTransform":
      return Timestamp.now();
    case "DeleteTransform":
      return undefined;
    case "NumericIncrementTransform":
      return (typeof current === "number" ? current : 0) + (v as unknown as { operand: number }).operand;
    case "ArrayUnionTransform": {
      const out = Array.isArray(current) ? [...current] : [];
      for (const e of (v as unknown as { elements: unknown[] }).elements) if (!out.some((x) => equal(x, e))) out.push(e);
      return out;
    }
    case "ArrayRemoveTransform": {
      const rm = (v as unknown as { elements: unknown[] }).elements;
      return (Array.isArray(current) ? current : []).filter((x) => !rm.some((e) => equal(x, e)));
    }
  }
  if (isPlain(v)) return applyFields({}, v, false);
  return clone(v);
}

function applyFields(target: Data, patch: Data, merge: boolean): Data {
  for (const [k, v] of Object.entries(patch)) {
    if (merge && isPlain(v) && !transformName(v).endsWith("Transform")) {
      target[k] = applyFields(isPlain(target[k]) ? (target[k] as Data) : {}, v, true);
      continue;
    }
    const r = resolve(target[k], v);
    if (r === undefined) delete target[k];
    else target[k] = r;
  }
  return target;
}

function getPath(data: Data | undefined, path: string): unknown {
  let cur: unknown = data;
  for (const part of path.split(".")) {
    if (!isPlain(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

const fieldOf = (f: unknown) => (f && typeof f === "object" && "segments" in f ? (f as { segments: string[] }).segments.join(".") : String(f));

const comparable = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : v) as number | string;

class Snapshot {
  constructor(readonly ref: DocRef, private readonly stored: Data | undefined) {}
  get id() {
    return this.ref.id;
  }
  get exists() {
    return this.stored !== undefined;
  }
  data() {
    return this.stored === undefined ? undefined : clone(this.stored);
  }
  get(path: string) {
    return clone(getPath(this.stored, path));
  }
}

export class FakeFirestore {
  readonly docs = new Map<string, Data>();
  private lock: Promise<unknown> = Promise.resolve();

  collection(name: string) {
    return new CollectionRef(this, name);
  }

  async getAll(...refs: DocRef[]) {
    return refs.map((r) => r.snapshot());
  }

  batch() {
    const ops: (() => void)[] = [];
    const b = {
      set: (ref: DocRef, data: Data, opts?: { merge?: boolean }) => (ops.push(() => ref.write(data, !!opts?.merge)), b),
      update: (ref: DocRef, data: Data) => (ops.push(() => ref.patch(data)), b),
      delete: (ref: DocRef) => (ops.push(() => this.docs.delete(ref.path)), b),
      commit: async () => ops.forEach((op) => op()),
    };
    return b;
  }

  /** Transactions run one at a time; writes are applied when the function returns. */
  runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const run = this.lock.then(async () => {
      const ops: (() => void)[] = [];
      const tx = {
        get: async (ref: DocRef) => ref.snapshot(),
        set: (ref: DocRef, data: Data, opts?: { merge?: boolean }) => (ops.push(() => ref.write(data, !!opts?.merge)), tx),
        update: (ref: DocRef, data: Data) => (ops.push(() => ref.patch(data)), tx),
        delete: (ref: DocRef) => (ops.push(() => this.docs.delete(ref.path)), tx),
      };
      const result = await fn(tx);
      ops.forEach((op) => op());
      return result;
    });
    this.lock = run.catch(() => undefined);
    return run;
  }
}

class DocRef {
  constructor(readonly db: FakeFirestore, readonly path: string) {
    if (!path.split("/").every(Boolean)) throw new Error(`Invalid document path "${path}"`);
  }
  get id() {
    return this.path.split("/").pop()!;
  }
  collection(name: string) {
    return new CollectionRef(this.db, `${this.path}/${name}`);
  }
  snapshot() {
    return new Snapshot(this, this.db.docs.get(this.path));
  }
  async get() {
    return this.snapshot();
  }
  write(data: Data, merge: boolean) {
    const base = merge ? clone(this.db.docs.get(this.path) ?? {}) : {};
    this.db.docs.set(this.path, applyFields(base, data, merge));
  }
  patch(data: Data) {
    const existing = this.db.docs.get(this.path);
    if (!existing) throw Object.assign(new Error(`5 NOT_FOUND: No document to update: ${this.path}`), { code: 5 });
    this.db.docs.set(this.path, applyFields(clone(existing), data, false));
  }
  async set(data: Data, opts?: { merge?: boolean }) {
    this.write(data, !!opts?.merge);
  }
  async update(data: Data) {
    this.patch(data);
  }
  async delete() {
    this.db.docs.delete(this.path);
  }
}

type Filter = { field: string; op: string; value: unknown };

class Query {
  constructor(
    readonly db: FakeFirestore,
    readonly path: string,
    readonly filters: Filter[] = [],
    readonly order: { field: string; dir: string } | null = null,
    readonly max = Infinity,
  ) {}
  where(field: unknown, op: string, value: unknown) {
    return new Query(this.db, this.path, [...this.filters, { field: fieldOf(field), op, value }], this.order, this.max);
  }
  orderBy(field: string, dir = "asc") {
    return new Query(this.db, this.path, this.filters, { field, dir }, this.max);
  }
  limit(n: number) {
    return new Query(this.db, this.path, this.filters, this.order, n);
  }
  async get() {
    const depth = this.path.split("/").length + 1;
    let refs = [...this.db.docs.keys()]
      .filter((p) => p.startsWith(`${this.path}/`) && p.split("/").length === depth)
      .map((p) => new DocRef(this.db, p));
    const value = (r: DocRef, field: string) => (field === "__name__" ? r.id : getPath(this.db.docs.get(r.path), field));
    for (const f of this.filters) {
      refs = refs.filter((r) => {
        const v = value(r, f.field);
        switch (f.op) {
          case "==": return equal(v, f.value);
          case "array-contains": return Array.isArray(v) && v.some((x) => equal(x, f.value));
          case "in": return (f.value as unknown[]).some((x) => equal(x, v));
          case ">=": return v !== undefined && comparable(v) >= comparable(f.value);
          case "<=": return v !== undefined && comparable(v) <= comparable(f.value);
          default: throw new Error(`Unsupported operator ${f.op}`);
        }
      });
    }
    const order = this.order;
    refs.sort((a, b) => {
      const field = order?.field ?? "__name__";
      const x = comparable(value(a, field)), y = comparable(value(b, field));
      const c = x < y ? -1 : x > y ? 1 : 0;
      return order?.dir === "desc" ? -c : c;
    });
    if (order) refs = refs.filter((r) => value(r, order.field) !== undefined);
    const docs = refs.slice(0, this.max).map((r) => r.snapshot());
    return { docs, empty: docs.length === 0, size: docs.length };
  }
}

class CollectionRef extends Query {
  constructor(db: FakeFirestore, path: string) {
    super(db, path);
  }
  get id() {
    return this.path.split("/").pop()!;
  }
  doc(id?: string) {
    return new DocRef(this.db, `${this.path}/${id ?? randomBytes(10).toString("hex")}`);
  }
  async add(data: Data) {
    const ref = this.doc();
    ref.write(data, false);
    return ref;
  }
}
