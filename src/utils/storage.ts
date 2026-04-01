import {
  TransactionHistoryStorage,
  TransactionHistoryEntry,
  TransactionHash,
} from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
import { Level } from "level";
import path from "path";

const stringify = (obj: any) =>
  JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? `${v}n` : v));
const parse = (str: string) =>
  JSON.parse(str, (_, v) => {
    if (typeof v === "string" && /^-?\d+n$/.test(v))
      return BigInt(v.slice(0, -1));
    return v;
  });

/**
 * Persistent storage implementation for Midnight transaction history using LevelDB.
 * Handles serialization of BigInt and complex transaction objects.
 */
export class LevelDBHistoryStorage implements TransactionHistoryStorage {
  private db: Level<string, string>;

  constructor(dbPath: string) {
    this.db = new Level(dbPath);
  }

  /**
   * Persists a transaction history entry to the underlying LevelDB database.
   */
  async create(entry: TransactionHistoryEntry): Promise<void> {
    await this.db.put(`tx:${entry.hash}`, stringify(entry));
  }

  async delete(
    hash: TransactionHash,
  ): Promise<TransactionHistoryEntry | undefined> {
    const entry = await this.get(hash);
    if (entry) {
      await this.db.del(`tx:${hash}`);
    }
    return entry;
  }

  async get(
    hash: TransactionHash,
  ): Promise<TransactionHistoryEntry | undefined> {
    try {
      const data = await this.db.get(`tx:${hash}`);
      return parse(data);
    } catch (e: any) {
      if (e.code === "LEVEL_NOT_FOUND") return undefined;
      throw e;
    }
  }

  async *getAll(): AsyncIterableIterator<TransactionHistoryEntry> {
    for await (const [key, value] of this.db.iterator({ gt: "tx:" })) {
      if (!key.startsWith("tx:")) break;
      yield parse(value);
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

/**
 * Initializes and returns a persistent storage instance for the specified wallet prefix.
 */
export function getPersistentStorage(prefix: string = "default") {
  const dbPath = path.join(process.cwd(), ".midnight-data", prefix, "history");
  return new LevelDBHistoryStorage(dbPath);
}
