/**
 * Worker-compatible in-memory filesystem for isomorphic-git, based on the
 * Cloudflare Artifacts isomorphic-git example. Provides the `fs.promises`
 * surface isomorphic-git requires; symlinks are not supported because
 * capsule trees never contain them.
 */

type Entry =
  | { kind: "dir"; children: Set<string>; mtimeMs: number }
  | { kind: "file"; data: Uint8Array; mtimeMs: number };

class MemoryStats {
  constructor(private readonly entry: Entry) {}

  get size(): number {
    return this.entry.kind === "file" ? this.entry.data.byteLength : 0;
  }

  get mtimeMs(): number {
    return this.entry.mtimeMs;
  }

  get ctimeMs(): number {
    return this.entry.mtimeMs;
  }

  get mode(): number {
    return this.entry.kind === "file" ? 0o100644 : 0o040000;
  }

  isFile(): boolean {
    return this.entry.kind === "file";
  }

  isDirectory(): boolean {
    return this.entry.kind === "dir";
  }

  isSymbolicLink(): boolean {
    return false;
  }
}

export class MemoryFS {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private readonly entries = new Map<string, Entry>([
    ["/", { kind: "dir", children: new Set<string>(), mtimeMs: Date.now() }],
  ]);

  readonly promises = {
    readFile: this.readFile.bind(this),
    writeFile: this.writeFile.bind(this),
    unlink: this.unlink.bind(this),
    readdir: this.readdir.bind(this),
    mkdir: this.mkdir.bind(this),
    rmdir: this.rmdir.bind(this),
    stat: this.stat.bind(this),
    lstat: this.lstat.bind(this),
    readlink: this.readlink.bind(this),
    symlink: this.symlink.bind(this),
  };

  private normalize(input: string): string {
    const segments: string[] = [];
    for (const part of input.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        segments.pop();
        continue;
      }
      segments.push(part);
    }
    return segments.length > 0 ? `/${segments.join("/")}` : "/";
  }

  private parent(path: string): string {
    const normalized = this.normalize(path);
    if (normalized === "/") return "/";
    const parts = normalized.split("/").filter(Boolean);
    parts.pop();
    return parts.length > 0 ? `/${parts.join("/")}` : "/";
  }

  private basename(path: string): string {
    return this.normalize(path).split("/").filter(Boolean).pop() ?? "";
  }

  private requireEntry(path: string): Entry {
    const entry = this.entries.get(this.normalize(path));
    if (!entry) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    }
    return entry;
  }

  private requireDir(path: string): Extract<Entry, { kind: "dir" }> {
    const entry = this.requireEntry(path);
    if (entry.kind !== "dir") {
      throw Object.assign(new Error(`ENOTDIR: ${path}`), { code: "ENOTDIR" });
    }
    return entry;
  }

  async mkdir(
    path: string,
    options?: { recursive?: boolean } | number,
  ): Promise<void> {
    const target = this.normalize(path);
    if (target === "/") return;
    const recursive =
      typeof options === "object" && options !== null && options.recursive;
    const parent = this.parent(target);
    if (!this.entries.has(parent)) {
      if (!recursive) {
        throw Object.assign(new Error(`ENOENT: ${parent}`), { code: "ENOENT" });
      }
      await this.mkdir(parent, { recursive: true });
    }
    if (this.entries.has(target)) return;
    this.entries.set(target, {
      kind: "dir",
      children: new Set(),
      mtimeMs: Date.now(),
    });
    this.requireDir(parent).children.add(this.basename(target));
  }

  async writeFile(
    path: string,
    data: string | Uint8Array | ArrayBuffer,
  ): Promise<void> {
    const target = this.normalize(path);
    await this.mkdir(this.parent(target), { recursive: true });
    const bytes =
      typeof data === "string"
        ? this.encoder.encode(data)
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data);
    this.entries.set(target, {
      kind: "file",
      data: bytes,
      mtimeMs: Date.now(),
    });
    this.requireDir(this.parent(target)).children.add(this.basename(target));
  }

  async readFile(
    path: string,
    options?: string | { encoding?: string },
  ): Promise<Uint8Array | string> {
    const entry = this.requireEntry(path);
    if (entry.kind !== "file") {
      throw Object.assign(new Error(`EISDIR: ${path}`), { code: "EISDIR" });
    }
    const encoding = typeof options === "string" ? options : options?.encoding;
    return encoding ? this.decoder.decode(entry.data) : entry.data;
  }

  async readdir(path: string): Promise<string[]> {
    return [...this.requireDir(path).children].sort();
  }

  async unlink(path: string): Promise<void> {
    const target = this.normalize(path);
    const entry = this.requireEntry(target);
    if (entry.kind !== "file") {
      throw Object.assign(new Error(`EISDIR: ${path}`), { code: "EISDIR" });
    }
    this.entries.delete(target);
    this.requireDir(this.parent(target)).children.delete(this.basename(target));
  }

  async rmdir(path: string): Promise<void> {
    const target = this.normalize(path);
    const entry = this.requireDir(target);
    if (entry.children.size > 0) {
      throw Object.assign(new Error(`ENOTEMPTY: ${path}`), {
        code: "ENOTEMPTY",
      });
    }
    this.entries.delete(target);
    this.requireDir(this.parent(target)).children.delete(this.basename(target));
  }

  async stat(path: string): Promise<MemoryStats> {
    return new MemoryStats(this.requireEntry(path));
  }

  async lstat(path: string): Promise<MemoryStats> {
    return this.stat(path);
  }

  async readlink(path: string): Promise<never> {
    throw Object.assign(new Error(`EINVAL: not a symlink: ${path}`), {
      code: "EINVAL",
    });
  }

  async symlink(_target: string, path: string): Promise<never> {
    throw Object.assign(
      new Error(`ENOSYS: symlinks are not supported: ${path}`),
      { code: "ENOSYS" },
    );
  }
}
