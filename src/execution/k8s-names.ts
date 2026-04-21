/**
 * Shared helpers for turning user-controlled ids (runId, ticketId) into
 * Kubernetes resource names and label values. Kept in one place so the
 * PVC sandbox and the pod executor can't drift — label-based lookups across
 * them rely on byte-for-byte agreement.
 *
 * K8s rules we enforce:
 *   - Resource names are DNS-1123 labels: `[a-z0-9]([-a-z0-9]*[a-z0-9])?`,
 *     <= 63 chars, must start AND end with an alphanumeric.
 *   - Label values are `[A-Za-z0-9][A-Za-z0-9._-]*`, <= 63 chars, same
 *     start/end rule (or the empty string, which we never emit).
 */

const DNS1123_MAX = 63;
const TRAVERSAL_RE = /[\s/\\\0]|\.\.|^\.$/;

/**
 * Reject traversal / whitespace / null bytes before we attempt to use an id
 * in any resource name. Callers should invoke this on raw runId/ticketId
 * values before slugifying — the slug alone is not enough because two
 * different-but-unsafe inputs can collide to the same legal slug.
 */
export function assertSafePathSegment(value: string, kind: string): void {
  if (!value || TRAVERSAL_RE.test(value)) {
    throw new Error(`Unsafe ${kind} segment: ${JSON.stringify(value)}`);
  }
}

/**
 * Lowercase + collapse non-[a-z0-9-] runs into a single `-`, trim leading
 * and trailing hyphens, and guarantee a non-empty result. The trimmed
 * output is a legal DNS-1123 label fragment (though callers still need to
 * cap total length after concatenating prefixes).
 */
export function slugifyForK8s(value: string): string {
  const lowered = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const trimmed = lowered.replace(/^[-]+|[-]+$/g, "");
  return trimmed || "x";
}

/**
 * Cap a composed K8s resource name at 63 chars AND enforce the "ends in an
 * alphanumeric" rule. Slicing mid-hyphen is the common hazard when we
 * template `${prefix}-${slug}-${slug}-${counter}` — the tail can land on a
 * `-` and produce an invalid name.
 */
export function finalizeK8sName(name: string): string {
  const capped = name.slice(0, DNS1123_MAX);
  // Strip trailing non-alphanumerics. If that empties the string (would
  // never happen with our prefixes, but defensive), fall back to "x".
  const trimmed = capped.replace(/[^a-z0-9]+$/g, "");
  return trimmed || "x";
}

/**
 * Label values allow `.` and `_` on top of the DNS-1123 alphabet, but still
 * must start AND end with an alphanumeric and stay <= 63 chars. We use this
 * for `relay.run-id` / `relay.ticket-id` so label selectors (e.g. the PVC
 * reuse guard, or `kubectl get -l relay.run-id=...`) round-trip cleanly.
 */
export function sanitizeK8sLabelValue(value: string): string {
  // Replace disallowed chars first (keep alnum, `.`, `_`, `-`).
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "-");
  // Trim leading/trailing non-alphanumerics.
  const trimmed = cleaned.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  const capped = trimmed.slice(0, DNS1123_MAX);
  // Trim again in case the cap landed on a separator.
  const final = capped.replace(/[^A-Za-z0-9]+$/g, "");
  return final || "x";
}
