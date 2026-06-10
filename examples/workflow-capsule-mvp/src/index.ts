import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { createCapsules, defineExternalCall } from "workflow-capsules";
import { cloudflare } from "workflow-capsules/cloudflare";

type ChargePayload = {
  readonly customerId: string;
  readonly amount: number;
  readonly currency: string;
  readonly stripeBaseUrl?: string;
};

type StripeIntentInput = {
  readonly customerId: string;
  readonly amount: number;
  readonly currency: string;
};

type StripeInvoiceInput = {
  readonly customerId: string;
  readonly paymentIntentId: string;
};

type StripePaymentIntent = {
  readonly id: string;
  readonly object: "payment_intent";
  readonly status?: string;
  readonly client_secret?: string;
  readonly [key: string]: unknown;
};

type StripeInvoice = {
  readonly id: string;
  readonly object: "invoice";
  readonly status?: string;
  readonly hosted_invoice_url?: string;
  readonly [key: string]: unknown;
};

type Env = {
  readonly ARTIFACTS: Artifacts;
  readonly CHARGE_CUSTOMER_WORKFLOW: Workflow<ChargePayload>;
  readonly STRIPE_SECRET: string;
};

export class ChargeCustomerWorkflow extends WorkflowEntrypoint<
  Env,
  ChargePayload
> {
  async run(event: WorkflowEvent<ChargePayload>, step: WorkflowStep) {
    const capsules = createCapsules({ adapter: cloudflare(this.env.ARTIFACTS) });
    const stripeBaseUrl = event.payload.stripeBaseUrl ?? "https://api.stripe.com";

    const createPaymentIntent = defineExternalCall<StripeIntentInput, StripePaymentIntent>({
      name: "stripe.payment_intent.create",
      recovery: "idempotent-call",
      execute: async ({ request, key }) => {
        const response = await fetch(`${stripeBaseUrl}/v1/payment_intents`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.env.STRIPE_SECRET}`,
            "content-type": "application/x-www-form-urlencoded",
            "idempotency-key": key,
          },
          body: new URLSearchParams({
            customer: request.customerId,
            amount: String(request.amount),
            currency: request.currency,
          }),
        });
        const body = (await response.json()) as StripePaymentIntent;
        if (!response.ok) {
          throw new Error(
            `Stripe payment_intent.create failed with HTTP ${response.status}`,
          );
        }
        return body;
      },
      summary: ({ request, result }) => ({
        externalId: result.id,
        status: result.status,
        amount: request.amount,
        currency: request.currency,
      }),
    });

    const createInvoice = defineExternalCall<StripeInvoiceInput, StripeInvoice>({
      name: "stripe.invoice.create",
      recovery: "idempotent-call",
      execute: async ({ request, key }) => {
        const response = await fetch(`${stripeBaseUrl}/v1/invoices`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.env.STRIPE_SECRET}`,
            "content-type": "application/x-www-form-urlencoded",
            "idempotency-key": key,
          },
          body: new URLSearchParams({
            customer: request.customerId,
            metadata_payment_intent: request.paymentIntentId,
          }),
        });
        const body = (await response.json()) as StripeInvoice;
        if (!response.ok) {
          throw new Error(`Stripe invoice.create failed with HTTP ${response.status}`);
        }
        return body;
      },
      summary: ({ request, result }) => ({
        externalId: result.id,
        status: result.status,
        paymentIntentId: request.paymentIntentId,
      }),
    });

    const charge = await step.do("charge customer", async (ctx) => {
      const intent = await capsules.call(createPaymentIntent, {
        workflow: event,
        step: ctx,
        key: `wf:${event.instanceId}:charge-customer`,
        request: {
          customerId: event.payload.customerId,
          amount: event.payload.amount,
          currency: event.payload.currency,
        },
      });

      return { paymentIntentId: intent.id };
    });

    const invoice = await step.do("create invoice", async (ctx) => {
      const created = await capsules.call(createInvoice, {
        workflow: event,
        step: ctx,
        key: `wf:${event.instanceId}:create-invoice`,
        request: {
          customerId: event.payload.customerId,
          paymentIntentId: charge.paymentIntentId,
        },
      });

      return { invoiceId: created.id };
    });

    return {
      paymentIntentId: charge.paymentIntentId,
      invoiceId: invoice.invoiceId,
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
      const id = url.pathname.slice("/status/".length);
      const instance = await env.CHARGE_CUSTOMER_WORKFLOW.get(id);
      return Response.json({ id, status: await instance.status() });
    }

    return Response.json(
      { message: "POST /charge to start the workflow, GET /status/:id to inspect it." },
      { status: 404 },
    );
  },
} satisfies ExportedHandler<Env>;
