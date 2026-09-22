import type { CanonicalUmlModel } from '../collaboration.types';

export type XmiDiagnosticSeverity = 'warning';

export interface XmiDiagnostic {
  code: string;
  message: string;
  severity: XmiDiagnosticSeverity;
  xmiId?: string;
  xmiType?: string;
}

export interface XmiProfile {
  id: 'uml-class-designer-xmi';
  version: string;
  xmiVersion: string | null;
  umlNamespace: string | null;
}

export interface XmiSummary {
  attributes: number;
  classes: number;
  interfaces: number;
  operations: number;
  relationships: number;
}

export interface XmiImportResult {
  diagnostics: XmiDiagnostic[];
  model: CanonicalUmlModel;
  profile: XmiProfile;
  summary: XmiSummary;
}

export interface XmiImportPreview extends Omit<XmiImportResult, 'model'> {
  currentRevision: number;
  sha256: string;
}

export interface XmiExportResult {
  bytes: Buffer;
  documentRevision: number;
  fileName: string;
  profileVersion: string;
  sha256: string;
}
