import fs from "fs";
import path from "path";
import { NetworkConfig } from "../providers/midnight-providers.js";

/**
 * Manages network configurations and environment validation for the Midnight DID System.
 */
export class EnvironmentManager {
  /**
   * Retrieves the network configuration based on the MIDNIGHT_NETWORK environment variable.
   * Defaults to 'preview' if no environment is specified.
   */
  static getNetworkConfig(): NetworkConfig {
    const network = process.env.MIDNIGHT_NETWORK || "preview";

    const networks = {
      preview: {
        indexer: "https://indexer.preview.midnight.network/api/v3/graphql",
        indexerWS: "wss://indexer.preview.midnight.network/api/v3/graphql/ws",
        node: "wss://rpc.preview.midnight.network",
        proofServer: process.env.PROOF_SERVER_URL || "http://localhost:6300",
        name: "Preview",
      },
      preprod: {
        indexer: "https://indexer.preprod.midnight.network/api/v3/graphql",
        indexerWS: "wss://indexer.preprod.midnight.network/api/v3/graphql/ws",
        node: "wss://rpc.preprod.midnight.network",
        proofServer: process.env.PROOF_SERVER_URL || "http://localhost:6300",
        name: "Preprod",
      },
    };

    return networks[network as keyof typeof networks] || networks.preview;
  }

  /**
   * Validates that all required environment variables are present and correctly formatted.
   * Throws an error if any critical configuration (e.g., WALLET_SEED) is missing.
   */
  static validateEnvironment(): void {
    const required = ["WALLET_SEED"];
    const missing = required.filter((key) => !process.env[key]);

    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing.join(", ")}`,
      );
    }

    const walletSeed = process.env.WALLET_SEED!;
    if (!/^[a-fA-F0-9]{64}$/.test(walletSeed)) {
      throw new Error("WALLET_SEED must be a 64-character hexadecimal string");
    }
  }

  /**
   * Verifies if a specific contract has been compiled and its artifacts are present.
   * Checks for JSM module index and ZK keys.
   */
  static checkContractCompiled(contractName: string): boolean {
    const contractPath = path.join(
      process.cwd(),
      "contracts",
      "managed",
      contractName,
    );
    const keysPath = path.join(contractPath, "keys");
    const contractModulePath = path.join(contractPath, "contract", "index.js");
    const contractModulePathCjs = path.join(
      contractPath,
      "contract",
      "index.cjs",
    );

    return (
      fs.existsSync(keysPath) &&
      (fs.existsSync(contractModulePath) ||
        fs.existsSync(contractModulePathCjs))
    );
  }
}
