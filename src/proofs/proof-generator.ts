import { createHash } from 'crypto';
import path from "path";
import fs from "fs";
import { firstValueFrom } from "rxjs";
import * as __compactRuntime from "@midnight-ntwrk/compact-runtime";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import {
  MidnightProviders,
  NetworkConfig,
} from "../providers/midnight-providers.js";
import { getAgeWitnesses } from "./witness-context.js";
import { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import {
  ZswapSecretKeys,
  DustSecretKey,
  proofDataIntoSerializedPreimage,
} from "@midnight-ntwrk/ledger-v8";
import { getNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { ShieldedAddress } from "@midnight-ntwrk/wallet-sdk-address-format";

export interface ZKProofInputs {
  public: Record<string, any>;
  private: Record<string, any>;
  proof?: string;
}

export class ProofGenerator {
  constructor(
    private wallet: WalletFacade,
    private networkConfig: NetworkConfig,
    private shieldedSecretKeys: ZswapSecretKeys,
    private dustSecretKey: DustSecretKey,
    private unshieldedKeystore: any,
    private seed: string,
  ) {}

  private async getContractInstance(
    name: string,
    witnessData: any,
  ): Promise<any> {
    const contractModulePath = path.join(
      process.cwd(),
      "contracts",
      "managed",
      name,
      "contract",
      "index.js",
    );
    const ContractModule = await import(`file://${contractModulePath}`);

    if (
      ContractModule.Contract.prototype &&
      !ContractModule.Contract.prototype.provableCircuits
    ) {
      Object.defineProperty(
        ContractModule.Contract.prototype,
        "provableCircuits",
        {
          get() {
            return this.circuits;
          },
          configurable: true,
        },
      );
    }

    const witnesses = getAgeWitnesses(() => witnessData);

    return (CompiledContract as any)
      .make(name, ContractModule.Contract)
      .pipe((CompiledContract as any).withWitnesses(witnesses));
  }

  private deriveVerifierAddress(): Uint8Array {
    const zkirPath = path.join(
      process.cwd(),
      "contracts",
      "managed",
      "proof-verifier",
      "zkir",
      "verifyAge.zkir",
    );

    if (!fs.existsSync(zkirPath)) {
      throw new Error(`Verifier circuit artifact not found at: ${zkirPath}`);
    }

    const zkirBinary = fs.readFileSync(zkirPath);
    return new Uint8Array(createHash("sha256").update(zkirBinary).digest());
  }

  public async generateAgeProof(
    dob: number,
    salt: Uint8Array,
    threshold: number,
    commitment: Uint8Array,
  ): Promise<any> {
    console.log(`\n🔄 Generating Zero-Knowledge Age Proof...`);
    console.log(
      `   (This initiates a recursive proof session and may take 10-30s)`,
    );

    const providers = await MidnightProviders.create({
      contractName: "proof-verifier",
      walletProvider: this.wallet,
      unshieldedKeystore: this.unshieldedKeystore,
      seed: this.seed,
      networkConfig: this.networkConfig,
      shieldedSecretKeys: this.shieldedSecretKeys,
      dustSecretKey: this.dustSecretKey,
    });

    const currentDate = parseInt(
      new Date().toISOString().slice(0, 10).replace(/-/g, ""),
    );
    const contractModulePath = path.join(
      process.cwd(),
      "contracts",
      "managed",
      "proof-verifier",
      "contract",
      "index.js",
    );
    const { Contract: ProofVerifierContract } = await import(
      `file://${contractModulePath}`
    );
    const witnesses = getAgeWitnesses(() => ({ dob, salt }));
    const contractInstance = new ProofVerifierContract(witnesses);

    //  convert to hex string to satisfy the createCircuitContext type (string)
    const verifierAddressBytes = this.deriveVerifierAddress();
    const verifierAddressHex =
      Buffer.from(verifierAddressBytes).toString("hex");

    // Get current state to initialize context
    const walletState = (await firstValueFrom(this.wallet.state())) as any;

    // Use the contract's own initialState() to generate the authoritative ledger state
    const initResult = contractInstance.initialState({
      initialPrivateState: walletState.privateState || {},
      initialZswapLocalState: {
        coinPublicKey: walletState.shielded.coinPublicKey,
      },
    });

    // Create circuit context using the derived address (hex) and the authoritative ledger
    const context = __compactRuntime.createCircuitContext(
      verifierAddressHex,
      walletState.shielded.coinPublicKey,
      initResult.currentContractState.data,
      walletState.privateState || {},
    );

    const circuitResults = contractInstance.circuits.verifyAge(
      context,
      BigInt(currentDate),
      BigInt(threshold),
      commitment,
    );

    const preimage = proofDataIntoSerializedPreimage(
      circuitResults.proofData.input,
      circuitResults.proofData.output,
      circuitResults.proofData.publicTranscript,
      circuitResults.proofData.privateTranscriptOutputs,
      "verifyAge",
    );

    const rawProof = await (providers as any).provingProvider.prove(
      preimage,
      "verifyAge",
    );

    const proofHex = Buffer.from(rawProof).toString("hex");
    const proof = `midnight:proof-preimage:${proofHex}`;

    console.log(`✅ ZK-Proof generated successfully!`);
    return proof;
  }

  public formatAsPresentation(proof: any, holderDID: string): any {
    const verifierAddressBytes = this.deriveVerifierAddress();

    const verifierIdentity = Buffer.from(verifierAddressBytes).toString("hex");

    return {
      "@context": ["https://www.w3.org/ns/credentials/v2"],
      verifiableCredential: [
        {
          "@context": [
            "https://www.w3.org/ns/credentials/v2",
            "https://www.w3.org/ns/credentials/examples/v2",
          ],
          type: ["VerifiableCredential", "AgeCredential"],
          issuer: `did:midnight:${verifierIdentity}`,
          id: `urn:uuid:${crypto.randomUUID()}`,
          proof,
        },
      ],
    };
  }
}
