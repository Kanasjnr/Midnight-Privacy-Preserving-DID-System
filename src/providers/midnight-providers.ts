import path from "path";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { httpClientProofProvider, httpClientProvingProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { PrivateStateId, MidnightProviders as BaseMidnightProviders, WalletProvider, UnboundTransaction } from "@midnight-ntwrk/midnight-js-types";
import { CoinPublicKey, EncPublicKey, FinalizedTransaction, ZswapSecretKeys, DustSecretKey } from "@midnight-ntwrk/ledger-v8";
import { firstValueFrom, filter } from "rxjs";

export interface NetworkConfig {
  indexer: string;
  indexerWS: string;
  node: string;
  proofServer: string;
  name: string;
}

export interface ProviderConfig {
  contractName: string;
  walletProvider: any; // WalletFacade
  unshieldedKeystore: any;
  seed: string;
  networkConfig: NetworkConfig;
  shieldedSecretKeys: ZswapSecretKeys;
  dustSecretKey: DustSecretKey;
  privateStateStoreName?: string;
  signingKeyStoreName?: string;
}

class WalletProviderShim implements WalletProvider {
  constructor(
    private facade: any,
    private shieldedSecretKeys: ZswapSecretKeys,
    private dustSecretKey: DustSecretKey
  ) {}

  async balanceTx(tx: UnboundTransaction, ttl?: Date): Promise<FinalizedTransaction> {
    const recipe = await this.facade.balanceUnboundTransaction(tx, {
      shieldedSecretKeys: this.shieldedSecretKeys,
      dustSecretKey: this.dustSecretKey
    }, {
      ttl: ttl ?? new Date(Date.now() + 1000 * 60 * 10) // 10 min default
    });
    return await this.facade.finalizeRecipe(recipe);
  }

  getCoinPublicKey(): CoinPublicKey {
    return (this.shieldedSecretKeys as any).coinPublicKey;
  }

  getEncryptionPublicKey(): EncPublicKey {
    return (this.shieldedSecretKeys as any).encryptionPublicKey;
  }
}

export class MidnightProviders {
  static async create<ICK extends string, PS>(
    config: ProviderConfig
  ): Promise<BaseMidnightProviders<ICK, PrivateStateId, PS>> {
    const contractPath = path.join(process.cwd(), "contracts");
    const zkConfigPath = path.join(contractPath, "managed", config.contractName);

    // Wait until the wallet is fully synced (following guide 10.6)
    const state = await firstValueFrom(
      config.walletProvider.state().pipe(filter((s: any) => s.isSynced))
    ) as any;

    const walletProvider = {
      getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
      getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
      async balanceTx(tx: any, ttl?: Date) {
        const recipe = await config.walletProvider.balanceUnboundTransaction(
          tx,
          { shieldedSecretKeys: config.shieldedSecretKeys, dustSecretKey: config.dustSecretKey },
          { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
        );
        const signedRecipe = await config.walletProvider.signRecipe(
          recipe,
          (payload: any) => config.unshieldedKeystore.signData(payload),
        );
        return config.walletProvider.finalizeRecipe(signedRecipe);
      },
      submitTx: (tx: any) => config.walletProvider.submitTransaction(tx) as any,
    };

    const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath) as any;

    const privateStateProvider = levelPrivateStateProvider({
      privateStoragePasswordProvider: async () => `Aa1!${config.seed}`,
      accountId: config.unshieldedKeystore.getBech32Address().toString(),
    });

    return {
      privateStateProvider: privateStateProvider as any,
      publicDataProvider: indexerPublicDataProvider(config.networkConfig.indexer, config.networkConfig.indexerWS),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(config.networkConfig.proofServer, zkConfigProvider),
      provingProvider: httpClientProvingProvider(config.networkConfig.proofServer, zkConfigProvider),
      walletProvider: walletProvider as any,
      midnightProvider: walletProvider as any,
    } as any;
  }
}
