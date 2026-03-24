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
import { nativeToken, ZswapSecretKeys, DustSecretKey, LedgerParameters } from "@midnight-ntwrk/ledger-v8";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { WebSocket } from "ws";
import * as Rx from "rxjs";
import chalk from "chalk";
import { EnvironmentManager } from "./utils/environment.js";

// Fix WebSocket for Node.js environment
// @ts-ignore
globalThis.WebSocket = WebSocket;

// Configure for Midnight Testnet
setNetworkId('preview');

async function checkBalance() {
  try {
    console.log();
    console.log(chalk.blue.bold("━".repeat(60)));
    console.log(chalk.blue.bold("🌙  Wallet Balance Checker"));
    console.log(chalk.blue.bold("━".repeat(60)));
    console.log();

    const seed = process.env.WALLET_SEED;
    if (!seed) {
      throw new Error("WALLET_SEED not found in .env file");
    }

    console.log(chalk.gray("Building wallet..."));
    console.log();

    // Get network configuration
    const networkConfig = EnvironmentManager.getNetworkConfig();
    const walletSeed = seed;

    const seedBytes = Uint8Array.from(Buffer.from(walletSeed, 'hex'));
    const hdWalletResult = HDWallet.fromSeed(seedBytes);
    if (hdWalletResult.type === 'seedError') throw new Error(`Seed Error: ${hdWalletResult.error}`);
    const account = hdWalletResult.hdWallet.selectAccount(0);

    // 1. Unshielded Wallet
    const unshieldedKeyResult = account.selectRole(Roles.NightExternal).deriveKeyAt(0);
    if (unshieldedKeyResult.type !== 'keyDerived') throw new Error("Failed to derive unshielded key");
    const unshieldedSecretKey = unshieldedKeyResult.key;
    const keystore = createKeystore(unshieldedSecretKey, 'preview');
    const publicKeyObj = PublicKey.fromKeyStore(keystore);

    // 2. Dust Wallet
    const dustKeyResult = account.selectRole(Roles.Dust).deriveKeyAt(0);
    if (dustKeyResult.type !== 'keyDerived') throw new Error("Failed to derive dust key");
    const dustSecretKey = DustSecretKey.fromSeed(dustKeyResult.key);

    const indexerConfig = {
      indexerHttpUrl: networkConfig.indexer,
      indexerWsUrl: networkConfig.indexerWS,
    };
    const ledgerParams = LedgerParameters.initialParameters();
    const proofServerUrl = new URL(networkConfig.proofServer);
    const nodeUrl = new URL(networkConfig.node);

    // 3. Shielded Wallet setup
    const zswapKeyResult = account.selectRole(Roles.Zswap).deriveKeyAt(0);
    if (zswapKeyResult.type !== 'keyDerived') throw new Error("Failed to derive shielded key");
    const shieldedSecretKeys = ZswapSecretKeys.fromSeed(zswapKeyResult.key);

    const walletConfig = {
      networkId: 'preview' as any,
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
          txHistoryStorage: config.txHistoryStorage,
        }).startWithPublicKey(publicKeyObj),
      dust: (config) => DustWallet(config).startWithSecretKey(dustSecretKey, ledgerParams.dust),
    });

    console.log(chalk.cyan("Starting wallet sync..."));
    await wallet.start(shieldedSecretKeys, dustSecretKey);

    const state = await Rx.firstValueFrom(wallet.state().pipe(
      Rx.filter((s: any) => 
        s.shielded.status === 'synced' && 
        s.unshielded.status === 'synced'
      )
    )) as any;

    console.log(chalk.cyan.bold("📍 Wallet Address:"));
    console.log(chalk.white(`   ${state.shielded.address}`));
    console.log();

    const balance = state.shielded.balances[nativeToken().tag] || 0n;

    if (balance === 0n) {
      console.log(chalk.yellow.bold("💰 Balance: ") + chalk.red.bold("0 DUST"));
      console.log();
      console.log(chalk.red("❌ No funds detected."));
      console.log();
      console.log(chalk.magenta.bold("━".repeat(60)));
      console.log(chalk.magenta.bold("📝 How to Get Test Tokens:"));
      console.log(chalk.magenta.bold("━".repeat(60)));
      console.log();
      console.log(chalk.white("   1. ") + chalk.cyan("Visit: ") + chalk.underline("https://midnight.network/test-faucet"));
      console.log(chalk.white("   2. ") + chalk.cyan("Paste your wallet address (shown above)"));
      console.log(chalk.white("   3. ") + chalk.cyan("Request tokens from the faucet"));
      console.log(chalk.white("   4. ") + chalk.cyan("Wait 2-5 minutes for processing"));
      console.log(chalk.white("   5. ") + chalk.cyan("Run ") + chalk.yellow.bold("'npm run check-balance'") + chalk.cyan(" again"));
      console.log();
      console.log(chalk.gray("━".repeat(60)));
      console.log(chalk.gray("💡 Tip: Faucet transactions typically take 2-5 minutes to process."));
      console.log(chalk.gray("━".repeat(60)));
    } else {
      console.log(chalk.yellow.bold("💰 Balance: ") + chalk.green.bold(`${balance} DUST`));
      console.log();
      console.log(chalk.green.bold("✅ Wallet is funded and ready!"));
      console.log();
      console.log(chalk.magenta.bold("━".repeat(60)));
      console.log(chalk.magenta.bold("🚀 Next Step:"));
      console.log(chalk.magenta.bold("━".repeat(60)));
      console.log();
      console.log(chalk.cyan("   Deploy your contract with:"));
      console.log(chalk.yellow.bold("   npm run deploy"));
      console.log();
      console.log(chalk.gray("━".repeat(60)));
    }

    console.log();
    await wallet.stop();
    process.exit(0);
  } catch (error) {
    console.log();
    console.log(chalk.red.bold("❌ Error checking balance:"));
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    console.log();
    process.exit(1);
  }
}

checkBalance();
