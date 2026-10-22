/** A selection for a future order/project. Custom text never creates a global type. */
export type RecipientSelection =
  | { recipientCode: string; recipientRevision: number; customLabel: null }
  | { recipientCode: null; recipientRevision: null; customLabel: string };
export interface RecipientType {
  code: string;
  label: string;
  revision: number;
}
export interface ManagedRecipientType extends RecipientType {
  sortOrder: number;
  active: boolean;
}
export interface RecipientCatalog {
  types: RecipientType[];
  customLabelAllowed: true;
  scope: "one_adult_subject_one_initiator";
}
export interface PackageTerm {
  label: string;
  text: string;
}
export interface PackageVersion {
  id: string;
  sequence: number;
  contentHash: string;
  purpose: "local_preview";
  title: string;
  price: { value: 99900; unit: "fen"; currency: "CNY" };
  scope: {
    projects: 1;
    adultSubjects: 1;
    initiators: 1;
    firstCopies: 1;
    agreedShippingIncluded: true;
    completeExportIncluded: true;
  };
  terms: PackageTerm[];
}
export interface CurrentPackage {
  purchasable: false;
  reason: "PACKAGE_PREPARING" | "PREVIEW_ONLY";
  version: PackageVersion | null;
}
export interface CatalogValidation {
  completeness: "complete" | "incomplete";
  salesAuthorized: false;
  evidenceAuthenticity: "not_verified";
  approval: "not_verified";
  previewOnly: true;
  issues: { path: string; code: string; message: string }[];
}
export interface PackageDraft {
  id: string;
  title: string;
  revision: number;
  d01: Record<string, unknown>;
  admission: Record<string, unknown>;
  shippingRegionLabels: Record<string, string>;
  validation: CatalogValidation;
}
export interface PackageDraftInput {
  shippingRegionLabels?: Record<string, string>;
  title: string;
  d01: Record<string, unknown>;
  admission: Record<string, unknown>;
}
