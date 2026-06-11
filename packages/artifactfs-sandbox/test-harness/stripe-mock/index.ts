export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);

    if (request.method === "POST" && url.pathname === "/v1/payment_intents") {
      return Response.json({
        id: `pi_test_${suffix}`,
        object: "payment_intent",
        status: "succeeded",
      });
    }

    if (request.method === "POST" && url.pathname === "/v1/invoices") {
      return Response.json({
        id: `in_test_${suffix}`,
        object: "invoice",
        status: "open",
        hosted_invoice_url: `https://example.invalid/invoices/${suffix}`,
      });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
};
