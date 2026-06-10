import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  Artifacts as ArtifactLayers,
  Capsules,
  redact,
  stableHash,
} from "workflow-capsules";

type ChargePayload = {
  customerId: string;
  amount: number;
  currency: string;
  stripeBaseUrl?: string;
};

type StripePaymentIntent = {
  id: string;
  object: "payment_intent";
  status?: string;
  client_secret?: string;
  [key: string]: unknown;
};

type StripeInvoice = {
  id: string;
  object: "invoice";
  status?: string;
  hosted_invoice_url?: string;
  [key: string]: unknown;
};

type Env = {
  ARTIFACTS: Artifacts;
  CHARGE_CUSTOMER_WORKFLOW: Workflow<ChargePayload>;
  STRIPE_SECRET: string;
};

export class ChargeCustomerWorkflow extends WorkflowEntrypoint<
  Env,
  ChargePayload
> {
  async run(event: WorkflowEvent<ChargePayload>, step: WorkflowStep) {
    const capsules = Capsules.layer(ArtifactLayers.workers(this.env.ARTIFACTS));
    const stripeBaseUrl = event.payload.stripeBaseUrl ?? "https://api.stripe.com";

    const charge = await step.do("charge customer", async (ctx) => {
      return capsules.capture({
        workflow: event,
        step: ctx,
        name: "stripe-payment-intent",
        input: {
          customerId: event.payload.customerId,
          amount: event.payload.amount,
          currency: event.payload.currency,
        },
        idempotencyKey: `wf:${event.instanceId}:charge-customer:${ctx.step.count}`,
        run: async ({ input, files, effects, idempotencyKey }) => {
          const requestBody = new URLSearchParams({
            customer: input.customerId,
            amount: String(input.amount),
            currency: input.currency,
          });
          const response = await fetch(`${stripeBaseUrl}/v1/payment_intents`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.env.STRIPE_SECRET}`,
              "content-type": "application/x-www-form-urlencoded",
              ...(idempotencyKey !== undefined
                ? { "idempotency-key": idempotencyKey }
                : {}),
            },
            body: requestBody,
          });
          const body = (await response.json()) as StripePaymentIntent;

          await files.write("request/redacted.json", {
            customerId: input.customerId,
            amount: input.amount,
            currency: input.currency,
            idempotencyKey,
          });
          await files.write("response/payment-intent.json", redact(body));

          await effects.record("stripe.payment_intent.create", {
            ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
            externalId: body.id,
            httpStatus: response.status,
            requestHash: await stableHash({
              customerId: input.customerId,
              amount: input.amount,
              currency: input.currency,
            }),
          });
          if (!response.ok) {
            throw new Error(
              `Stripe payment_intent.create failed with HTTP ${response.status}`,
            );
          }

          return {
            paymentIntentId: body.id,
            responsePath: "response/payment-intent.json",
          };
        },
      });
    });

    const invoice = await step.do("create invoice", async (ctx) => {
      return capsules.capture({
        workflow: event,
        step: ctx,
        name: "stripe-invoice",
        input: {
          customerId: event.payload.customerId,
          paymentIntentId: charge.output.paymentIntentId,
        },
        idempotencyKey: `wf:${event.instanceId}:create-invoice:${ctx.step.count}`,
        run: async ({ input, files, effects, idempotencyKey }) => {
          const requestBody = new URLSearchParams({
            customer: input.customerId,
            metadata_payment_intent: input.paymentIntentId,
          });
          const response = await fetch(`${stripeBaseUrl}/v1/invoices`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.env.STRIPE_SECRET}`,
              "content-type": "application/x-www-form-urlencoded",
              ...(idempotencyKey !== undefined
                ? { "idempotency-key": idempotencyKey }
                : {}),
            },
            body: requestBody,
          });
          const body = (await response.json()) as StripeInvoice;

          await files.write("request/redacted.json", {
            customerId: input.customerId,
            paymentIntentId: input.paymentIntentId,
            idempotencyKey,
          });
          await files.write("response/invoice.json", redact(body));

          await effects.record("stripe.invoice.create", {
            ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
            externalId: body.id,
            httpStatus: response.status,
            requestHash: await stableHash(input),
          });
          if (!response.ok) {
            throw new Error(`Stripe invoice.create failed with HTTP ${response.status}`);
          }

          return {
            invoiceId: body.id,
            invoicePath: "response/invoice.json",
          };
        },
      });
    });

    return {
      charge,
      invoice,
    };
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/charge") {
      const payload = (await request.json()) as ChargePayload;
      const instance = await env.CHARGE_CUSTOMER_WORKFLOW.create({
        params: payload,
      });
      return Response.json({ id: instance.id, status: await instance.status() });
    }

    if (request.method === "GET" && url.pathname.startsWith("/status/")) {
      const instanceId = url.pathname.split("/").at(-1);
      if (instanceId === undefined || instanceId === "") {
        return Response.json({ error: "Missing Workflow instance id." }, { status: 400 });
      }
      const instance = await env.CHARGE_CUSTOMER_WORKFLOW.get(instanceId);
      return Response.json({ id: instance.id, status: await instance.status() });
    }

    return Response.json(
      {
        message: "POST /charge to create a Workflow, or GET /status/:id to inspect it.",
      },
      { status: 404 },
    );
  },
} satisfies ExportedHandler<Env>;
