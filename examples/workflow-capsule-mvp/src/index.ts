import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { createCapsules } from "workflow-capsules";
import { cloudflare } from "workflow-capsules/cloudflare";

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
    const capsules = createCapsules({ adapter: cloudflare(this.env.ARTIFACTS) });
    const stripeBaseUrl = event.payload.stripeBaseUrl ?? "https://api.stripe.com";

    const charge = await step.do("charge customer", async (ctx) => {
      return capsules.capture(
        {
          workflow: event,
          step: ctx,
          name: "stripe-payment-intent",
          input: {
            customerId: event.payload.customerId,
            amount: event.payload.amount,
            currency: event.payload.currency,
          },
          idempotencyKey: `wf:${event.instanceId}:charge-customer:${ctx.step.count}`,
        },
        async ({ input, effects, idempotencyKey }) => {
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

          const effect = await effects.record("stripe.payment_intent.create", {
            externalId: body.id,
            httpStatus: response.status,
            request: {
              customerId: input.customerId,
              amount: input.amount,
              currency: input.currency,
              idempotencyKey,
            },
            response: {
              id: body.id,
              object: body.object,
              status: body.status,
            },
          });
          if (!response.ok) {
            throw new Error(
              `Stripe payment_intent.create failed with HTTP ${response.status}`,
            );
          }

          return {
            paymentIntentId: body.id,
            effectPath: effect.path,
          };
        },
      );
    });

    const invoice = await step.do("create invoice", async (ctx) => {
      return capsules.capture(
        {
          workflow: event,
          step: ctx,
          name: "stripe-invoice",
          input: {
            customerId: event.payload.customerId,
            paymentIntentId: charge.output.paymentIntentId,
          },
          idempotencyKey: `wf:${event.instanceId}:create-invoice:${ctx.step.count}`,
        },
        async ({ input, effects, idempotencyKey }) => {
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

          const effect = await effects.record("stripe.invoice.create", {
            externalId: body.id,
            httpStatus: response.status,
            request: {
              customerId: input.customerId,
              paymentIntentId: input.paymentIntentId,
              idempotencyKey,
            },
            response: {
              id: body.id,
              object: body.object,
              status: body.status,
              hosted_invoice_url: body.hosted_invoice_url,
            },
          });
          if (!response.ok) {
            throw new Error(`Stripe invoice.create failed with HTTP ${response.status}`);
          }

          return {
            invoiceId: body.id,
            effectPath: effect.path,
          };
        },
      );
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
