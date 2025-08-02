export const LOCAL_DEV_MODE = true;

export const HARDCODED_STABLECOIN_BASE = LOCAL_DEV_MODE
  ? { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", symbol: "USDC", decimals: 6 }
  : {
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      symbol: "USDC",
      decimals: 6,
    };
