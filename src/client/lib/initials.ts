/**
 * Compute 1-2 letter initials for a user name.
 *
 * Vietnamese names put the given name last, and that is the one people answer
 * to — so take the first and last word rather than the first two.
 */
export function initials(name: string | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "A3";
  const first = parts[0]![0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? "") : "";
  return (first + last).toUpperCase();
}
