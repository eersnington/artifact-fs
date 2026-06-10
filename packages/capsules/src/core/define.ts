import { validateCapsuleName } from "./validation.js";
import type {
  CapsuleDefinition,
  CapsuleSpec,
  DefinedCapsule,
} from "./types.js";

/**
 * Define a reusable, typed capsule operation. Multiple Workflows can capture
 * the same definition so path layout, manifests, validation, and output
 * typing stay consistent:
 *
 * ```ts
 * const buildArtifacts = Capsules.define<BuildInput, BuildOutput>({
 *   name: "build-artifacts",
 *   run: async ({ input, files }) => { ... },
 * });
 *
 * await step.do("capture build artifacts", (ctx) =>
 *   capsules.capture(buildArtifacts.with({ workflow: event, step: ctx, input })),
 * );
 * ```
 */
export function define<Input, Output>(
  definition: CapsuleDefinition<Input, Output>,
): DefinedCapsule<Input, Output> {
  const name = validateCapsuleName(definition.name);
  return {
    name,
    with(args): CapsuleSpec<Input, Output> {
      return {
        ...args,
        name,
        run: definition.run,
        ...(definition.input !== undefined
          ? { inputSchema: definition.input }
          : {}),
      };
    },
  };
}
