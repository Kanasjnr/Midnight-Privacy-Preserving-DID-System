import "dotenv/config";
import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk-hd";
import {
  UnshieldedWallet,
  createKeystore,
  PublicKey,
  InMemoryTransactionHistoryStorage,
} from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
import { DustWallet } from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import { ShieldedWallet } from "@midnight-ntwrk/wallet-sdk-shielded";
import { WalletFacade, FacadeState } from "@midnight-ntwrk/wallet-sdk-facade";
import {
  nativeToken,
  ZswapSecretKeys,
  DustSecretKey,
  LedgerParameters,
} from "@midnight-ntwrk/ledger-v8";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { WebSocket } from "ws";
import * as Rx from "rxjs";
import chalk from "chalk";
import path from "path";
import fs from "fs";
import { EnvironmentManager } from "./utils/environment.js";
import { MidnightProviders } from "./providers/midnight-providers.js";
import { deployContract } from "@midnight-ntwrk/midnight-js-contracts";

// Fix WebSocket for Node.js environment
// @ts-ignore
globalThis.WebSocket = WebSocket;

// Configure for Midnight Preview
setNetworkId("preview");

const waitForFunds = (wallet: WalletFacade) =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.filter(
        (state: any) =>
          state.shielded.status === "synced" &&
          state.unshielded.status === "synced",
      ),
      Rx.map((s: any) => s.shielded.balances[nativeToken().tag] ?? 0n),
      Rx.filter((balance: bigint) => balance > 0n),
      Rx.tap((balance: bigint) =>
        console.log(`Wallet funded with balance: ${balance}`),
      ),
    ),
  );

async function main() {
  console.log();
  console.log(chalk.blue.bold("━".repeat(60)));
  console.log(
    chalk.blue.bold("🌙  Midnight Privacy-Preserving DID System Deployment"),
  );
  console.log(chalk.blue.bold("━".repeat(60)));
  console.log();

  try {
    // Validate environment
    EnvironmentManager.validateEnvironment();

    const networkConfig = EnvironmentManager.getNetworkConfig();
    const contractsToDeploy = [
      "did-registry",
      "schema-registry",
      "credential-issuer",
      "proof-verifier",
    ];

    // Check if all contracts are compiled
    for (const name of contractsToDeploy) {
      if (!EnvironmentManager.checkContractCompiled(name)) {
        console.error(`❌ Contract ${name} not compiled! Run: npm run compile`);
        process.exit(1);
      }
    }

    const walletSeed = process.env.WALLET_SEED!;
    const seed = Uint8Array.from(Buffer.from(walletSeed, "hex"));

    // Build modular wallet for v3.0
    console.log("Building wallet components...");
    const hdWalletResult = HDWallet.fromSeed(seed);
    if (hdWalletResult.type === "seedError")
      throw new Error(`Seed Error: ${hdWalletResult.error}`);
    const account = hdWalletResult.hdWallet.selectAccount(0);

    // 1. Setup Unshielded Wallet
    const unshieldedKeyResult = account
      .selectRole(Roles.NightExternal)
      .deriveKeyAt(0);
    if (unshieldedKeyResult.type !== "keyDerived")
      throw new Error("Failed to derive unshielded key");
    const unshieldedSecretKey = unshieldedKeyResult.key;
    const keystore = createKeystore(unshieldedSecretKey, "preview");
    const publicKeyObj = PublicKey.fromKeyStore(keystore);

    const indexerConfig = {
      indexerHttpUrl: networkConfig.indexer,
      indexerWsUrl: networkConfig.indexerWS,
    };

    const unshieldedWallet = UnshieldedWallet({
      networkId: "preview" as any,
      indexerClientConnection: indexerConfig,
      txHistoryStorage: new InMemoryTransactionHistoryStorage(),
    }).startWithPublicKey(publicKeyObj);

    // 2. Setup Dust Wallet
    const dustKeyResult = account.selectRole(Roles.Dust).deriveKeyAt(0);
    if (dustKeyResult.type !== "keyDerived")
      throw new Error("Failed to derive dust key");
    const dustSecretKey = DustSecretKey.fromSeed(dustKeyResult.key);

    // 3. Setup Shielded Wallet
    const zswapKeyResult = account.selectRole(Roles.Zswap).deriveKeyAt(0);
    if (zswapKeyResult.type !== "keyDerived")
      throw new Error("Failed to derive shielded key");
    const shieldedSecretKeys = ZswapSecretKeys.fromSeed(zswapKeyResult.key);

    const ledgerParams = LedgerParameters.initialParameters();
    const proofServerUrl = new URL(networkConfig.proofServer);
    const nodeUrl = new URL(networkConfig.node);

    const walletConfig = {
      networkId: "preview" as any,
      indexerClientConnection: indexerConfig,
      relayURL: nodeUrl,
      provingServerUrl: proofServerUrl,
      txHistoryStorage: new InMemoryTransactionHistoryStorage(),
      costParameters: {
        additionalFeeOverhead: 0n,
        feeBlocksMargin: 5,
      },
    };

    const wallet = await WalletFacade.init({
      configuration: walletConfig,
      shielded: (config) => ShieldedWallet(config).startWithSecretKeys(shieldedSecretKeys),
      unshielded: (config) =>
        UnshieldedWallet({
          ...config,
          txHistoryStorage: new InMemoryTransactionHistoryStorage(),
        }).startWithPublicKey(publicKeyObj),
      dust: (config) => DustWallet(config).startWithSecretKey(dustSecretKey, ledgerParams.dust),
    });

    console.log(chalk.cyan("Starting wallet synchronization..."));
    await wallet.start(shieldedSecretKeys, dustSecretKey);

    const state = (await Rx.firstValueFrom(
      wallet.state().pipe(
        Rx.tap((s: any) => {
          const shieldedGap = s.shielded.syncProgress?.gap ?? "calculating...";
          const dustGap = s.dust.syncProgress?.gap ?? "calculating...";
          const unshieldedGap = s.unshielded.syncProgress?.synced ? 0 : "syncing...";

          process.stdout.write(
            chalk.gray(
              `\rSync progress - Shielded: ${shieldedGap}, Dust: ${dustGap}, Unshielded: ${unshieldedGap}         `,
            ),
          );
        }),
        Rx.filter((s: any) => s.isSynced),
      ),
    )) as FacadeState;
    console.log("\n" + chalk.green("✅ Wallets synchronized!"));

    console.log(chalk.cyan.bold("📍 Wallet Addresses:"));
    console.log(chalk.white(`   Shielded:    ${state.shielded.address}`));
    console.log(chalk.white(`   Unshielded:  ${state.unshielded.address}`));
    console.log(chalk.white(`   Dust:        ${(state.dust as any).address}`));
    console.log();

    let balance = state.shielded.balances[nativeToken().tag] || 0n;

    if (balance === 0n) {
      console.log(chalk.yellow.bold("💰 Balance: ") + chalk.red.bold("0 DUST"));
      console.log();
      console.log(
        chalk.red.bold("❌ Wallet needs funding to deploy contracts."),
      );
      console.log(
        chalk.yellow(
          `👉 Please fund this address: ${state.unshielded.address}`,
        ),
      );
      console.log();
      balance = await waitForFunds(wallet);
    }

    console.log(
      chalk.yellow.bold("💰 Balance: ") + chalk.green.bold(`${balance} DUST`),
    );
    console.log();

    const deploymentInfo: Record<string, any> = {
      deployedAt: new Date().toISOString(),
      network: networkConfig.name,
      contracts: {},
    };

    // Use the wallet facade directly
    const walletProvider = wallet as any;

    // Deploy contracts in sequence
    for (const name of contractsToDeploy) {
      console.log(chalk.blue(`🚀 Deploying ${name} (30-60 seconds)...`));

      const contractPath = path.join(process.cwd(), "contracts");
      const contractModulePath = path.join(
        contractPath,
        "managed",
        name,
        "contract",
        "index.js",
      );

      const ContractModule = await import(contractModulePath);
      const contractInstance = new ContractModule.Contract({});

      const providers = MidnightProviders.create({
        contractName: name,
        walletProvider,
        networkConfig,
      });

      console.log(`   🚀 Deploying ${name}...`);
      const deployed = await deployContract(providers, {
        compiledContract: contractInstance,
        privateStateId: `${name}PrivateState`,
        initialPrivateState: {},
        args: [],
      });

      const contractAddress = deployed.deployTxData.public.contractAddress;
      deploymentInfo.contracts[name] = contractAddress;

      console.log(chalk.green(`   ✅ ${name} deployed at: ${contractAddress}`));
    }

    // Save deployment information
    console.log();
    console.log(chalk.green.bold("━".repeat(60)));
    console.log(chalk.green.bold("🎉 ALL CONTRACTS DEPLOYED SUCCESSFULLY!"));
    console.log(chalk.green.bold("━".repeat(60)));
    console.log();

    fs.writeFileSync(
      "deployment.json",
      JSON.stringify(deploymentInfo, null, 2),
    );
    console.log(chalk.gray("✅ Saved to deployment.json"));
    console.log();

    // Close wallet connection
    await wallet.stop();
  } catch (error: any) {
    console.log();
    console.log(chalk.red.bold("❌ Deployment Failed:"));
    console.error(chalk.red(error?.stack || error?.message || String(error)));
    console.log();
    process.exit(1);
  }
}

main().catch(console.error);
