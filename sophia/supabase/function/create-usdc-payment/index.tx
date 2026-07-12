import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") { return new Response("ok", { headers: corsHeaders }); }

  try {
    const body = await req.json();
    const amount = Number(body.amount);
    const userKey = body.userKey || "";

    if (amount < 2) throw new Error("Minimum amount is $2");
    if (amount > 2000) throw new Error("Maximum amount is $2000");

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY") || "";
    const supabase = createClient(supabaseUrl, supabaseKey);

    const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();

    const { data: wallet } = await supabase
      .from("wallet_pool")
      .select("*")
      .eq("active", true)
      .or(`last_used.is.null,last_used.lte.${fifteenMinsAgo}`)
      .order("last_used", { ascending: true, nullsFirst: true })
      .limit(1)
      .single();

    if (!wallet) {
      throw new Error("System is currently busy. Please try again in 5 minutes.");
    }

    const autoNetwork = Math.random() > 0.5 ? "solana" : "evm";
    const invoiceId = crypto.randomUUID();
    const address = autoNetwork === "solana" ? wallet.solana_address : wallet.evm_address;

    // 🟢 1. GET INITIAL/REFERENCE BALANCE 🟢
    let initialBalance = 0;
    try {
      if (autoNetwork === "solana") {
        const solanaRes = await fetch("https://api.mainnet-beta.solana.com", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: [address, { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }, { encoding: "jsonParsed" }] })
        });
        const solanaData = await solanaRes.json();
        if (solanaData.result && solanaData.result.value && solanaData.result.value.length > 0) {
          initialBalance = solanaData.result.value[0].account.data.parsed.info.tokenAmount.uiAmount;
        }
      } else if (autoNetwork === "evm") {
        const cleanAddress = address.replace("0x", "").padStart(64, "0");
        const polyRes = await fetch("https://polygon-rpc.com", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", data: "0x70a08231" + cleanAddress }, "latest"] })
        });
        const polyData = await polyRes.json();
        if (polyData.result && polyData.result !== "0x") {
          initialBalance = parseInt(polyData.result, 16) / 1000000;
        }
      }
    } catch (e) {
      console.error("Failed to fetch initial balance:", e);
    }

    await supabase.from("wallet_pool").update({ last_used: new Date().toISOString() }).eq("id", wallet.id);

    // 🟢 2. SAVE REFERENCE BALANCE 🟢
    await supabase.from("payments").insert({
      invoice_id: invoiceId,
      amount,
      status: "pending",
      payment_type: "usdc",
      network: autoNetwork, 
      wallet_address: address,
      user_key: userKey,
      crypto_amount: initialBalance, // এই ব্যালেন্সের উপরেই আমাদের টার্গেট ঠিক হবে
      source: body.source || "",
      city: body.city || "",
      country: body.country || ""
    });

    return new Response(JSON.stringify({ success: true, invoiceId, amount, network: autoNetwork, address, expiresAt: Date.now() + 15 * 60 * 1000 }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
