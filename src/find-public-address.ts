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
import { EnvironmentManager } from "./utils/environment.js";
import * as Rx from "rxjs";
import chalk from "chalk";

setNetworkId('preview');

async function main() {
  const walletSeed = process.env.WALLET_SEED!;
  const networkConfig = EnvironmentManager.getNetworkConfig();

  console.log("Connecting to wallet to extract addresses...");

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
    // 2. Dust Wallet setup
    const dustKeyResult = account.selectRole(Roles.Dust).deriveKeyAt(0);
    if (dustKeyResult.type !== 'keyDerived') throw new Error("Failed to derive dust key");
    const dustSecretKey = DustSecretKey.fromSeed(dustKeyResult.key);

    // 3. Shielded Wallet setup
    const zswapKeyResult = account.selectRole(Roles.Zswap).deriveKeyAt(0);
    if (zswapKeyResult.type !== 'keyDerived') throw new Error("Failed to derive shielded key");
    const shieldedSecretKeys = ZswapSecretKeys.fromSeed(zswapKeyResult.key);

    const indexerConfig = {
      indexerHttpUrl: networkConfig.indexer,
      indexerWsUrl: networkConfig.indexerWS,
    };
    const ledgerParams = LedgerParameters.initialParameters();
    const proofServerUrl = new URL(networkConfig.proofServer);
    const nodeUrl = new URL(networkConfig.node);

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

  await wallet.start(shieldedSecretKeys, dustSecretKey);

  const state = await Rx.firstValueFrom(wallet.state()) as any;
  const formatAddress = (addr: any) => {
    if (typeof addr === 'string') return addr;
    if (addr?.address && typeof addr.address === 'string') return addr.address;
    if (typeof addr?.toString === 'function' && addr.toString() !== '[object Object]') return addr.toString();
    return JSON.stringify(addr);
  };

  console.log();
  console.log(chalk.cyan.bold("📍 Wallet Address Information:"));
  console.log(chalk.white(`   🛡️  Shielded:    ${formatAddress(state.shielded.address)}`));
  console.log(chalk.white(`   🔓  Unshielded:  ${formatAddress(state.unshielded.address)}`));
  console.log(chalk.white(`   🧹  DUST:        ${formatAddress(state.dust.address)}`));
  
  console.log(chalk.green.bold(`\n🚀 Faucet-Ready Address:`));
  console.log(chalk.green(`   ${formatAddress(state.unshielded.address)}`));
  console.log(chalk.gray(`   (Use this address on the Midnight Preview Faucet)`));

  await wallet.stop();
  process.exit(0);
}

main().catch(console.error);
