import { createHash } from 'crypto';

export interface DIDDocument {
  did: string;
  commitment: string;
  controller: string;
}

export class DIDResolver {
  /**
   * Reconstructs the registry state from a history of events.
   * This matches the State Commitment logic in did-registry.compact.
   */
  public static computeStateRoot(entries: DIDDocument[]): string {
    let currentState = "00".repeat(32); // Initial state is all zeros

    for (const entry of entries) {
      const entryHash = createHash("sha256")
        .update(Buffer.from(entry.did.split(":")[2], "hex"))
        .update(Buffer.from(entry.commitment, "hex"))
        .update(Buffer.from(entry.controller, "hex"))
        .digest("hex");

      currentState = createHash("sha256")
        .update(Buffer.from(currentState, "hex"))
        .update(Buffer.from(entryHash, "hex"))
        .digest("hex");
    }

    return currentState;
  }

  /**
   * Resolves a DID from a list of documents.
   */
  public static resolve(
    did: string,
    history: DIDDocument[],
  ): DIDDocument | null {
    const matching = history.filter((d) => d.did === did);
    return matching.length > 0 ? matching[matching.length - 1] : null;
  }
}
