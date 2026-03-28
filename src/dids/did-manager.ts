import { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import { MidnightProviders, NetworkConfig } from "../providers/midnight-providers.js";
import { deployContract, findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { ZswapSecretKeys, DustSecretKey } from "@midnight-ntwrk/ledger-v8";
import { createHash, randomBytes } from 'crypto';
import path from 'path';
import fs from 'fs';

export class DIDManager {
  private encryptionPublicKey: Uint8Array;

  constructor(
    private wallet: WalletFacade,
    private networkConfig: NetworkConfig,
    encPk: string | Uint8Array,
    private shieldedSecretKeys: ZswapSecretKeys,
    private dustSecretKey: DustSecretKey,
    private unshieldedKeystore: any,
    private seed: string
  ) {
    this.encryptionPublicKey = typeof encPk === 'string' ? Buffer.from(encPk, 'hex') : encPk;
  }

  private async getContractInstance(name: string) {
    const contractModulePath = path.join(
      process.cwd(),
      "contracts",
      "managed",
      name,
      "contract",
      "index.js"
    );
    const ContractModule = await import(`file://${contractModulePath}`);
    
    // SHIM: SDK v4 compact-js expects 'provableCircuits' but compactc 0.5.0 generates 'circuits'
    if (ContractModule.Contract.prototype && !ContractModule.Contract.prototype.provableCircuits) {
      Object.defineProperty(ContractModule.Contract.prototype, 'provableCircuits', {
        get() { return this.circuits; },
        configurable: true
      });
    }
    
    const witnesses = {
      controller_secret_key: () => (this.shieldedSecretKeys as any).coinSecretKey.yesIKnowTheSecurityImplicationsOfThis_taggedSerialize(),
      issuer_secret_key: () => (this.shieldedSecretKeys as any).coinSecretKey.yesIKnowTheSecurityImplicationsOfThis_taggedSerialize(),
    };
    
    return new ContractModule.Contract(witnesses);
  }

  private async getProviders(name: string) {
    return await MidnightProviders.create({
      contractName: name,
      walletProvider: this.wallet,
      unshieldedKeystore: this.unshieldedKeystore,
      seed: this.seed,
      networkConfig: this.networkConfig,
      shieldedSecretKeys: this.shieldedSecretKeys,
      dustSecretKey: this.dustSecretKey
    });
  }

  private deriveDIDHash(name: string): Uint8Array {
    return createHash('sha256').update(name).digest();
  }

  public async registerDID(name: string): Promise<void> {
    const didHash = this.deriveDIDHash(name);
    const docCommitment = createHash('sha256').update(`initial-doc-for-${name}`).digest();
    
    console.log(`Registering DID: ${name} (${Buffer.from(didHash).toString('hex')})`);
    
    const providers = await this.getProviders("did-registry");
    const contract = await this.getContractInstance("did-registry");
    
    const deployment = JSON.parse(fs.readFileSync('deployment.json', 'utf8'));
    const address = deployment.contracts['did-registry'];
    
    const found = await findDeployedContract(providers, {
      contractAddress: address,
      compiledContract: contract
    });

    await (found.callTx as any).registerDID(didHash, docCommitment, this.encryptionPublicKey);
    console.log(`✅ DID ${name} registered successfully!`);
  }

  public async updateDID(name: string, newDoc: string): Promise<void> {
    const didHash = this.deriveDIDHash(name);
    const newDocCommitment = createHash('sha256').update(newDoc).digest();

    console.log(`Updating DID: ${name}...`);
    
    const providers = await this.getProviders("did-registry");
    const contract = await this.getContractInstance("did-registry");
    
    const deployment = JSON.parse(fs.readFileSync('deployment.json', 'utf8'));
    const address = deployment.contracts['did-registry'];
    
    const found = await findDeployedContract(providers, {
      contractAddress: address,
      compiledContract: contract
    });

    await (found.callTx as any).updateDocument(didHash, newDocCommitment);
    console.log(`✅ DID ${name} updated successfully!`);
  }

  public async issueCredential(holderDIDName: string, dob: number): Promise<void> {
    const holderDIDHash = this.deriveDIDHash(holderDIDName);
    const schemaId = createHash('sha256').update('age-schema-v1').digest();
    const salt = randomBytes(32);
    const credentialCommitment = createHash('sha256')
      .update(Buffer.alloc(4, dob))
      .update(salt)
      .digest();
    
    console.log(`Issuing credential for ${holderDIDName}...`);
    
    const providers = await this.getProviders("credential-issuer");
    const contract = await this.getContractInstance("credential-issuer");
    
    const deployment = JSON.parse(fs.readFileSync('deployment.json', 'utf8'));
    const address = deployment.contracts['credential-issuer'];
    
    const found = await findDeployedContract(providers, {
      contractAddress: address,
      compiledContract: contract
    });

    await (found.callTx as any).issueCredential(holderDIDHash, schemaId, credentialCommitment, this.encryptionPublicKey);
    console.log(`✅ Credential issued successfully!`);
    
    const storagePath = 'credentials.json';
    const storage = fs.existsSync(storagePath) ? JSON.parse(fs.readFileSync(storagePath, 'utf8')) : {};
    storage[holderDIDName] = { dob, salt: salt.toString('hex'), commitment: credentialCommitment.toString('hex') };
    fs.writeFileSync(storagePath, JSON.stringify(storage, null, 2));
  }

  public async verifyAge(dob: number, threshold: number): Promise<void> {
    console.log(`Verifying age proof (Threshold: ${threshold})...`);
    
    const providers = await this.getProviders("proof-verifier");
    const contract = await this.getContractInstance("proof-verifier");
    
    const deployment = JSON.parse(fs.readFileSync('deployment.json', 'utf8'));
    const address = deployment.contracts['proof-verifier'];
    
    const found = await findDeployedContract(providers, {
      contractAddress: address,
      compiledContract: contract
    });

    const currentDate = parseInt(new Date().toISOString().slice(0, 10).replace(/-/g, ''));
    
    const storage = fs.existsSync('credentials.json') ? JSON.parse(fs.readFileSync('credentials.json', 'utf8')) : {};
    const cred = Object.values(storage).find((c: any) => c.dob === dob) as any;
    
    if (!cred) throw new Error("No matching credential found locally for this DOB");

    await (found.callTx as any).verifyAge(currentDate, threshold, Buffer.from(cred.commitment, 'hex'));
    console.log(`✅ Age verification successful! User is over ${threshold}.`);
  }
}
