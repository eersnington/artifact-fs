import { expectTypeOf } from "vitest";
import { createCapsules, type CapsuleRefs, type CapsuleSpec } from "../src/index.js";
import { memory } from "../src/memory.js";

type BuildInput = {
  source: string;
  bundleStream: ReadableStream<Uint8Array>;
};

type BuildOutput = {
  label: string;
  paths: {
    bundle: "dist/app.tar.gz";
    manifest: "dist/manifest.json";
  };
};

const workflow = { workflowName: "BuildWorkflow", instanceId: "build-1" };
const step = { step: { name: "capture build artifacts", count: 1 }, attempt: 1 };
const stream = new ReadableStream<Uint8Array>();

const spec = {
  workflow,
  step,
  name: "build-artifacts",
  input: { source: "web", bundleStream: stream },
  run: async ({ input, files }) => {
    await files.write("dist/app.tar.gz", input.bundleStream);
    await files.write("dist/manifest.json", { source: input.source });
    return {
      label: input.source,
      paths: {
        bundle: "dist/app.tar.gz",
        manifest: "dist/manifest.json",
      },
    };
  },
} satisfies CapsuleSpec<BuildInput, BuildOutput>;

expectTypeOf(spec.input).toEqualTypeOf<BuildInput>();

const capsules = createCapsules({ adapter: memory() });
expectTypeOf(capsules.capture(spec)).toEqualTypeOf<
  Promise<CapsuleRefs<BuildOutput>>
>();

const badSpec = {
  workflow,
  step,
  name: "build-artifacts",
  // @ts-expect-error - BuildInput requires bundleStream.
  input: { source: "web" },
  run: async ({ input }: { input: BuildInput }) => input,
} satisfies CapsuleSpec<BuildInput, BuildInput>;

void badSpec;
