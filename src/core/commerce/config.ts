// Commercial configuration compiled into a release build. Empty values disable the feature:
// - no public key → an "open" build with every feature on (development and self-built copies);
// - no purchase URL → no "Buy" button;
// - no update feed → no update check.
// The vendor fills these in for official releases (see docs/COMMERCIAL.md). Nothing secret
// belongs here: the license PRIVATE key stays with the vendor.

export const COMMERCIAL = {
  /** Ed25519 public key (PEM) that verifies Pro license keys. */
  licensePublicKey: "",
  /** Web page where customers buy or manage a license (opened in the browser). */
  purchaseUrl: "",
  /** HTTPS URL of the release feed JSON (see core/commerce/updates.ts). */
  updateFeedUrl: "",
  /** License ids that must no longer be accepted (refunds, leaked keys). */
  revokedLicenses: [] as string[],
};
