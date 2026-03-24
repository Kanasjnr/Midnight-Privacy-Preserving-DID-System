import path from "path";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { PrivateStateId, MidnightProviders as BaseMidnightProviders } from "@midnight-ntwrk/midnight-js-types";

export interface NetworkConfig {
  indexer: string;
  indexerWS: string;
  node: string;
  proofServer: string;
  name: string;
}

export interface ProviderConfig {
  contractName: string;
  walletProvider: any;
  networkConfig: NetworkConfig;
  privateStateStoreName?: string;
  signingKeyStoreName?: string;
}

export class MidnightProviders {
  static create<ICK extends string, PS>(
    config: ProviderConfig
  ): BaseMidnightProviders<ICK, PrivateStateId, PS> {
    const contractPath = path.join(process.cwd(), "contracts");
    const zkConfigPath = path.join(
      contractPath,
      "managed",
      config.contractName
    );

    const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath) as any;

    // In v4.0.1, levelPrivateStateProvider requires accountId and password provider
    const privateStateProvider = levelPrivateStateProvider({
      midnightDbName: "did-system-db",
      privateStateStoreName: config.privateStateStoreName || `${config.contractName}-state`,
      signingKeyStoreName: config.signingKeyStoreName || `${config.contractName}-signing-keys`,
      accountId: config.walletProvider.getEncryptionPublicKey(),
      privateStoragePasswordProvider: async () => "development-password-at-least-16-chars-long",
    });

    return {
      privateStateProvider,
      publicDataProvider: indexerPublicDataProvider(
        config.networkConfig.indexer,
        config.networkConfig.indexerWS
      ),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(config.networkConfig.proofServer, zkConfigProvider),
      walletProvider: config.walletProvider,
      midnightProvider: config.walletProvider,
    };
  }
}
