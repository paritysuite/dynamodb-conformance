const integers = new Intl.NumberFormat("en-GB");

// Presentation only: scoring and machine-readable results retain numeric values.
export const formatNumber = (n) => n == null ? "–" : integers.format(n);
