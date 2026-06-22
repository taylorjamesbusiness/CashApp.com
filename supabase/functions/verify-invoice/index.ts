const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const SOLANA_RPC      = "https://api.mainnet-beta.solana.com";
const SOLANA_FALLBACK = "https://rpc.ankr.com/solana";
const ETHEREUM_RPC    = "https://cloudflare-eth.com";

const TOKENS: Record<string, { mint?: string; ethContract?: string; decimals: number }> = {
  pyusd_solana:   { mint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", decimals: 6 },
  usdc_solana:    { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  pyusd_ethereum: { ethContract: "0x6c3ea9036406852006290770bedfcaba0e23a0e8", decimals: 6 },
  usdc_ethereum:  { ethContract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6 },
};

const MY_WALLET = "Bk6HHmSVYwM3veHS9LpWq2TvGKjah9jmuBhCyrGu2TNa";
const DUST      = 0.01;

const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

async function getSolanaTokenBalance(wallet: string, mint: string): Promise<number> {
  const data = await solanaRPC({
    jsonrpc: "2.0", id: 1,
    method: "getTokenAccountsByOwner",
    params: [wallet, { mint }, { encoding: "jsonParsed" }],
  });
  const accounts = data?.result?.value ?? [];
  return accounts.reduce((sum: number, acc: any) =>
    sum + Number(acc?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0), 0
  );
}

async function scanSolanaTransactions(
  wallet: string,
  mint: string,
  expectedAmt: number,
  sinceTs: number
): Promise<{ found: boolean; amount: number; signature: string }> {
  const sigData = await solanaRPC({
    jsonrpc: "2.0", id: 1,
    method: "getSignaturesForAddress",
    params: [wallet, { limit: 25 }],
  });
  const sigs = sigData?.result ?? [];

  for (const sigInfo of sigs) {
    if (sigInfo.blockTime && sigInfo.blockTime < sinceTs) continue;
    if (sigInfo.err) continue;

    const txData = await solanaRPC({
      jsonrpc: "2.0", id: 1,
      method: "getTransaction",
      params: [sigInfo.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
    });
    const tx = txData?.result;
    if (!tx) continue;

    const allIx: any[] = [...(tx?.transaction?.message?.instructions ?? [])];
    (tx?.meta?.innerInstructions ?? []).forEach((ii: any) =>
      allIx.push(...(ii.instructions ?? []))
    );

    for (const ix of allIx) {
      const type = ix?.parsed?.type;
      if (type !== "transferChecked" && type !== "transfer") continue;
      const info   = ix?.parsed?.info ?? {};
      const ixMint = info?.mint ?? "";
      const amount = Number(info?.tokenAmount?.uiAmount ?? info?.amount ?? 0);
      if (ixMint === mint && amount >= expectedAmt - DUST) {
        return { found: true, amount, signature: sigInfo.signature };
      }
    }
  }
  return { found: false, amount: 0, signature: "" };
}

async function getEthTokenBalance(
  wallet: string,
  contract: string,
  decimals: number
): Promise<number> {
  try {
    const clean = wallet.toLowerCase().replace("0x", "");
    const data  = "0x70a08231" + clean.padStart(64, "0");
    const r = await fetch(ETHEREUM_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "eth_call",
        params: [{ to: contract, data }, "latest"],
      }),
      signal: AbortSignal.timeout(8000),
    });
    const d = await r.json();
    if (!d.result || d.result === "0x") return 0;
    return Number(BigInt(d.result)) / Math.pow(10, decimals);
  } catch (_) { return 0; }
}

function resolveToken(invoice: any): {
  mint?: string;
  ethContract?: string;
  decimals: number;
  chain: string;
} {
  const pm  = (invoice.payment_method ?? "").toLowerCase();
  const net = (invoice.network ?? "solana").toLowerCase();
  const tok = (invoice.token ?? "pyusd").toLowerCase();

  if (pm === "cashapp")                     return { ...TOKENS.usdc_solana,    chain: "solana" };
  if (pm === "paypal" || pm === "venmo")    return { ...TOKENS.pyusd_solana,   chain: "solana" };
  if (net === "solana"   && tok === "usdc") return { ...TOKENS.usdc_solana,    chain: "solana" };
  if (net === "solana")                    return { ...TOKENS.pyusd_solana,   chain: "solana" };
  if (net === "ethereum" && tok === "usdc") return { ...TOKENS.usdc_ethereum,  chain: "ethereum" };
  return { ...TOKENS.pyusd_ethereum, chain: "ethereum" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const invoice_id: string = body.invoice_id ?? "";

    if (!invoice_id) {
      return new Response(
        JSON.stringify({ error: "invoice_id required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    const dbRes = await fetch(
      `${SUPABASE_URL}/rest/v1/invoices?id=eq.${invoice_id}&select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
    );
    const rows    = await dbRes.json();
    const invoice = rows[0];

    if (!invoice) {
      return new Response(
        JSON.stringify({ error: "Invoice not found" }),
        { status: 404, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    if (invoice.status === "paid") {
      return new Response(
        JSON.stringify({ status: "paid", success: true }),
        { headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    const wallet       = invoice.wallet_address ?? MY_WALLET;
    const targetAmount = Number(invoice.amount);
    const sinceTs      = Math.floor(new Date(invoice.created_at).getTime() / 1000);
    const tokenCfg     = resolveToken(invoice);

    let currentBalance = 0;
    let txSignature    = "";
    let paymentFound   = false;

    if (tokenCfg.chain === "solana" && tokenCfg.mint) {
      currentBalance = await getSolanaTokenBalance(wallet, tokenCfg.mint);
      if (currentBalance >= targetAmount - DUST) {
        paymentFound = true;
      } else {
        const tx = await scanSolanaTransactions(wallet, tokenCfg.mint, targetAmount, sinceTs);
        if (tx.found) {
          paymentFound   = true;
          currentBalance = tx.amount;
          txSignature    = tx.signature;
        }
      }
    } else if (tokenCfg.chain === "ethereum" && tokenCfg.ethContract) {
      currentBalance = await getEthTokenBalance(wallet, tokenCfg.ethContract, tokenCfg.decimals);
      if (currentBalance >= targetAmount - DUST) paymentFound = true;
    }

    if (paymentFound) {
      const patch: Record<string, any> = {
        status:       "paid",
        paid_at:      new Date().toISOString(),
        paid_balance: currentBalance,
      };
      if (txSignature) patch.tx_signature = txSignature;

      await fetch(`${SUPABASE_URL}/rest/v1/invoices?id=eq.${invoice_id}`, {
        method: "PATCH",
        headers: {
          apikey:        SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          Prefer:        "return=minimal",
        },
        body: JSON.stringify(patch),
      });

      return new Response(
        JSON.stringify({ status: "paid", success: true, balance: currentBalance, tx: txSignature }),
        { headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ status: "awaiting_payment", success: false, balance: currentBalance }),
      { headers: { ...cors, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }
});
