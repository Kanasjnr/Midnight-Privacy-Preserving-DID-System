import { CompactTypeBytes, upgradeFromTransient } from "@midnight-ntwrk/compact-runtime";

export interface WitnessData {
  dob: number;
  salt: Uint8Array;
}

/**
 * Shared Witness Logic for the verifyAge circuit.
 * Uses a deferred provider pattern to ensure data is resolved at proof generation time.
 */
export const getAgeWitnesses = (dataProvider: () => WitnessData | null) => ({
  dateOfBirth: (context: any) => {
    const data = dataProvider();
    if (!data) throw new Error("No witness data provided for dateOfBirth");
    return [context, BigInt(data.dob)];
  },
  salt: (context: any) => {
    const data = dataProvider();
    if (!data) throw new Error("No witness data provided for salt");
    return [context, data.salt];
  }
});

/**
 * Common Witness for all controller-owned operations.
 */
export const getControllerWitness = (shieldedSecretKeys: any) => ({
  controller_secret_key: (context: any) => {
    const fullKey = shieldedSecretKeys.coinSecretKey.yesIKnowTheSecurityImplicationsOfThis_serialize();
    const rawKey = fullKey.slice(-32);
    return [context, rawKey];
  }
});
