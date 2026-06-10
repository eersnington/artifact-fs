import { invalidExternalCall } from "./errors.js";
import type { CapsuleName, CapsulePath } from "./types.js";

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_NAME_LENGTH = 100;

/**
 * Capsule names become directory segments, commit message fragments, and
 * dedupe keys, so they are restricted to lowercase slugs.
 */
export function validateCapsuleName(name: string): CapsuleName {
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw invalidExternalCall(
      `Capsule name must be 1-${MAX_NAME_LENGTH} characters; got ${name.length}. ` +
        `Use a short lowercase slug like "ai-response".`,
    );
  }
  if (!NAME_PATTERN.test(name)) {
    throw invalidExternalCall(
      `Capsule name "${name}" is invalid. Use lowercase letters, digits, ".", "_", and "-", ` +
        `starting with a letter or digit.`,
    );
  }
  return name as CapsuleName;
}

/**
 * Validate a capsule-relative file path. Paths must be relative, use "/",
 * and contain no empty or traversal segments. No normalization is applied:
 * an invalid path is an error, not a silent rewrite.
 */
export function validateCapsulePath(path: string): CapsulePath {
  if (path.length === 0) {
    throw invalidExternalCall("File path must not be empty.");
  }
  if (path.includes("\\")) {
    throw invalidExternalCall(
      `File path "${path}" contains "\\". Use "/" as the separator.`,
    );
  }
  if (path.startsWith("/")) {
    throw invalidExternalCall(
      `File path "${path}" is absolute. Paths are relative to the capsule's files/ directory.`,
    );
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "") {
      throw invalidExternalCall(
        `File path "${path}" contains an empty segment (doubled or trailing "/").`,
      );
    }
    if (segment === "." || segment === "..") {
      throw invalidExternalCall(
        `File path "${path}" contains "${segment}". Traversal segments are not allowed.`,
      );
    }
  }
  return path as CapsulePath;
}

/**
 * Normalize an effect kind like "stripe.payment_intent.create" into a
 * filesystem-safe file stem like "stripe-payment_intent-create".
 */
export function safeEffectKind(kind: string): string {
  if (kind.length === 0) {
    throw invalidExternalCall("Effect kind must not be empty.");
  }
  const safe = kind
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  if (safe.length === 0) {
    throw invalidExternalCall(
      `Effect kind "${kind}" has no filesystem-safe characters. ` +
        `Use a dotted provider identifier like "stripe.invoice.create".`,
    );
  }
  return safe;
}

/** Slugify arbitrary text (step names) into a bounded directory segment. */
export function slugify(text: string, maxLength = 64): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "step";
}
