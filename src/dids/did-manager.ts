import { createHash, randomBytes } from 'crypto';

export interface MidnightDIDConfig {
  seed: string;
  round: number;
}

export class DIDManager {
  private seed: Buffer;
  private round: number;

  constructor(config: MidnightDIDConfig) {
    this.seed = Buffer.from(config.seed, 'hex');
    this.round = config.round;
  }

  /**
   * Generates a unique, non-linkable public identifier for a given round.
   * This implements the "cracked" linkability pattern discussed in brainstorming.
   */
  public generatePublicIdentifier(context: string): string {
    const contextBuffer = Buffer.from(context, 'utf8');
    const roundBuffer = Buffer.allocUnsafe(4);
    roundBuffer.writeUInt32BE(this.round, 0);

    const hash = createHash('sha256')
      .update(contextBuffer)
      .update(roundBuffer)
      .update(this.seed)
      .digest();

    return `did:midnight:${hash.toString('hex').slice(0, 32)}`;
  }

  /**
   * Derives a persistent DID for the holder (to be used in registry).
   */
  public getPersistentDID(): string {
    const hash = createHash('sha256')
      .update(Buffer.from('midnight:did:persistent', 'utf8'))
      .update(this.seed)
      .digest();

    return `did:midnight:${hash.toString('hex').slice(0, 32)}`;
  }

  /**
   * Creates an entry hash for the State Commitment registry.
   */
  public createRegistryEntry(documentCommitment: string, controllerPkHash: string): string {
    const didHash = this.getPersistentDID().split(':')[2];
    
    return createHash('sha256')
      .update(Buffer.from(didHash, 'hex'))
      .update(Buffer.from(documentCommitment, 'hex'))
      .update(Buffer.from(controllerPkHash, 'hex'))
      .digest('hex');
  }

  public incrementRound(): void {
    this.round++;
  }

  public getRound(): number {
    return this.round;
  }
}
