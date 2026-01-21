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
    testnet: {
      type: "http",
      url: configVariable("TESTNET_RPC_URL"),
      accounts: [configVariable("PRIVATE_KEY")],
      chainId: 10143,
    },
    mainnet: {
      type: "http",
      url: configVariable("MAINNET_RPC_URL"),
      accounts: [configVariable("PRIVATE_KEY")],
      chainId: 143,
    },
  },
});
