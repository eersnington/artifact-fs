import { expectTypeOf } from "vitest";
import { Artifacts, Capsules, type CapsuleRefs } from "../src/index.js";

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

const buildArtifacts = Capsules.define<BuildInput, BuildOutput>({
  name: "build-artifacts",
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
});

const workflow = { workflowName: "BuildWorkflow", instanceId: "build-1" };
const step = { step: { name: "capture build artifacts", count: 1 }, attempt: 1 };
const stream = new ReadableStream<Uint8Array>();

const spec = buildArtifacts.with({
  workflow,
  step,
  input: { source: "web", bundleStream: stream },
});

expectTypeOf(spec.input).toEqualTypeOf<BuildInput>();

const capsules = Capsules.layer(Artifacts.memory());
expectTypeOf(capsules.capture(spec)).toEqualTypeOf<
  Promise<CapsuleRefs<BuildOutput>>
>();

buildArtifacts.with({
  workflow,
  step,
  // @ts-expect-error - BuildInput requires bundleStream.
  input: { source: "web" },
});
