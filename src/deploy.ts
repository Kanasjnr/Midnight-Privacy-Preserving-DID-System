import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import chalk from 'chalk';
import * as Rx from 'rxjs';
import { Buffer } from 'buffer';
import { 
    createKeystore, 
    PublicKey, 
    UnshieldedWallet,
    InMemoryTransactionHistoryStorage
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { 
    DustSecretKey, 
    ZswapSecretKeys, 
    LedgerParameters 
} from '@midnight-ntwrk/ledger-v8';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { WebSocket } from 'ws';
import 'dotenv/config';
import { EnvironmentManager } from './utils/environment.js';
import { MidnightProviders } from './providers/midnight-providers.js';
import { initializePolyfills } from "./utils/polyfills.js";

/**
 * Initializes required SDK polyfills for environment compatibility.
 */
initializePolyfills();

const networkConfig = EnvironmentManager.getNetworkConfig();
setNetworkId(networkConfig.name.toLowerCase() as any);

/**
 * Applies a compatibility patch to the Contract class to ensure 'provableCircuits' 
 * resolution during the deployment phase.
 */
function patchContract(ContractClass: any) {
    if (ContractClass && ContractClass.prototype && !Object.getOwnPropertyDescriptor(ContractClass.prototype, 'provableCircuits')) {
        Object.defineProperty(ContractClass.prototype, 'provableCircuits', {
            get() { return this.circuits; },
            enumerable: true,
            configurable: true
        });
    }
}

/**
 * Derives actor keys (Zswap, NightExternal, Dust) from a wallet seed.
 */
function deriveKeys(seed: string) {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seed, "hex"));
  if (hdWallet.type !== "seedOk") throw new Error("Invalid seed");
  const result = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (result.type !== "keysDerived") throw new Error("Key derivation failed");
  hdWallet.hdWallet.clear();
  return result.keys;
}

/**
 * Loads a compiled Compact contract and attaches specified witnesses or vacancies.
 */
async function loadContract(name: string, witnesses: any = null) {
    const zkConfigPath = path.resolve(process.cwd(), 'contracts', 'managed', name);
    const contractPath = path.join(zkConfigPath, 'contract', 'index.js');
    const mod = await import(pathToFileURL(contractPath).href);
    
    // Apply compatibility patch
    patchContract(mod.Contract);
    
    let contractWithWitnesses;
    if (witnesses) {
      contractWithWitnesses = (CompiledContract.withWitnesses as any)(witnesses);
    } else {
      contractWithWitnesses = CompiledContract.withVacantWitnesses;
    }
    return CompiledContract.make(name, mod.Contract).pipe(
        contractWithWitnesses as any,
        (CompiledContract.withCompiledFileAssets as any)(zkConfigPath)
    );
}

async function main() {
  console.log();
  console.log(chalk.blue.bold("━".repeat(60)));
  console.log(chalk.blue.bold("🌙  Midnight DID System Deployment"));
  console.log(chalk.blue.bold("━".repeat(60)));

  try {
    EnvironmentManager.validateEnvironment();

    const walletSeed = process.env.WALLET_SEED!;
    const keys = deriveKeys(walletSeed);
    const networkId = getNetworkId();
    
    const shieldedSecretKeys = ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
    const dustSecretKey = DustSecretKey.fromSeed(keys[Roles.Dust]);
    const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], networkId);
    const publicKeyObj = PublicKey.fromKeyStore(unshieldedKeystore);

    const wallet = await WalletFacade.init({
      configuration: {
        networkId,
        indexerClientConnection: {
          indexerHttpUrl: networkConfig.indexer,
          indexerWsUrl: networkConfig.indexerWS,
        },
        relayURL: new URL(networkConfig.node.replace(/^http/, "ws")),
        provingServerUrl: new URL(networkConfig.proofServer),
        txHistoryStorage: new InMemoryTransactionHistoryStorage(),
        costParameters: {
          additionalFeeOverhead: 300_000_000_000_000n,
          feeBlocksMargin: 5,
        },
      },
      shielded: (config: any) =>
        ShieldedWallet(config).startWithSecretKeys(shieldedSecretKeys),
      unshielded: (config: any) =>
        UnshieldedWallet(config).startWithPublicKey(publicKeyObj),
      dust: (config: any) =>
        DustWallet(config).startWithSecretKey(dustSecretKey, LedgerParameters.initialParameters().dust),
    });

    console.log(chalk.cyan("🔄 Initializing wallet synchronization..."));
    await wallet.start(shieldedSecretKeys, dustSecretKey);

    await Rx.firstValueFrom(
      wallet.state().pipe(
        Rx.throttleTime(1000),
        Rx.tap((s: any) => {
          const u = s.unshielded.state.progress;
          const sh = s.shielded.state.progress;
          process.stdout.write(`\r[SYNC] U:${u.appliedId}/${u.highestTransactionId} S:${sh.appliedId}/${sh.highestTransactionId} | isSynced: ${s.isSynced}   `);
        }),
        Rx.filter((s: any) => s.isSynced),
        Rx.take(1)
      )
    );
    console.log(chalk.green("\n✅ Wallets synchronized!"));

    const deploymentInfo: any = { network: networkConfig.name, contracts: {} };

    // 1. DID Registry
    console.log(chalk.yellow("\n🚀 Deploying did-registry..."));
    const providers = await MidnightProviders.create({
        contractName: "did-registry",
        walletProvider: wallet,
        unshieldedKeystore: unshieldedKeystore,
        seed: walletSeed,
        networkConfig,
        shieldedSecretKeys,
        dustSecretKey
    });
    const didRegistry = await loadContract("did-registry", {
        controller_secret_key: () => new Uint8Array(32),
    });
    const deployedDID = await (deployContract as any)(providers, {
        compiledContract: didRegistry,
        privateStateId: "didRegistryPrivateState",
        initialPrivateState: {},
    });
    deploymentInfo.contracts["did-registry"] = deployedDID.deployTxData.public.contractAddress;
    console.log(chalk.green(`   ✅ deployed at: ${deploymentInfo.contracts["did-registry"]}`));

    // 2. Schema Registry
    console.log(chalk.yellow("\n🚀 Deploying schema-registry..."));
    const providersSchema = await MidnightProviders.create({
        contractName: "schema-registry",
        walletProvider: wallet,
        unshieldedKeystore: unshieldedKeystore,
        seed: walletSeed,
        networkConfig,
        shieldedSecretKeys,
        dustSecretKey
    });
    const schemaRegistry = await loadContract("schema-registry", {
        creator_secret_key: () => new Uint8Array(32),
    });
    const deployedSchema = await (deployContract as any)(providersSchema, {
        compiledContract: schemaRegistry,
        privateStateId: "schemaRegistryPrivateState",
        initialPrivateState: {},
    });
    deploymentInfo.contracts["schema-registry"] = deployedSchema.deployTxData.public.contractAddress;
    console.log(chalk.green(`   ✅ deployed at: ${deploymentInfo.contracts["schema-registry"]}`));

    // 3. Credential Issuer
    console.log(chalk.yellow("\n🚀 Deploying credential-issuer..."));
    const providersIssuer = await MidnightProviders.create({
        contractName: "credential-issuer",
        walletProvider: wallet,
        unshieldedKeystore: unshieldedKeystore,
        seed: walletSeed,
        networkConfig,
        shieldedSecretKeys,
        dustSecretKey
    });
    const credentialIssuer = await loadContract("credential-issuer", {
        issuer_secret_key: () => new Uint8Array(32),
    });
    const deployedIssuer = await (deployContract as any)(providersIssuer, {
        compiledContract: credentialIssuer,
        privateStateId: "credentialIssuerPrivateState",
        initialPrivateState: {},
    });
    deploymentInfo.contracts["credential-issuer"] = deployedIssuer.deployTxData.public.contractAddress;
    console.log(chalk.green(`   ✅ deployed at: ${deploymentInfo.contracts["credential-issuer"]}`));

    // 4. Proof Verifier
    console.log(chalk.yellow("\n🚀 Deploying proof-verifier..."));
    const providersVerifier = await MidnightProviders.create({
        contractName: "proof-verifier",
        walletProvider: wallet,
        unshieldedKeystore: unshieldedKeystore,
        seed: walletSeed,
        networkConfig,
        shieldedSecretKeys,
        dustSecretKey
    });
    const proofVerifier = await loadContract("proof-verifier", {
        dateOfBirth: () => 20000101n, // YYYYMMDD as BigInt
        salt: () => new Uint8Array(32),
    });
    const deployedVerifier = await (deployContract as any)(providersVerifier, {
        compiledContract: proofVerifier,
        privateStateId: "proofVerifierPrivateState",
        initialPrivateState: {},
    });
    deploymentInfo.contracts["proof-verifier"] = deployedVerifier.deployTxData.public.contractAddress;
    console.log(chalk.green(`   ✅ deployed at: ${deploymentInfo.contracts["proof-verifier"]}`));

    fs.writeFileSync("deployment.json", JSON.stringify(deploymentInfo, null, 2));
    console.log(chalk.green.bold("\n✅ All contracts deployed successfully! See deployment.json"));
    
    await wallet.stop();
  } catch (error: any) {
    console.error(chalk.red(error.stack || error.message));
    process.exit(1);
  }
}

main();
