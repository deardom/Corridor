// Tamper-evident audit log. Every entry carries the SHA-256 of the previous entry,
// so editing or deleting any past line breaks the chain and `verify()` reports where.
import { sha256 } from "./util.js";

export class AuditLog {
  constructor({ clock } = {}) {
    this.entries = [];
    this.clock = clock || (() => new Date().toISOString());
  }

  append(actor, type, data = {}) {
    const prevHash = this.entries.length ? this.entries[this.entries.length - 1].hash : "GENESIS";
    // Deep-copy so later changes to live objects can never alter a logged entry.
    data = JSON.parse(JSON.stringify(data ?? {}));
    const entry = { seq: this.entries.length + 1, ts: this.clock(), actor, type, data, prevHash };
    entry.hash = sha256(prevHash + "|" + JSON.stringify({ seq: entry.seq, ts: entry.ts, actor, type, data }));
    this.entries.push(entry);
    return entry;
  }

  verify() {
    let prev = "GENESIS";
    for (const e of this.entries) {
      const expected = sha256(prev + "|" + JSON.stringify({ seq: e.seq, ts: e.ts, actor: e.actor, type: e.type, data: e.data }));
      if (e.prevHash !== prev || e.hash !== expected) return { ok: false, brokenAt: e.seq };
      prev = e.hash;
    }
    return { ok: true, length: this.entries.length, head: prev };
  }

  toJSONL() {
    return this.entries.map((e) => JSON.stringify(e)).join("\n") + (this.entries.length ? "\n" : "");
  }
}
