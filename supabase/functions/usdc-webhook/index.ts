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
    
    // 🟢 [FIX 2] Auth Key Fallback: Service Role Key না পেলে Anon Key ব্যবহার করবে 🟢
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY") || "";
    const supabase = createClient(supabaseUrl, supabaseKey);

    if (body.checkStatus && body.invoiceId) {
      
      const { data: invoice, error } = await supabase.from("payments").select("*").eq("invoice_id", body.invoiceId).single();
      if (error || !invoice) throw new Error("Invoice not found");

      if (invoice.status === "settled") {
        return new Response(JSON.stringify({ status: "settled" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      let isPaid = false;
      const previousBalance = parseFloat(invoice.crypto_amount) || 0;
      const targetBalance = parseFloat(invoice.amount) + previousBalance;

      // 🟢 [FIX 1] Floating Point Fix: দশমিকের বাগে যেন পেমেন্ট না আটকায় তাই সামান্য টলারেন্স রাখা হলো 🟢
      const toleranceMargin = targetBalance - 0.00001;

      // ===============================================
      // ১. SOLANA BLOCKCHAIN CHECK
      // ===============================================
      if (invoice.network === "solana") {
        const solanaRes = await fetch("https://api.mainnet-beta.solana.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getTokenAccountsByOwner",
            params: [
              invoice.wallet_address,
              { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
              { encoding: "jsonParsed" }
            ]
          })
        });
        
        const solanaData = await solanaRes.json();
        if (solanaData.result && solanaData.result.value && solanaData.result.value.length > 0) {
          const currentBalance = solanaData.result.value[0].account.data.parsed.info.tokenAmount.uiAmount;
          // toleranceMargin এর সাথে চেক করা হচ্ছে
          if (currentBalance >= toleranceMargin) isPaid = true;
        }
      } 
      // ===============================================
      // ২. POLYGON (EVM) BLOCKCHAIN CHECK
      // ===============================================
      else if (invoice.network === "evm") {
        const cleanAddress = invoice.wallet_address.replace("0x", "").padStart(64, "0");
        const dataPayload = "0x70a08231" + cleanAddress;

        const polyRes = await fetch("https://polygon-rpc.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_call",
            params: [{ to: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", data: dataPayload }, "latest"]
          })
        });

        const polyData = await polyRes.json();
        if (polyData.result && polyData.result !== "0x") {
          const hexBalance = polyData.result;
          const currentBalance = parseInt(hexBalance, 16) / 1000000;
          // toleranceMargin এর সাথে চেক করা হচ্ছে
          if (currentBalance >= toleranceMargin) isPaid = true;
        }
      }

      // ===============================================
      // ৩. ডাটাবেস আপডেট
      // ===============================================
      if (isPaid) {
        await supabase.from("payments").update({ status: "settled", paid_at: new Date().toISOString() }).eq("invoice_id", invoice.invoice_id);
        
        const columnToUpdate = invoice.network === "solana" ? "solana_address" : "evm_address";
        await supabase.from("wallet_pool").update({ last_used: null }).eq(columnToUpdate, invoice.wallet_address);

        return new Response(JSON.stringify({ status: "settled" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({ status: "pending" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "Invalid request" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
