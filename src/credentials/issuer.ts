import { createHash, randomBytes } from 'crypto';
import { DIDManager } from '../dids/did-manager.js';

export interface CredentialData {
  subject: string;
  claims: Record<string, any>;
  schemaId: string;
}

export class CredentialIssuer {
  private issuerDID: string;

  constructor(issuerDID: string) {
    this.issuerDID = issuerDID;
  }

  /**
   * Creates a credential commitment (Merkle root).
   * Each attribute is hashed with a unique salt to ensure zero-knowledge.
   */
  public createCredentialCommitment(data: CredentialData): {
    root: string;
    salts: Record<string, string>;
  } {
    const salts: Record<string, string> = {};
    const leaves: Buffer[] = [];

    for (const [key, value] of Object.entries(data.claims)) {
      const salt = randomBytes(32).toString("hex");
      salts[key] = salt;

      const leafHash = createHash("sha256")
        .update(Buffer.from(key, "utf8"))
        .update(Buffer.from(String(value), "utf8"))
        .update(Buffer.from(salt, "hex"))
        .digest();

      leaves.push(leafHash);
    }

    // Simplified Merkle root
    const rootHash = createHash("sha256");
    leaves.forEach((leaf) => rootHash.update(leaf));

    return {
      root: rootHash.digest("hex"),
      salts,
    };
  }

  /**
   * Creates an entry hash for the State Commitment ledger.
   */
  public createIssuanceEntry(
    holderDidCommitment: string,
    schemaId: string,
    credentialHash: string,
  ): string {
    const entryHash = createHash("sha256")
      .update(Buffer.from(holderDidCommitment, "hex"))
      .update(Buffer.from(schemaId, "hex"))
      .update(Buffer.from(credentialHash, "hex"))
      .digest("hex");

    return entryHash;
  }

  /**
   * Signs a credential
   */
  public signCredential(root: string, privateKey: Buffer): string {
    return createHash("sha256")
      .update(Buffer.from(root, "hex"))
      .update(privateKey)
      .digest("hex");
  }
}
