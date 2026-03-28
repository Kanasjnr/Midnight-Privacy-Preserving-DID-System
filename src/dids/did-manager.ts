import { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import { MidnightProviders, NetworkConfig } from "../providers/midnight-providers.js";
import { findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { ZswapSecretKeys, DustSecretKey } from "@midnight-ntwrk/ledger-v8";
import {
  persistentHash,
  CompactTypeBytes,
  CompactTypeVector,
  upgradeFromTransient,
} from "@midnight-ntwrk/compact-runtime";
import { createHash, randomBytes } from 'crypto';
import path from 'path';
import fs from 'fs';

export class DIDManager {
  private encryptionPublicKey: Uint8Array;
  private currentProofData: { dob: number; salt: Uint8Array } | null = null;

  constructor(
    private wallet: WalletFacade,
    private networkConfig: NetworkConfig,
    encPk: any,
    private shieldedSecretKeys: ZswapSecretKeys,
    private dustSecretKey: DustSecretKey,
    private unshieldedKeystore: any,
    private seed: string,
  ) {
    if (encPk && encPk.data) {
      this.encryptionPublicKey = encPk.data;
    } else {
      this.encryptionPublicKey =
        typeof encPk === "string" ? Buffer.from(encPk, "hex") : encPk;
    }
  }

  private deriveCompactPk(sk: Uint8Array): Uint8Array {
    const bytes32 = new CompactTypeBytes(32);
    const vector2 = new CompactTypeVector(2, bytes32);
    const prefix = new Uint8Array([
      109, 105, 100, 110, 105, 103, 104, 116, 58, 112, 107, 58, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    return persistentHash(vector2, [prefix, sk]);
  }

  private deriveCredentialCommitment(
    dob: number,
    salt: Uint8Array,
  ): Uint8Array {
    const bytes32 = new CompactTypeBytes(32);
    const vector2 = new CompactTypeVector(2, bytes32);

    const dobBytes = upgradeFromTransient(BigInt(dob));

    return persistentHash(vector2, [dobBytes, salt]);
  }

  private async getContractInstance(name: string): Promise<any> {
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

    const witnesses = {
      controller_secret_key: (context: any) => {
        const fullKey = (
          this.shieldedSecretKeys as any
        ).coinSecretKey.yesIKnowTheSecurityImplicationsOfThis_serialize();
        const rawKey = fullKey.slice(-32);
        console.log(
          `[WITNESS] controller_secret_key called. Slicing to 32 bytes.`,
        );
        return [context, rawKey];
      },
      creator_secret_key: (context: any) => {
        const fullKey = (
          this.shieldedSecretKeys as any
        ).coinSecretKey.yesIKnowTheSecurityImplicationsOfThis_serialize();
        const rawKey = fullKey.slice(-32);
        return [context, rawKey];
      },
      issuer_secret_key: (context: any) => {
        const fullKey = (
          this.shieldedSecretKeys as any
        ).coinSecretKey.yesIKnowTheSecurityImplicationsOfThis_serialize();
        const rawKey = fullKey.slice(-32);
        return [context, rawKey];
      },
      dateOfBirth: (context: any) => {
        if (!this.currentProofData)
          throw new Error("No proof data available for witness");
        return [context, BigInt(this.currentProofData.dob)];
      },
      salt: (context: any) => {
        if (!this.currentProofData)
          throw new Error("No proof data available for witness");
        return [context, this.currentProofData.salt];
      },
    };

    return (CompiledContract as any)
      .make(name, ContractModule.Contract)
      .pipe((CompiledContract as any).withWitnesses(witnesses));
  }

  private async getProviders(name: string) {
    return await MidnightProviders.create({
      contractName: name,
      walletProvider: this.wallet,
      unshieldedKeystore: this.unshieldedKeystore,
      seed: this.seed,
      networkConfig: this.networkConfig,
      shieldedSecretKeys: this.shieldedSecretKeys,
      dustSecretKey: this.dustSecretKey,
    });
  }

  private deriveDIDHash(name: string): Uint8Array {
    return createHash("sha256").update(name).digest();
  }

  public async registerDID(name: string): Promise<void> {
    const didHash = this.deriveDIDHash(name);
    const docCommitment = createHash("sha256")
      .update(`initial-doc-for-${name}`)
      .digest();

    console.log(
      `Registering DID: ${name} (${Buffer.from(didHash).toString("hex")})`,
    );

    const providers = await this.getProviders("did-registry");
    const contract = await this.getContractInstance("did-registry");

    const deployment = JSON.parse(fs.readFileSync("deployment.json", "utf8"));
    const address = deployment.contracts["did-registry"];

    // Derive PK using the SAME logic as the contract: persistentHash(["midnight:pk:", sk])
    const fullKey = (
      this.shieldedSecretKeys as any
    ).coinSecretKey.yesIKnowTheSecurityImplicationsOfThis_serialize();
    const rawSk = fullKey.slice(-32);
    const compactPk = this.deriveCompactPk(rawSk);

    const found = await findDeployedContract(providers, {
      contractAddress: address,
      compiledContract: contract,
    });

    await (found.callTx as any).registerDID(didHash, docCommitment, compactPk);
    console.log(`✅ DID ${name} registered successfully!`);
  }

  public async updateDID(name: string, newDoc: string): Promise<void> {
    const didHash = this.deriveDIDHash(name);
    const newDocCommitment = createHash("sha256").update(newDoc).digest();

    console.log(`Updating DID: ${name}...`);

    const providers = await this.getProviders("did-registry");
    const contract = await this.getContractInstance("did-registry");

    const deployment = JSON.parse(fs.readFileSync("deployment.json", "utf8"));
    const address = deployment.contracts["did-registry"];

    const found = await findDeployedContract(providers, {
      contractAddress: address,
      compiledContract: contract,
    });

    await (found.callTx as any).updateDocument(didHash, newDocCommitment);
    console.log(`✅ DID ${name} updated successfully!`);
  }

  public async issueCredential(
    holderDIDName: string,
    dob: number,
  ): Promise<void> {
    const holderDIDHash = this.deriveDIDHash(holderDIDName);
    const schemaId = createHash("sha256").update("age-schema-v1").digest();
    const salt = randomBytes(32);

    // Align with contract: persistentHash<Vector<2, Bytes<32>>>([ (dob as Field) as Bytes<32>, s ])
    const credentialCommitment = this.deriveCredentialCommitment(dob, salt);

    console.log(`Issuing credential for ${holderDIDName}...`);

    const providers = await this.getProviders("credential-issuer");
    const contract = await this.getContractInstance("credential-issuer");

    const deployment = JSON.parse(fs.readFileSync("deployment.json", "utf8"));
    const address = deployment.contracts["credential-issuer"];

    const found = await findDeployedContract(providers, {
      contractAddress: address,
      compiledContract: contract,
    });

    await (found.callTx as any).issueCredential(
      holderDIDHash,
      schemaId,
      credentialCommitment,
      this.encryptionPublicKey,
    );
    console.log(`✅ Credential issued successfully!`);

    const storagePath = "credentials.json";
    const storage = fs.existsSync(storagePath)
      ? JSON.parse(fs.readFileSync(storagePath, "utf8"))
      : {};
    storage[holderDIDName] = {
      dob,
      salt: Buffer.from(salt).toString("hex"),
      commitment: Buffer.from(credentialCommitment).toString("hex"),
    };
    fs.writeFileSync(storagePath, JSON.stringify(storage, null, 2));
  }

  public async verifyAge(didName: string, dob: number, threshold: number): Promise<void> {
    console.log(`Verifying age proof for '${didName}' (Threshold: ${threshold} years)...`);

    const providers = await this.getProviders("proof-verifier");
    const contract = await this.getContractInstance("proof-verifier");

    const deployment = JSON.parse(fs.readFileSync("deployment.json", "utf8"));
    const address = deployment.contracts["proof-verifier"];

    const found = await findDeployedContract(providers, {
      contractAddress: address,
      compiledContract: contract,
    });

    const currentDate = parseInt(
      new Date().toISOString().slice(0, 10).replace(/-/g, ""),
    );

    const storage = fs.existsSync('credentials.json') ? JSON.parse(fs.readFileSync('credentials.json', 'utf8')) : {};
    const cred = storage[didName];
    
    if (!cred) throw new Error(`No credential found for DID '${didName}'. Register it first.`);
    if (cred.dob !== dob) throw new Error(`DOB mismatch for '${didName}': expected ${dob}, found ${cred.dob}`);

    this.currentProofData = {
      dob: cred.dob,
      salt: Buffer.from(cred.salt, "hex"),
    };

    await (found.callTx as any).verifyAge(
      BigInt(currentDate),
      BigInt(threshold),
      Buffer.from(cred.commitment, "hex"),
    );
    console.log(
      `✅ Age verification successful! User is over ${threshold} years old.`,
    );

    this.currentProofData = null;
  }
}
