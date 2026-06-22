const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const SOLANA_RPC       = "https://api.mainnet-beta.solana.com";
const SOLANA_FALLBACK  = "https://rpc.ankr.com/solana";
const ETHEREUM_RPC     = "https://cloudflare-eth.com";

// ─── Token Mint Addresses ───────────────────────────────────────────────────
const TOKENS: Record<string, { mint?: string; ethContract?: string; decimals: number }> = {
  // PYUSD on Solana  → PayPal & Venmo invoice pages
  pyusd_solana: {
    mint:     "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
    decimals: 6,
  },
  // USDC on Solana   → CashApp invoice page
  usdc_solana: {
    mint:     "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
  },
  // PYUSD on Ethereum (optional)
  pyusd_ethereum: {
    ethContract: "0x6c3ea9036406852006290770bedfcaba0e23a0e8",
    decimals: 6,
  },
  // USDC on Ethereum (optional)
  usdc_ethereum: {
    ethContract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    decimals: 6,
  },
};

// ─── Your wallet ────────────────────────────────────────────────────────────
const MY_WALLET   = "Bk6HHmSVYwM3veHS9LpWq2TvGKjah9jmuBhCyrGu2TNa";
const DUST        = 0.01; // tolerance

const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ─── Helpers: Solana ─────────────────────────────────────────────────────────
async function solanaRPC(body: object): Promise<any> {
  for (const rpc of [SOLANA_RPC, SOLANA_FALLBACK]) {
    try {
      const r = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      const d = await r.json();
      if (d?.result !== undefined) return d;
    } catch (_) { continue; }
  }
  return null;
}

async function getSolanaTokenBalance(wallet: string, mint:
