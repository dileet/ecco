import { defineConfig, configVariable } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";

export default defineConfig({
  plugins: [hardhatToolboxViem],
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "cancun",
      viaIR: true,
    },
  },
  paths: {
    sources: "./src",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  networks: {
    monadTestnet: {
      type: "http",
      url: configVariable("MONAD_TESTNET_RPC_URL"),
      accounts: [configVariable("PRIVATE_KEY")],
      chainId: 10143,
    },
    monadMainnet: {
      type: "http",
      url: configVariable("MONAD_MAINNET_RPC_URL"),
      accounts: [configVariable("PRIVATE_KEY")],
      chainId: 143,
    },
  },
});
