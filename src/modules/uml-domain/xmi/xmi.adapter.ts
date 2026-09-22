import { createHash } from 'node:crypto';
import { SaxesParser, type SaxesAttributeNS, type SaxesTagNS } from 'saxes';
import type {
  CanonicalUmlModel,
  UmlAttribute,
  UmlClass,
  UmlClassifier,
  UmlInterface,
  UmlOperation,
  UmlParameter,
  UmlRelationship,
  UmlRelationshipEnd,
  UmlTypeReference,
} from '../collaboration.types';
import {
  UML_NAMESPACE,
  UML_PRIMITIVE_TYPES_HREF,
  XMI_EXTENSION_NAMESPACE,
  XMI_LIMITS,
  XMI_NAMESPACE,
  XMI_PROFILE_VERSION,
} from './xmi.constants';
import { XmiInteroperabilityError } from './xmi.error';
import type { XmiDiagnostic, XmiImportResult, XmiProfile, XmiSummary } from './xmi.types';

interface RawTypeReference {
  declared: boolean;
  href?: string;
  reference?: string;
}

interface RawMultiplicity {
  lower?: string;
  lowerDeclared: boolean;
  upper?: string;
  upperDeclared: boolean;
}

interface RawAttribute extends RawMultiplicity {
  defaultValue?: string;
  defaultValueDeclared: boolean;
  id?: string;
  isReadOnly: boolean;
  isStatic: boolean;
  name?: string;
  type: RawTypeReference;
  visibility?: string;
}

interface RawParameter extends RawMultiplicity {
  defaultValue?: string;
  defaultValueDeclared: boolean;
  direction?: string;
  id?: string;
  name?: string;
  type: RawTypeReference;
}

interface RawOperation {
  id?: string;
  isAbstract: boolean;
  isStatic: boolean;
  name?: string;
  parameters: RawParameter[];
  returnParameter?: RawParameter;
  visibility?: string;
}

interface RawClassifier {
  associationClass: boolean;
  attributes: RawAttribute[];
  id?: string;
  isAbstract: boolean;
  kind: 'class' | 'interface';
  name?: string;
  operations: RawOperation[];
}

interface RawDataType {
  id?: string;
  name?: string;
}

interface RawAssociationEnd extends RawMultiplicity {
  aggregation?: string;
  associationRef?: string;
  id?: string;
  name?: string;
  navigable: boolean;
  navigableDeclared: boolean;
  ownerClassifierId?: string;
  type: RawTypeReference;
}

interface RawAssociation {
  associationClass: boolean;
  ends: RawAssociationEnd[];
  id?: string;
  memberEndIds: string[];
  name?: string;
  navigableEndIds: string[];
  navigableEndIdsDeclared: boolean;
}

interface RawDirectedRelationship {
  id?: string;
  kind: 'dependency' | 'generalization' | 'realization';
  name?: string;
  source?: string;
  target?: string;
}

interface RawXmiModel {
  associationEnds: RawAssociationEnd[];
  associations: RawAssociation[];
  classifiers: RawClassifier[];
  dataTypes: RawDataType[];
  diagnostics: XmiDiagnostic[];
  directedRelationships: RawDirectedRelationship[];
  modelName?: string;
  umlNamespace: string | null;
  xmiVersion: string | null;
}

interface ParseContext {
  association?: RawAssociation;
  associationEnd?: RawAssociationEnd;
  attribute?: RawAttribute;
  classifier?: RawClassifier;
  dataType?: RawDataType;
  id?: string;
  ignoredSubtree: boolean;
  local: string;
  namespaces: Record<string, string>;
  operation?: RawOperation;
  package?: boolean;
  parameter?: RawParameter;
  text: string;
  umlContext: boolean;
}

type UmlVisibility = UmlAttribute['visibility'];

export interface XmiCanonicalSeed {
  createdAt: string;
  diagramId: string;
  diagramName: string;
  projectId: string;
  projectName: string;
  revision: number;
  updatedAt: string;
}

const omgPrimitiveNames = new Map([
  ['boolean', 'Boolean'],
  ['integer', 'Integer'],
  ['real', 'Real'],
  ['string', 'String'],
  ['unlimitednatural', 'UnlimitedNatural'],
]);

function omgPrimitiveName(value: string): string | undefined {
  return omgPrimitiveNames.get(value.toLocaleLowerCase('en'));
}

// Enterprise Architect 15 exporta el perfil "XMI 2.5.1" con el namespace UML 2.5
// (20131001), no con el 20161101 de UML 2.5.1. El subconjunto soportado es el
// mismo; se acepta el namespace documentado para interoperar sin ampliar la
// semantica del perfil.
const UML_NAMESPACES: ReadonlySet<string> = new Set([
  UML_NAMESPACE,
  'http://www.omg.org/spec/UML/20131001',
]);

function isUmlNamespace(uri: string | undefined): boolean {
  return !uri || UML_NAMESPACES.has(uri);
}

// Enterprise Architect publica los tipos de parametros y atributos con el
// prefijo del lenguaje configurado (por ejemplo EAJava_Order). El sufijo es el
// nombre UML real; se resuelve contra primitivas OMG o un clasificador unico.
function eaVendorTypeName(reference: string): string | undefined {
  const match = /^EA[A-Za-z]+_(.+)$/u.exec(reference);
  return match?.[1];
}

function isAsciiOnly(bytes: Buffer): boolean {
  for (const byte of bytes) {
    if (byte > 0x7f) return false;
  }
  return true;
}

// El adaptador de Enterprise Architect lee unicamente las declaraciones de
// tipos primitivos que EA agrega en su xmi:Extension. El resto del arbol de
// extensiones permanece opaco.
function collectEaPrimitiveTypes(bytes: Buffer): Map<string, string> {
  const primitives = new Map<string, string>();
  if (!bytes.includes(Buffer.from('primitivetypes', 'utf8'))) return primitives;

  let extensionDepth = 0;
  let depth = 0;
  let failed = false;
  const parser = new SaxesParser({ defaultXMLVersion: '1.0', xmlns: true, position: true });
  parser.on('error', () => {
    failed = true;
  });
  parser.on('opentag', (tag) => {
    depth += 1;
    if (tag.local === 'Extension' && tag.uri === XMI_NAMESPACE) {
      extensionDepth = depth;
    }
    if (extensionDepth === 0 || tag.local !== 'packagedElement') return;
    const attributes = Object.values(tag.attributes) as SaxesAttributeNS[];
    const xmiType = attributes.find(
      (attribute) => attribute.local === 'type' && attribute.uri === XMI_NAMESPACE,
    )?.value;
    if (fragmentName(xmiType)?.toLocaleLowerCase('en') !== 'primitivetype') return;
    const id = attributes
      .find((attribute) => attribute.local === 'id' && attribute.uri === XMI_NAMESPACE)
      ?.value.trim();
    const name = attributes
      .find((attribute) => attribute.local === 'name' && isUmlNamespace(attribute.uri))
      ?.value.trim();
    if (id && name) primitives.set(id, name);
  });
  parser.on('closetag', () => {
    if (extensionDepth === depth) extensionDepth = 0;
    depth -= 1;
  });
  try {
    parser.write(bytes.toString('utf8')).close();
  } catch {
    return new Map();
  }
  return failed ? new Map() : primitives;
}

const supportedUmlLocalNames = new Set([
  'Class',
  'Interface',
  'Model',
  'Package',
  'defaultValue',
  'generalization',
  'interfaceRealization',
  'lowerValue',
  'memberEnd',
  'navigableOwnedEnd',
  'ownedAttribute',
  'ownedEnd',
  'ownedOperation',
  'ownedParameter',
  'packagedElement',
  'type',
  'upperValue',
]);

const supportedPackagedElementTypes = new Set([
  'association',
  'associationclass',
  'class',
  'datatype',
  'dependency',
  'interface',
  'model',
  'package',
  'primitivetype',
  'realization',
]);

function diagnostic(
  code: string,
  message: string,
  xmiId?: string,
  xmiType?: string,
): XmiDiagnostic {
  return {
    code,
    message,
    severity: 'warning',
    ...(xmiId ? { xmiId } : {}),
    ...(xmiType ? { xmiType } : {}),
  };
}

function xmiError(
  code: ConstructorParameters<typeof XmiInteroperabilityError>[0],
  message: string,
  status: ConstructorParameters<typeof XmiInteroperabilityError>[2] = 400,
): never {
  throw new XmiInteroperabilityError(code, message, status);
}

function xmiAttribute(tag: SaxesTagNS, local: string): string | undefined {
  for (const attribute of Object.values(tag.attributes) as SaxesAttributeNS[]) {
    if (attribute.local === local && attribute.uri === XMI_NAMESPACE) {
      return attribute.value;
    }
  }
  return undefined;
}

function plainAttribute(tag: SaxesTagNS, local: string): string | undefined {
  const values: string[] = [];
  for (const attribute of Object.values(tag.attributes) as SaxesAttributeNS[]) {
    if (attribute.local === local && isUmlNamespace(attribute.uri)) {
      values.push(attribute.value);
    }
  }
  if (values.length > 1 && !values.every((value) => value === values[0])) {
    xmiError('XMI_MALFORMED', `El atributo UML ${local} se declara con valores conflictivos.`);
  }
  return values[0];
}

function extensionAttribute(tag: SaxesTagNS, local: string): string | undefined {
  for (const attribute of Object.values(tag.attributes) as SaxesAttributeNS[]) {
    if (attribute.local === local && attribute.uri === XMI_EXTENSION_NAMESPACE) {
      return attribute.value;
    }
  }
  return undefined;
}

function umlType(tag: SaxesTagNS, namespaces: Readonly<Record<string, string>>): string {
  const value = xmiAttribute(tag, 'type')?.trim();
  if (!value) return '';
  const parts = value.split(':');
  if (parts.length > 2) return '';
  const local = parts.at(-1)?.trim();
  if (!local) return '';
  const prefix = parts.length === 2 ? parts[0]?.trim() : undefined;
  if (prefix === 'xmi' && namespaces['xmi'] !== XMI_NAMESPACE) {
    xmiError(
      'XMI_UNSUPPORTED_PROFILE',
      'El prefijo xmi está reservado para el namespace XMI en valores QName.',
      415,
    );
  }
  if (prefix && !UML_NAMESPACES.has(namespaces[prefix] ?? '')) return '';
  if (!prefix && namespaces[''] && !UML_NAMESPACES.has(namespaces[''])) return '';
  return local.toLocaleLowerCase('en');
}

function isUmlSemanticElement(tag: SaxesTagNS, parentUmlContext: boolean): boolean {
  return UML_NAMESPACES.has(tag.uri) || (!tag.uri && parentUmlContext);
}

interface XmiAttributeRule {
  extension?: readonly string[];
  plain: readonly string[];
  xmi: readonly string[];
}

function supportedAttributeRule(local: string, type: string): XmiAttributeRule | undefined {
  if (local === 'Model') return { plain: ['name'], xmi: ['id', 'type'] };
  if (local === 'Class') return { plain: ['isAbstract', 'name'], xmi: ['id', 'type'] };
  if (local === 'Interface') return { plain: ['isAbstract', 'name'], xmi: ['id', 'type'] };
  if (local === 'ownedAttribute') {
    return {
      plain: [
        'association',
        'isReadOnly',
        'isStatic',
        'lower',
        'name',
        'type',
        'upper',
        'visibility',
      ],
      xmi: ['id', 'type'],
    };
  }
  if (local === 'ownedOperation') {
    return { plain: ['isAbstract', 'isStatic', 'name', 'visibility'], xmi: ['id'] };
  }
  if (local === 'ownedParameter') {
    return { plain: ['direction', 'lower', 'name', 'type', 'upper'], xmi: ['id'] };
  }
  if (local === 'ownedEnd') {
    return {
      plain: [
        'aggregation',
        'association',
        'isNavigable',
        'isReadOnly',
        'lower',
        'name',
        'type',
        'upper',
      ],
      xmi: ['id', 'type'],
    };
  }
  if (local === 'navigableOwnedEnd') return { plain: ['idref'], xmi: ['idref'] };
  if (local === 'generalization') return { plain: ['general', 'name'], xmi: ['id', 'type'] };
  if (local === 'interfaceRealization') {
    return { plain: ['client', 'contract', 'name', 'supplier'], xmi: ['id', 'type'] };
  }
  if (local === 'type') return { plain: ['href', 'type'], xmi: ['idref', 'type'] };
  if (local === 'defaultValue') return { plain: ['value'], xmi: ['type'] };
  if (local === 'lowerValue' || local === 'upperValue') {
    return { plain: ['value'], xmi: ['id', 'type'] };
  }
  if (local !== 'packagedElement') return undefined;
  if (type === 'class') return { plain: ['isAbstract', 'name'], xmi: ['id', 'type'] };
  if (type === 'interface') return { plain: ['isAbstract', 'name'], xmi: ['id', 'type'] };
  if (type === 'datatype' || type === 'primitivetype') {
    return { plain: ['name'], xmi: ['id', 'type'] };
  }
  if (type === 'package') return { plain: ['name'], xmi: ['id', 'type'] };
  if (type === 'realization') {
    return { plain: ['client', 'name', 'supplier'], xmi: ['id', 'type'] };
  }
  if (type === 'association') {
    return { plain: ['memberEnd', 'name', 'navigableOwnedEnd'], xmi: ['id', 'type'] };
  }
  if (type === 'associationclass') {
    return {
      extension: ['associationName'],
      plain: ['isAbstract', 'memberEnd', 'name', 'navigableOwnedEnd'],
      xmi: ['id', 'type'],
    };
  }
  if (type === 'dependency') {
    return { plain: ['client', 'name', 'supplier'], xmi: ['id', 'type'] };
  }
  return undefined;
}

function assertSupportedUmlAttributes(tag: SaxesTagNS, local: string, type: string): void {
  const rule = supportedAttributeRule(local, type);
  if (!rule) return;
  if (local === 'ownedAttribute' || local === 'ownedEnd') {
    const xmiType = xmiAttribute(tag, 'type')?.trim();
    const localType = xmiType?.split(':').at(-1)?.toLocaleLowerCase('en');
    if (xmiType && localType !== 'property') {
      xmiError(
        'XMI_UNSUPPORTED_FEATURE',
        'El perfil XMI solo admite xmi:type uml:Property en miembros de asociacion.',
      );
    }
  }
  for (const attribute of Object.values(tag.attributes) as SaxesAttributeNS[]) {
    if (
      attribute.name === 'xmlns' ||
      attribute.prefix === 'xmlns' ||
      attribute.uri === 'http://www.w3.org/2000/xmlns/'
    ) {
      continue;
    }
    const allowed =
      attribute.uri === XMI_NAMESPACE
        ? rule.xmi
        : attribute.uri === XMI_EXTENSION_NAMESPACE
          ? (rule.extension ?? [])
          : isUmlNamespace(attribute.uri)
            ? rule.plain
            : [];
    if (!allowed.includes(attribute.local)) {
      xmiError(
        'XMI_UNSUPPORTED_FEATURE',
        `El perfil XMI no admite el atributo ${attribute.name} en ${tag.name}.`,
      );
    }
  }
}

function assertSupportedXmiRootAttributes(tag: SaxesTagNS): void {
  for (const attribute of Object.values(tag.attributes) as SaxesAttributeNS[]) {
    if (
      attribute.name === 'xmlns' ||
      attribute.prefix === 'xmlns' ||
      attribute.uri === 'http://www.w3.org/2000/xmlns/'
    ) {
      continue;
    }
    if (attribute.uri !== XMI_NAMESPACE || attribute.local !== 'version') {
      xmiError(
        'XMI_UNSUPPORTED_FEATURE',
        `El perfil XMI no admite el atributo ${attribute.name} en xmi:XMI.`,
      );
    }
  }
}

function assertUmlContainment(parent: ParseContext | undefined, local: string): void {
  const unsupported = () =>
    xmiError(
      'XMI_UNSUPPORTED_FEATURE',
      `El elemento UML ${local} no está permitido dentro de ${parent?.local ?? 'la raíz'}.`,
    );
  if (local === 'Model') {
    if (parent?.local !== 'XMI') unsupported();
    return;
  }
  if (parent?.local === 'Model') {
    if (local !== 'packagedElement') unsupported();
    return;
  }
  if (parent?.package) {
    if (local !== 'packagedElement') unsupported();
    return;
  }
  if (parent?.association) {
    const allowed = parent.classifier
      ? new Set([
          'generalization',
          'interfaceRealization',
          'memberEnd',
          'navigableOwnedEnd',
          'ownedAttribute',
          'ownedEnd',
          'ownedOperation',
        ])
      : new Set(['memberEnd', 'navigableOwnedEnd', 'ownedEnd']);
    if (!allowed.has(local)) unsupported();
    return;
  }
  if (parent?.classifier) {
    if (
      !new Set(['generalization', 'interfaceRealization', 'ownedAttribute', 'ownedOperation']).has(
        local,
      )
    ) {
      unsupported();
    }
    return;
  }
  if (parent?.operation) {
    if (local !== 'ownedParameter') unsupported();
    return;
  }
  if (parent?.attribute || parent?.associationEnd || parent?.parameter) {
    if (!new Set(['defaultValue', 'lowerValue', 'type', 'upperValue']).has(local)) unsupported();
    return;
  }
  if (parent?.local === 'ownedEnd') {
    if (local !== 'lowerValue' && local !== 'upperValue') unsupported();
    return;
  }
  unsupported();
}

function boolAttribute(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLocaleLowerCase('en');
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  xmiError('XMI_MALFORMED', 'Un atributo booleano XMI no tiene un valor válido.');
}

function references(value: string | undefined): string[] {
  return value?.trim().split(/\s+/u).filter(Boolean) ?? [];
}

function validUtf8(bytes: Buffer): string {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    xmiError('XMI_INVALID_ENCODING', 'El XMI debe estar codificado en UTF-8.');
  }
  return text;
}

function requireIdentifier(value: string | undefined, label: string): string {
  if (!value || value !== value.trim() || /\s/u.test(value)) {
    xmiError('XMI_MALFORMED', `${label} no declara xmi:id.`);
  }
  return value;
}

function requireName(value: string | undefined, label: string): string {
  if (value === undefined || value.trim().length === 0 || /[\t\n\r]/u.test(value)) {
    xmiError('XMI_MALFORMED', `${label} no declara un nombre válido.`);
  }
  return value;
}

function requireRoundTrippableAttributeValue(value: string, label: string): string {
  if (/[\t\n\r]/u.test(value)) {
    xmiError(
      'XMI_UNSUPPORTED_FEATURE',
      `${label} contiene espacios de atributo que el perfil XMI no puede preservar.`,
    );
  }
  return value;
}

function canonicalId(kind: string, externalId: string): string {
  if (new RegExp(`^xmi_${kind}_[a-f0-9]{40}$`, 'u').test(externalId)) {
    return externalId;
  }
  const digest = createHash('sha256')
    .update(`uml-class-designer/xmi/${XMI_PROFILE_VERSION}/${kind}/${externalId}`, 'utf8')
    .digest('hex')
    .slice(0, 40);
  return `xmi_${kind}_${digest}`;
}

function fragmentName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const fragment = trimmed.slice(Math.max(trimmed.lastIndexOf('#'), trimmed.lastIndexOf('/')) + 1);
  return fragment.trim() || undefined;
}

function multiplicity(lower: string | undefined, upper: string | undefined): string {
  const normalizedLower = lower === undefined ? '1' : lower.trim();
  const normalizedUpper = upper === undefined ? '1' : upper.trim();
  const upperValue = normalizedUpper === '-1' ? '*' : normalizedUpper;
  if (!/^\d+$/u.test(normalizedLower) || !/^(?:\d+|\*)$/u.test(upperValue)) {
    xmiError('XMI_MALFORMED', 'Una multiplicidad XMI no tiene límites enteros válidos.');
  }
  if (upperValue !== '*' && BigInt(normalizedLower) > BigInt(upperValue)) {
    xmiError(
      'XMI_MALFORMED',
      'Una multiplicidad XMI tiene un límite inferior mayor que el superior.',
    );
  }
  if (normalizedLower === normalizedUpper) return normalizedLower;
  if (normalizedLower === '1' && upperValue === '1') return '1';
  return `${normalizedLower}..${upperValue}`;
}

function typeMultiplicity(
  lower: string | undefined,
  upper: string | undefined,
): Pick<UmlTypeReference, 'collection' | 'nullable'> {
  switch (multiplicity(lower, upper)) {
    case '0..1':
      return { collection: false, nullable: true };
    case '1':
      return { collection: false, nullable: false };
    case '0..*':
      return { collection: true, nullable: true };
    case '1..*':
      return { collection: true, nullable: false };
    default:
      xmiError(
        'XMI_UNSUPPORTED_FEATURE',
        'El perfil XMI solo admite multiplicidades de tipo 0..1, 1, 0..* y 1..*.',
      );
  }
}

function normalizeVisibility(
  raw: string | undefined,
  diagnostics: XmiDiagnostic[],
  xmiId: string,
): UmlVisibility {
  const normalized = raw?.trim().toLocaleLowerCase('en');
  if (!normalized || normalized === 'public') return 'public';
  if (normalized === 'protected' || normalized === 'private' || normalized === 'package') {
    return normalized;
  }
  diagnostics.push(
    diagnostic(
      'XMI_UNSUPPORTED_VISIBILITY',
      'La visibilidad no soportada se normalizó a public.',
      xmiId,
    ),
  );
  return 'public';
}

function parseXmi(bytes: Buffer): RawXmiModel {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) {
    xmiError('XMI_MALFORMED', 'El archivo XMI está vacío.');
  }
  if (bytes.byteLength > XMI_LIMITS.maxBytes) {
    xmiError(
      'XMI_LIMIT_EXCEEDED',
      `El archivo XMI supera el límite de ${XMI_LIMITS.maxBytes} bytes.`,
      413,
    );
  }

  const text = validUtf8(bytes);
  if (text.includes('\0') || !text.trimStart().startsWith('<')) {
    xmiError('XMI_BINARY_CONTENT', 'El contenido no es XML XMI válido.');
  }

  const raw: RawXmiModel = {
    associationEnds: [],
    associations: [],
    classifiers: [],
    dataTypes: [],
    diagnostics: [],
    directedRelationships: [],
    umlNamespace: null,
    xmiVersion: null,
  };
  const contexts: ParseContext[] = [];
  const seenIds = new Set<string>();
  const unsupported = new Set<string>();
  let nodeCount = 0;
  let sawModelContainer = false;
  let sawXmiRoot = false;
  let textCharacters = 0;
  const startedAt = performance.now();

  const checkBudget = () => {
    if (performance.now() - startedAt > XMI_LIMITS.maxProcessingMs) {
      xmiError('XMI_LIMIT_EXCEEDED', 'El procesamiento XMI excedió el presupuesto permitido.', 408);
    }
  };

  const currentClassifier = (): RawClassifier | undefined => {
    for (let index = contexts.length - 1; index >= 0; index -= 1) {
      const candidate = contexts[index];
      if (candidate?.attribute || candidate?.operation || candidate?.parameter) {
        continue;
      }
      if (candidate?.classifier) return candidate.classifier;
    }
    return undefined;
  };

  const currentDataType = (): RawDataType | undefined => {
    for (let index = contexts.length - 1; index >= 0; index -= 1) {
      const dataType = contexts[index]?.dataType;
      if (dataType) return dataType;
    }
    return undefined;
  };

  const currentAssociation = (): RawAssociation | undefined => {
    for (let index = contexts.length - 1; index >= 0; index -= 1) {
      const association = contexts[index]?.association;
      if (association) return association;
    }
    return undefined;
  };

  const currentOperation = (): RawOperation | undefined => {
    for (let index = contexts.length - 1; index >= 0; index -= 1) {
      const operation = contexts[index]?.operation;
      if (operation) return operation;
    }
    return undefined;
  };

  const currentMember = (): RawAttribute | RawAssociationEnd | RawParameter | undefined => {
    for (let index = contexts.length - 1; index >= 0; index -= 1) {
      const context = contexts[index];
      if (context?.attribute) return context.attribute;
      if (context?.associationEnd) return context.associationEnd;
      if (context?.parameter) return context.parameter;
    }
    return undefined;
  };

  const parser = new SaxesParser({ defaultXMLVersion: '1.0', xmlns: true, position: true });
  parser.on('xmldecl', (declaration) => {
    if (declaration.version && declaration.version !== '1.0') {
      xmiError('XMI_UNSUPPORTED_PROFILE', 'El perfil XMI soporta únicamente XML 1.0.', 415);
    }
    if (declaration.encoding) {
      const encoding = declaration.encoding.trim().toLocaleLowerCase('en');
      const legacyAscii = ['ascii', 'iso-8859-1', 'us-ascii', 'windows-1252'].includes(encoding);
      if (encoding !== 'utf-8' && !(legacyAscii && isAsciiOnly(bytes))) {
        xmiError(
          'XMI_INVALID_ENCODING',
          'El XMI debe declarar codificación UTF-8 o una codificación ASCII compatible.',
        );
      }
    }
  });
  parser.on('doctype', () => {
    xmiError(
      'XMI_DOCTYPE_FORBIDDEN',
      'El XMI no puede incluir DOCTYPE ni entidades personalizadas.',
    );
  });
  parser.on('error', () => {
    xmiError('XMI_MALFORMED', 'El archivo XMI no está bien formado.');
  });
  parser.on('opentag', (tag) => {
    checkBudget();
    nodeCount += 1;
    if (nodeCount > XMI_LIMITS.maxNodes) {
      xmiError('XMI_LIMIT_EXCEEDED', 'El XMI supera la cantidad máxima de nodos permitida.', 413);
    }
    if (contexts.length + 1 > XMI_LIMITS.maxDepth) {
      xmiError('XMI_LIMIT_EXCEEDED', 'El XMI supera la profundidad máxima permitida.', 413);
    }
    const parent = contexts.at(-1);
    const attributes = Object.values(tag.attributes) as SaxesAttributeNS[];
    if (attributes.length > XMI_LIMITS.maxAttributeCount) {
      xmiError('XMI_LIMIT_EXCEEDED', 'Un nodo XMI supera la cantidad máxima de atributos.', 413);
    }
    if (tag.name.length > XMI_LIMITS.maxValueCharacters) {
      xmiError('XMI_LIMIT_EXCEEDED', 'Un nombre de nodo XMI supera el límite permitido.', 413);
    }
    for (const attribute of attributes) {
      if (attribute.value.length > XMI_LIMITS.maxValueCharacters) {
        xmiError('XMI_LIMIT_EXCEEDED', 'Un atributo XMI supera el límite permitido.', 413);
      }
    }

    const local = tag.local;
    if (contexts.length === 0) {
      if (local !== 'XMI' || tag.uri !== XMI_NAMESPACE) {
        xmiError(
          'XMI_UNSUPPORTED_PROFILE',
          'El documento debe usar xmi:XMI del perfil soportado.',
          415,
        );
      }
      sawXmiRoot = true;
    }
    if (!parent?.ignoredSubtree && tag.prefix === 'xmi' && tag.uri !== XMI_NAMESPACE) {
      xmiError(
        'XMI_UNSUPPORTED_PROFILE',
        'El prefijo xmi debe usar el namespace XMI soportado.',
        415,
      );
    }
    if (!parent?.ignoredSubtree) {
      for (const attribute of attributes) {
        if (attribute.prefix === 'xmi' && attribute.uri !== XMI_NAMESPACE) {
          xmiError(
            'XMI_UNSUPPORTED_PROFILE',
            'El prefijo xmi debe usar el namespace XMI soportado.',
            415,
          );
        }
      }
    }
    const namespaces = { ...parent?.namespaces, ...tag.ns };
    const parentUmlContext = parent?.umlContext === true;
    const type = parent?.ignoredSubtree ? '' : umlType(tag, namespaces);
    const rawUmlElement = isUmlSemanticElement(tag, parentUmlContext);
    const extensionElement =
      (local === 'Extension' && !isUmlNamespace(tag.uri)) || type === 'extension';
    const foreignNamespaceElement =
      Boolean(tag.uri) && !UML_NAMESPACES.has(tag.uri) && tag.uri !== XMI_NAMESPACE;
    const metadataElement = local === 'Documentation' && tag.uri === XMI_NAMESPACE;
    const modelElement = rawUmlElement && local === 'Model';
    const containerPackage =
      rawUmlElement && (local === 'Package' || (local === 'packagedElement' && type === 'package'));
    const disallowedContainer = rawUmlElement && local === 'packagedElement' && type === 'model';
    const unsupportedUmlElement =
      rawUmlElement &&
      (!supportedUmlLocalNames.has(local) ||
        (local === 'packagedElement' && !supportedPackagedElementTypes.has(type)));
    const ignoredSubtree =
      parent?.ignoredSubtree === true ||
      extensionElement ||
      foreignNamespaceElement ||
      metadataElement ||
      disallowedContainer ||
      unsupportedUmlElement;
    const isUmlElement = !ignoredSubtree && rawUmlElement;
    if (
      !parent?.ignoredSubtree &&
      tag.uri === XMI_NAMESPACE &&
      local !== 'Documentation' &&
      local !== 'Extension' &&
      local !== 'XMI'
    ) {
      xmiError('XMI_UNSUPPORTED_FEATURE', `El perfil XMI no admite el elemento ${tag.name}.`);
    }
    const id = parent?.ignoredSubtree ? undefined : xmiAttribute(tag, 'id');
    if (id) {
      if (seenIds.has(id)) xmiError('XMI_DUPLICATE_ID', 'El XMI contiene xmi:id duplicados.');
      seenIds.add(id);
    }
    if (local === 'XMI' && parent && !parent.ignoredSubtree) {
      xmiError('XMI_UNSUPPORTED_PROFILE', 'xmi:XMI solo puede ser el elemento raíz.', 415);
    }
    if (parent?.local === 'XMI' && !parent.ignoredSubtree) {
      if (
        local !== 'Model' &&
        local !== 'XMI' &&
        !metadataElement &&
        !extensionElement &&
        !foreignNamespaceElement
      ) {
        xmiError(
          'XMI_UNSUPPORTED_PROFILE',
          'xmi:XMI solo puede contener un uml:Model o extensiones ignoradas.',
          415,
        );
      }
    }
    const context: ParseContext = {
      id,
      ignoredSubtree,
      local,
      namespaces,
      package: containerPackage,
      text: '',
      umlContext: rawUmlElement,
    };
    if (local === 'XMI' && !parent?.ignoredSubtree) {
      assertSupportedXmiRootAttributes(tag);
      raw.xmiVersion = xmiAttribute(tag, 'version') ?? null;
    }
    if (isUmlElement) {
      assertSupportedUmlAttributes(tag, local, type);
      assertUmlContainment(parent, local);
    }
    const modelContainer = modelElement && parent?.local === 'XMI';

    if (!ignoredSubtree && UML_NAMESPACES.has(tag.uri)) raw.umlNamespace = tag.uri;
    if ((extensionElement || foreignNamespaceElement) && !parent?.ignoredSubtree) {
      const key = id ?? tag.name;
      if (!unsupported.has(key)) {
        unsupported.add(key);
        raw.diagnostics.push(
          diagnostic(
            'XMI_EXTENSION_IGNORED',
            extensionElement
              ? 'La extensión propietaria de XMI se ignoró.'
              : 'La extensión con namespace no soportado se ignoró.',
            id,
            tag.name,
          ),
        );
      }
    } else if (containerPackage && !parent?.ignoredSubtree) {
      const key = `package:${id ?? plainAttribute(tag, 'name') ?? tag.name}`;
      if (!unsupported.has(key)) {
        unsupported.add(key);
        raw.diagnostics.push(
          diagnostic(
            'XMI_PACKAGE_FLATTENED',
            'El paquete UML se aplano al modelo canonico sin jerarquia; los nombres deben seguir siendo unicos.',
            id,
            'package',
          ),
        );
      }
    } else if (disallowedContainer && !parent?.ignoredSubtree) {
      xmiError('XMI_UNSUPPORTED_FEATURE', 'El perfil XMI no admite modelos anidados.');
    } else if (modelElement && !ignoredSubtree) {
      if (!modelContainer || sawModelContainer) {
        xmiError(
          'XMI_UNSUPPORTED_FEATURE',
          'El perfil XMI requiere un único uml:Model hijo directo de xmi:XMI.',
        );
      }
      sawModelContainer = true;
      // Enterprise Architect exporta un uml:Model sintetico sin xmi:id; el id
      // del modelo XMI no forma parte del contrato canonico.
      raw.modelName ??= plainAttribute(tag, 'name');
    } else if (unsupportedUmlElement && !parent?.ignoredSubtree) {
      const xmiType = type || xmiAttribute(tag, 'type') || local;
      const key = `${xmiType}:${id ?? ''}`;
      if (!unsupported.has(key)) {
        unsupported.add(key);
        raw.diagnostics.push(
          diagnostic(
            'XMI_UNSUPPORTED_ELEMENT',
            `El elemento UML ${xmiType} no está soportado.`,
            id,
            xmiType,
          ),
        );
      }
    }

    const associationClass = type === 'associationclass';
    const dataTypeElement = type === 'datatype';
    const classifierKind =
      type === 'interface' || local === 'Interface'
        ? 'interface'
        : type === 'class' || associationClass || local === 'Class'
          ? 'class'
          : null;
    if (isUmlElement && local === 'packagedElement' && type === 'primitivetype') {
      xmiError(
        'XMI_UNSUPPORTED_FEATURE',
        'El perfil XMI no admite primitivas locales; use DataType o una primitiva OMG oficial.',
      );
    } else if (isUmlElement && dataTypeElement && local === 'packagedElement') {
      const dataType = { id, name: plainAttribute(tag, 'name') };
      raw.dataTypes.push(dataType);
      context.dataType = dataType;
    } else if (isUmlElement && classifierKind) {
      const classifier: RawClassifier = {
        associationClass,
        attributes: [],
        id,
        isAbstract: boolAttribute(plainAttribute(tag, 'isAbstract')),
        kind: classifierKind,
        name: plainAttribute(tag, 'name'),
        operations: [],
      };
      raw.classifiers.push(classifier);
      context.classifier = classifier;
      if (associationClass) {
        const exportedAssociationName = extensionAttribute(tag, 'associationName');
        if (exportedAssociationName !== undefined && exportedAssociationName.trim().length === 0) {
          xmiError(
            'XMI_UNSUPPORTED_FEATURE',
            'El perfil XMI exige un nombre no vacío para la relación de una clase asociativa.',
          );
        }
        const navigableOwnedEnd = plainAttribute(tag, 'navigableOwnedEnd');
        const association: RawAssociation = {
          associationClass: true,
          ends: [],
          id,
          memberEndIds: references(plainAttribute(tag, 'memberEnd')),
          name: exportedAssociationName ?? classifier.name,
          navigableEndIds: references(navigableOwnedEnd),
          navigableEndIdsDeclared: navigableOwnedEnd !== undefined,
        };
        raw.associations.push(association);
        context.association = association;
      }
    } else if (isUmlElement && local === 'packagedElement' && type === 'association') {
      const navigableOwnedEnd = plainAttribute(tag, 'navigableOwnedEnd');
      const association: RawAssociation = {
        associationClass: false,
        ends: [],
        id,
        memberEndIds: references(plainAttribute(tag, 'memberEnd')),
        name: plainAttribute(tag, 'name'),
        navigableEndIds: references(navigableOwnedEnd),
        navigableEndIdsDeclared: navigableOwnedEnd !== undefined,
      };
      raw.associations.push(association);
      context.association = association;
    } else if (isUmlElement && local === 'ownedAttribute') {
      if (currentDataType()) {
        xmiError(
          'XMI_UNSUPPORTED_FEATURE',
          'El perfil XMI solo admite tipos de dato nominales sin atributos.',
        );
      }
      const classifier = currentClassifier();
      if (classifier) {
        const associationRef = plainAttribute(tag, 'association');
        const lower = plainAttribute(tag, 'lower');
        const typeReference = plainAttribute(tag, 'type');
        const upper = plainAttribute(tag, 'upper');
        if (associationRef) {
          // Enterprise Architect publica extremos navegables como propiedades
          // del clasificador propietario, referenciando la asociacion.
          const end: RawAssociationEnd = {
            aggregation: plainAttribute(tag, 'aggregation'),
            associationRef,
            id,
            lower,
            lowerDeclared: lower !== undefined,
            name: plainAttribute(tag, 'name'),
            navigable: true,
            navigableDeclared: true,
            ownerClassifierId: classifier.id,
            type: { declared: typeReference !== undefined, reference: typeReference },
            upper,
            upperDeclared: upper !== undefined,
          };
          raw.associationEnds.push(end);
          context.associationEnd = end;
        } else {
          const attribute: RawAttribute = {
            defaultValueDeclared: false,
            id,
            isReadOnly: boolAttribute(plainAttribute(tag, 'isReadOnly')),
            isStatic: boolAttribute(plainAttribute(tag, 'isStatic')),
            lower,
            lowerDeclared: lower !== undefined,
            name: plainAttribute(tag, 'name'),
            type: { declared: typeReference !== undefined, reference: typeReference },
            upper,
            upperDeclared: upper !== undefined,
            visibility: plainAttribute(tag, 'visibility'),
          };
          classifier.attributes.push(attribute);
          context.attribute = attribute;
        }
      }
    } else if (isUmlElement && local === 'ownedOperation') {
      if (currentDataType()) {
        xmiError(
          'XMI_UNSUPPORTED_FEATURE',
          'El perfil XMI solo admite tipos de dato nominales sin operaciones.',
        );
      }
      const classifier = currentClassifier();
      if (classifier) {
        const operation: RawOperation = {
          id,
          isAbstract: boolAttribute(plainAttribute(tag, 'isAbstract')),
          isStatic: boolAttribute(plainAttribute(tag, 'isStatic')),
          name: plainAttribute(tag, 'name'),
          parameters: [],
          visibility: plainAttribute(tag, 'visibility'),
        };
        classifier.operations.push(operation);
        context.operation = operation;
      }
    } else if (isUmlElement && local === 'ownedParameter') {
      const operation = currentOperation();
      if (operation) {
        const direction = plainAttribute(tag, 'direction');
        if (direction && direction !== 'in' && direction !== 'return') {
          xmiError(
            'XMI_UNSUPPORTED_FEATURE',
            'El perfil XMI solo admite parámetros de entrada y un único retorno.',
          );
        }
        const lower = plainAttribute(tag, 'lower');
        const name = plainAttribute(tag, 'name');
        const typeReference = plainAttribute(tag, 'type');
        const upper = plainAttribute(tag, 'upper');
        const parameter: RawParameter = {
          defaultValueDeclared: false,
          direction,
          id,
          lower,
          lowerDeclared: lower !== undefined,
          name,
          type: { declared: typeReference !== undefined, reference: typeReference },
          upper,
          upperDeclared: upper !== undefined,
        };
        if (parameter.direction === 'return') {
          if (parameter.name !== 'return') {
            xmiError(
              'XMI_UNSUPPORTED_FEATURE',
              'El perfil XMI exige que el parámetro de retorno se llame return.',
            );
          }
          if (operation.returnParameter) {
            // Enterprise Architect reexporta el retorno una vez como parametro
            // importado y otra como marcador RT sintetico. Solo se tolera el
            // duplicado cuando es semanticamente identico.
            const previous = operation.returnParameter;
            const duplicated =
              previous.type.reference === parameter.type.reference &&
              previous.type.href === parameter.type.href &&
              multiplicity(previous.lower, previous.upper) ===
                multiplicity(parameter.lower, parameter.upper);
            if (!duplicated) {
              xmiError('XMI_MALFORMED', 'Una operación XMI no puede declarar más de un retorno.');
            }
          } else {
            operation.returnParameter = parameter;
          }
        } else operation.parameters.push(parameter);
        context.parameter = parameter;
      }
    } else if (isUmlElement && local === 'ownedEnd') {
      const association = currentAssociation();
      if (association) {
        const aggregation = plainAttribute(tag, 'aggregation');
        const navigable = plainAttribute(tag, 'isNavigable');
        const lower = plainAttribute(tag, 'lower');
        const upper = plainAttribute(tag, 'upper');
        if (
          aggregation &&
          !['none', 'shared', 'composite'].includes(aggregation.trim().toLocaleLowerCase('en'))
        ) {
          xmiError('XMI_MALFORMED', 'Una asociación XMI declara una agregación inválida.');
        }
        const typeReference = plainAttribute(tag, 'type');
        const end: RawAssociationEnd = {
          aggregation,
          id,
          lower,
          lowerDeclared: lower !== undefined,
          name: plainAttribute(tag, 'name'),
          navigable: boolAttribute(navigable),
          navigableDeclared: navigable !== undefined,
          type: { declared: typeReference !== undefined, reference: typeReference },
          upper,
          upperDeclared: upper !== undefined,
        };
        association.ends.push(end);
        context.associationEnd = end;
      }
    } else if (isUmlElement && local === 'memberEnd') {
      const association = currentAssociation();
      const reference = xmiAttribute(tag, 'idref') ?? plainAttribute(tag, 'idref');
      if (!reference) {
        xmiError('XMI_MALFORMED', 'Un memberEnd XMI debe declarar una referencia de extremo.');
      }
      if (association) association.memberEndIds.push(reference);
    } else if (isUmlElement && local === 'navigableOwnedEnd') {
      const association = currentAssociation();
      const xmiReference = xmiAttribute(tag, 'idref');
      const plainReference = plainAttribute(tag, 'idref');
      if (xmiReference && plainReference && xmiReference !== plainReference) {
        xmiError('XMI_MALFORMED', 'Un extremo navegable XMI declara referencias conflictivas.');
      }
      const reference = xmiReference ?? plainReference;
      if (!reference) {
        xmiError('XMI_MALFORMED', 'Un extremo navegable XMI debe declarar una referencia.');
      }
      if (association) {
        association.navigableEndIdsDeclared = true;
        association.navigableEndIds.push(reference);
      }
    } else if (isUmlElement && local === 'generalization') {
      const classifier = currentClassifier();
      raw.directedRelationships.push({
        id,
        kind: 'generalization',
        name: plainAttribute(tag, 'name'),
        source: classifier?.id,
        target: plainAttribute(tag, 'general'),
      });
    } else if (isUmlElement && local === 'interfaceRealization') {
      const classifier = currentClassifier();
      raw.directedRelationships.push({
        id,
        kind: 'realization',
        name: plainAttribute(tag, 'name'),
        source: classifier?.id,
        target: plainAttribute(tag, 'supplier') ?? plainAttribute(tag, 'contract'),
      });
    } else if (isUmlElement && local === 'packagedElement' && type === 'dependency') {
      const clients = references(plainAttribute(tag, 'client'));
      const suppliers = references(plainAttribute(tag, 'supplier'));
      if (clients.length > 1 || suppliers.length > 1) {
        xmiError(
          'XMI_UNSUPPORTED_FEATURE',
          'El perfil XMI solo admite dependencias binarias con un cliente y un proveedor.',
        );
      }
      raw.directedRelationships.push({
        id,
        kind: 'dependency',
        name: plainAttribute(tag, 'name'),
        source: clients[0],
        target: suppliers[0],
      });
    } else if (isUmlElement && local === 'packagedElement' && type === 'realization') {
      const clients = references(plainAttribute(tag, 'client'));
      const suppliers = references(plainAttribute(tag, 'supplier'));
      if (clients.length !== 1 || suppliers.length !== 1) {
        xmiError(
          'XMI_UNSUPPORTED_FEATURE',
          'El perfil XMI solo admite realizaciones binarias con un cliente y un proveedor.',
        );
      }
      raw.directedRelationships.push({
        id,
        kind: 'realization',
        name: plainAttribute(tag, 'name'),
        source: clients[0],
        target: suppliers[0],
      });
    } else if (isUmlElement && local === 'type') {
      const rawXmiType = xmiAttribute(tag, 'type');
      if (rawXmiType && !['class', 'interface', 'datatype', 'primitivetype'].includes(type)) {
        xmiError('XMI_UNSUPPORTED_FEATURE', 'El perfil XMI no admite ese metatipo de referencia.');
      }
      const member = currentMember();
      if (member) {
        const plainReference = plainAttribute(tag, 'type');
        const idReference = xmiAttribute(tag, 'idref');
        const href = plainAttribute(tag, 'href');
        if (member.type.declared) {
          xmiError('XMI_MALFORMED', 'Un miembro XMI no puede declarar su tipo dos veces.');
        }
        if (href && (plainReference || idReference)) {
          xmiError('XMI_MALFORMED', 'Una referencia de tipo XMI no puede mezclar href e idref.');
        }
        if (plainReference && idReference && plainReference !== idReference) {
          xmiError(
            'XMI_MALFORMED',
            'Una referencia de tipo XMI declara identificadores conflictivos.',
          );
        }
        if (!href && !plainReference && !idReference) {
          xmiError(
            'XMI_MISSING_REFERENCE',
            'Una referencia de tipo XMI debe declarar href o idref.',
          );
        }
        member.type = {
          declared: true,
          href,
          reference: plainReference ?? idReference,
        };
      }
    } else if (isUmlElement && local === 'defaultValue') {
      const rawXmiType = xmiAttribute(tag, 'type');
      if (rawXmiType && type !== 'literalstring') {
        xmiError(
          'XMI_UNSUPPORTED_FEATURE',
          'El perfil XMI solo admite valores por defecto LiteralString.',
        );
      }
      const member = currentMember();
      if (member) {
        if (!('defaultValueDeclared' in member)) {
          xmiError(
            'XMI_UNSUPPORTED_FEATURE',
            'El perfil XMI no admite valores por defecto en extremos de asociación.',
          );
        }
        if ('direction' in member && member.direction === 'return') {
          xmiError(
            'XMI_UNSUPPORTED_FEATURE',
            'El perfil XMI no admite valores por defecto en parámetros de retorno.',
          );
        }
        if (member.defaultValueDeclared) {
          xmiError('XMI_MALFORMED', 'Un miembro XMI no puede declarar dos valores por defecto.');
        }
        const value = plainAttribute(tag, 'value');
        if (value === undefined) {
          xmiError(
            'XMI_UNSUPPORTED_FEATURE',
            'El perfil XMI requiere value en los valores por defecto.',
          );
        }
        member.defaultValueDeclared = true;
        member.defaultValue = requireRoundTrippableAttributeValue(
          value,
          'El valor por defecto XMI',
        );
      }
    } else if (isUmlElement && (local === 'lowerValue' || local === 'upperValue')) {
      const rawXmiType = xmiAttribute(tag, 'type');
      const allowedValueTypes =
        local === 'lowerValue' ? ['literalinteger'] : ['literalinteger', 'literalunlimitednatural'];
      if (rawXmiType && !allowedValueTypes.includes(type)) {
        xmiError(
          'XMI_UNSUPPORTED_FEATURE',
          'El perfil XMI no admite ese metatipo de multiplicidad.',
        );
      }
      const target = currentMember() ?? currentAssociation()?.ends.at(-1);
      if (!target) {
        xmiError('XMI_MALFORMED', 'Una multiplicidad XMI no tiene un miembro propietario.');
      }
      const value = plainAttribute(tag, 'value');
      if (value === undefined || value.trim().length === 0) {
        xmiError('XMI_MALFORMED', 'Una multiplicidad XMI debe declarar un value no vacío.');
      }
      if (local === 'lowerValue') {
        if (target.lowerDeclared) {
          xmiError('XMI_MALFORMED', 'Una multiplicidad XMI no puede declarar lower dos veces.');
        }
        target.lowerDeclared = true;
        target.lower = value;
      } else {
        if (target.upperDeclared) {
          xmiError('XMI_MALFORMED', 'Una multiplicidad XMI no puede declarar upper dos veces.');
        }
        target.upperDeclared = true;
        target.upper = value;
      }
    } else if (isUmlElement && local === 'packagedElement' && type) {
      const key = `${type}:${id ?? ''}`;
      if (!unsupported.has(key)) {
        unsupported.add(key);
        raw.diagnostics.push(
          diagnostic(
            'XMI_UNSUPPORTED_ELEMENT',
            `El elemento UML ${type} no está soportado.`,
            id,
            type,
          ),
        );
      }
    } else if (isUmlElement && local === 'packagedElement' && xmiAttribute(tag, 'type')) {
      const rawType = xmiAttribute(tag, 'type')!;
      const key = `${rawType}:${id ?? ''}`;
      if (!unsupported.has(key)) {
        unsupported.add(key);
        raw.diagnostics.push(
          diagnostic(
            'XMI_UNSUPPORTED_ELEMENT',
            `El elemento XMI ${rawType} no pertenece al namespace UML soportado.`,
            id,
            rawType,
          ),
        );
      }
    } else if (!ignoredSubtree && !isUmlElement && tag.uri !== XMI_NAMESPACE && tag.prefix) {
      const key = `${tag.name}:${id ?? ''}`;
      if (!unsupported.has(key)) {
        unsupported.add(key);
        raw.diagnostics.push(
          diagnostic(
            'XMI_EXTENSION_IGNORED',
            'La extensión con namespace no soportado se ignoró.',
            id,
            tag.name,
          ),
        );
      }
    }
    contexts.push(context);
  });
  parser.on('text', (value) => {
    textCharacters += value.length;
    if (
      textCharacters > XMI_LIMITS.maxTextCharacters ||
      value.length > XMI_LIMITS.maxValueCharacters
    ) {
      xmiError('XMI_LIMIT_EXCEEDED', 'El contenido textual XMI supera el límite permitido.', 413);
    }
    const current = contexts.at(-1);
    if (current) current.text += value;
    checkBudget();
  });
  parser.on('cdata', (value) => {
    textCharacters += value.length;
    if (
      textCharacters > XMI_LIMITS.maxTextCharacters ||
      value.length > XMI_LIMITS.maxValueCharacters
    ) {
      xmiError('XMI_LIMIT_EXCEEDED', 'El contenido textual XMI supera el límite permitido.', 413);
    }
    const current = contexts.at(-1);
    if (current) current.text += value;
    checkBudget();
  });
  parser.on('closetag', () => {
    const context = contexts.pop();
    if (!context) return;
    if (!context.ignoredSubtree && context.text.trim()) {
      xmiError(
        'XMI_UNSUPPORTED_FEATURE',
        'El perfil XMI no admite contenido textual en elementos semánticos.',
      );
    }
    checkBudget();
  });

  try {
    parser.write(text).close();
  } catch (error) {
    if (error instanceof XmiInteroperabilityError) throw error;
    xmiError('XMI_MALFORMED', 'El archivo XMI no está bien formado.');
  }
  if (contexts.length !== 0) xmiError('XMI_MALFORMED', 'El archivo XMI está truncado.');
  if (
    !sawXmiRoot ||
    raw.umlNamespace === null ||
    !UML_NAMESPACES.has(raw.umlNamespace) ||
    !sawModelContainer
  ) {
    xmiError('XMI_UNSUPPORTED_PROFILE', 'El XMI no declara el namespace UML soportado.', 415);
  }
  // XMI 2.5 identifica la version mediante el namespace; Enterprise Architect
  // omite xmi:version. Si esta presente solo se admiten 2.5 y 2.5.1.
  if (raw.xmiVersion !== null && raw.xmiVersion !== '2.5' && raw.xmiVersion !== '2.5.1') {
    xmiError(
      'XMI_UNSUPPORTED_PROFILE',
      `La versión XMI ${raw.xmiVersion} no pertenece al perfil soportado.`,
      415,
    );
  }
  return raw;
}

function mapTypeReference(
  source: RawTypeReference,
  classifierByExternalId: Map<string, { id: string; name: string }>,
  classifierByName: Map<string, { id: string; name: string }>,
  dataTypeByExternalId: Map<string, string>,
  primitiveByExternalId: Map<string, string>,
  lower?: string,
  upper?: string,
): UmlTypeReference {
  const cardinality = typeMultiplicity(lower, upper);
  const reference = source.reference;
  const href = source.href;
  if ((reference && /\s/u.test(reference)) || (href && /\s/u.test(href))) {
    xmiError('XMI_MALFORMED', 'Una referencia de tipo XMI no puede contener espacios.');
  }
  if (href && !href.startsWith('#') && !href.startsWith(`${UML_PRIMITIVE_TYPES_HREF}#`)) {
    xmiError(
      'XMI_UNSUPPORTED_FEATURE',
      'El perfil XMI no puede preservar la identidad de un tipo externo.',
    );
  }
  const officialPrimitiveHref = href?.startsWith(`${UML_PRIMITIVE_TYPES_HREF}#`) ?? false;
  const officialPrimitiveName = officialPrimitiveHref ? fragmentName(href) : undefined;
  if (
    officialPrimitiveHref &&
    (!officialPrimitiveName || omgPrimitiveName(officialPrimitiveName) !== officialPrimitiveName)
  ) {
    xmiError(
      'XMI_UNSUPPORTED_FEATURE',
      'El recurso UML PrimitiveTypes solo admite primitivas OMG conocidas.',
    );
  }
  if (officialPrimitiveName) {
    return {
      collection: cardinality.collection,
      name: officialPrimitiveName,
      nullable: cardinality.nullable,
    };
  }
  const vendorPrimitive = reference ? primitiveByExternalId.get(reference) : undefined;
  if (vendorPrimitive) {
    return {
      collection: cardinality.collection,
      name: vendorPrimitive,
      nullable: cardinality.nullable,
    };
  }
  const vendorTypeName = reference ? eaVendorTypeName(reference) : undefined;
  if (vendorTypeName) {
    const primitive = omgPrimitiveName(vendorTypeName);
    if (primitive) {
      return {
        collection: cardinality.collection,
        name: primitive,
        nullable: cardinality.nullable,
      };
    }
    const vendorClassifier = classifierByName.get(vendorTypeName);
    if (vendorClassifier) {
      return {
        collection: cardinality.collection,
        elementId: vendorClassifier.id,
        name: vendorClassifier.name,
        nullable: cardinality.nullable,
      };
    }
  }
  const localHrefReference = href?.startsWith('#') ? fragmentName(href) : undefined;
  const classifier =
    (reference ? classifierByExternalId.get(reference) : undefined) ??
    (localHrefReference ? classifierByExternalId.get(localHrefReference) : undefined);
  if (classifier) {
    return {
      collection: cardinality.collection,
      elementId: classifier.id,
      name: classifier.name,
      nullable: cardinality.nullable,
    };
  }
  const dataType =
    (reference ? dataTypeByExternalId.get(reference) : undefined) ??
    (localHrefReference ? dataTypeByExternalId.get(localHrefReference) : undefined);
  if (dataType) {
    if (omgPrimitiveName(dataType)) {
      xmiError(
        'XMI_UNSUPPORTED_FEATURE',
        'El perfil XMI no puede distinguir un tipo de dato local de una primitiva OMG homónima.',
      );
    }
    return {
      collection: cardinality.collection,
      name: dataType,
      nullable: cardinality.nullable,
    };
  }
  if (localHrefReference) {
    xmiError('XMI_MISSING_REFERENCE', 'Un tipo XMI local referencia un elemento inexistente.');
  }
  if (!source.declared) {
    xmiError('XMI_MISSING_REFERENCE', 'Un miembro XMI debe declarar su tipo.');
  }
  xmiError(
    'XMI_UNSUPPORTED_FEATURE',
    'El perfil XMI requiere una referencia local o una primitiva OMG oficial.',
  );
}

function mapAttribute(
  attribute: RawAttribute,
  classifierByExternalId: Map<string, { id: string; name: string }>,
  classifierByName: Map<string, { id: string; name: string }>,
  dataTypeByExternalId: Map<string, string>,
  primitiveByExternalId: Map<string, string>,
  diagnostics: XmiDiagnostic[],
): UmlAttribute {
  const externalId = requireIdentifier(attribute.id, 'El atributo XMI');
  return {
    ...(attribute.defaultValue === undefined
      ? {}
      : {
          defaultValue: requireRoundTrippableAttributeValue(
            attribute.defaultValue,
            'El valor por defecto XMI',
          ),
        }),
    id: canonicalId('attribute', externalId),
    isReadOnly: attribute.isReadOnly,
    isStatic: attribute.isStatic,
    name: requireName(attribute.name, 'El atributo XMI'),
    type: mapTypeReference(
      attribute.type,
      classifierByExternalId,
      classifierByName,
      dataTypeByExternalId,
      primitiveByExternalId,
      attribute.lower,
      attribute.upper,
    ),
    visibility: normalizeVisibility(attribute.visibility, diagnostics, externalId),
  };
}

function mapParameter(
  parameter: RawParameter,
  classifierByExternalId: Map<string, { id: string; name: string }>,
  classifierByName: Map<string, { id: string; name: string }>,
  dataTypeByExternalId: Map<string, string>,
  primitiveByExternalId: Map<string, string>,
): UmlParameter {
  const externalId = requireIdentifier(parameter.id, 'El parámetro XMI');
  return {
    ...(parameter.defaultValue === undefined
      ? {}
      : {
          defaultValue: requireRoundTrippableAttributeValue(
            parameter.defaultValue,
            'El valor por defecto XMI',
          ),
        }),
    id: canonicalId('parameter', externalId),
    name: requireName(parameter.name, 'El parámetro XMI'),
    type: mapTypeReference(
      parameter.type,
      classifierByExternalId,
      classifierByName,
      dataTypeByExternalId,
      primitiveByExternalId,
      parameter.lower,
      parameter.upper,
    ),
  };
}

function mapOperation(
  operation: RawOperation,
  classifierByExternalId: Map<string, { id: string; name: string }>,
  classifierByName: Map<string, { id: string; name: string }>,
  dataTypeByExternalId: Map<string, string>,
  primitiveByExternalId: Map<string, string>,
  diagnostics: XmiDiagnostic[],
): UmlOperation {
  const externalId = requireIdentifier(operation.id, 'La operación XMI');
  // Un parametro de retorno sin tipo declarado equivale a void (caso que
  // Enterprise Architect produce al reexportar operaciones sin retorno).
  const returnType =
    operation.returnParameter?.type.declared === true
      ? mapTypeReference(
          operation.returnParameter.type,
          classifierByExternalId,
          classifierByName,
          dataTypeByExternalId,
          primitiveByExternalId,
          operation.returnParameter.lower,
          operation.returnParameter.upper,
        )
      : { name: 'void', nullable: false, collection: false };
  return {
    id: canonicalId('operation', externalId),
    isAbstract: operation.isAbstract,
    isStatic: operation.isStatic,
    name: requireName(operation.name, 'La operación XMI'),
    parameters: operation.parameters.map((parameter) =>
      mapParameter(
        parameter,
        classifierByExternalId,
        classifierByName,
        dataTypeByExternalId,
        primitiveByExternalId,
      ),
    ),
    returnType,
    visibility: normalizeVisibility(operation.visibility, diagnostics, externalId),
  };
}

function resolveEndClassifier(
  end: RawAssociationEnd,
  classifierByExternalId: Map<string, { id: string; name: string }>,
): { id: string; name: string } {
  const reference = end.type.reference;
  const localHref = end.type.href?.startsWith('#') ? fragmentName(end.type.href) : undefined;
  const classifier =
    (reference ? classifierByExternalId.get(reference) : undefined) ??
    (localHref ? classifierByExternalId.get(localHref) : undefined);
  if (!classifier) {
    xmiError('XMI_MISSING_REFERENCE', 'Una relación XMI referencia un clasificador inexistente.');
  }
  return classifier;
}

function mapAssociationEnd(
  end: RawAssociationEnd,
  classifierByExternalId: Map<string, { id: string; name: string }>,
  navigableEndIds: readonly string[],
  navigableEndIdsDeclared: boolean,
): UmlRelationshipEnd {
  if (end.ownerClassifierId) {
    // Una propiedad de clase tipada X representa el extremo navegable en X; el
    // clasificador propietario es el extremo opuesto. El elemento del extremo
    // se resuelve por su tipo, no por quien declara la propiedad.
    const owner = classifierByExternalId.get(end.ownerClassifierId);
    if (!owner) {
      xmiError('XMI_MISSING_REFERENCE', 'Un extremo XMI pertenece a un clasificador inexistente.');
    }
    const classifier = resolveEndClassifier(end, classifierByExternalId);
    return {
      elementId: classifier.id,
      multiplicity: multiplicity(end.lower, end.upper),
      navigable: true,
      role:
        end.name === undefined
          ? ''
          : requireRoundTrippableAttributeValue(end.name, 'El rol de extremo XMI'),
    };
  }
  const classifier = resolveEndClassifier(end, classifierByExternalId);
  const listedAsNavigable = end.id !== undefined && navigableEndIds.includes(end.id);
  if (end.navigableDeclared && navigableEndIdsDeclared && end.navigable !== listedAsNavigable) {
    xmiError('XMI_MALFORMED', 'Una asociación XMI declara navegabilidad conflictiva.');
  }
  return {
    elementId: classifier.id,
    multiplicity: multiplicity(end.lower, end.upper),
    navigable: end.navigableDeclared ? end.navigable : listedAsNavigable,
    role:
      end.name === undefined
        ? ''
        : requireRoundTrippableAttributeValue(end.name, 'El rol de extremo XMI'),
  };
}

function mapAssociations(
  associations: RawAssociation[],
  classifierEnds: RawAssociationEnd[],
  classifierByExternalId: Map<string, { id: string; name: string }>,
  diagnostics: XmiDiagnostic[],
): UmlRelationship[] {
  const associationIds = new Set<string>();
  for (const association of associations) {
    if (association.id !== undefined) associationIds.add(association.id);
  }
  for (const end of classifierEnds) {
    if (end.associationRef === undefined || !associationIds.has(end.associationRef)) {
      xmiError(
        'XMI_MISSING_REFERENCE',
        'Un extremo navegable XMI referencia una asociación inexistente.',
      );
    }
  }
  const relationships: UmlRelationship[] = [];
  for (const association of associations) {
    const externalId = requireIdentifier(association.id, 'La asociación XMI');
    const allEnds = [
      ...association.ends,
      ...classifierEnds.filter((end) => end.associationRef === externalId),
    ];
    const orderedEnds: RawAssociationEnd[] = [];
    if (association.memberEndIds.length) {
      if (association.memberEndIds.length !== allEnds.length) {
        xmiError(
          'XMI_UNSUPPORTED_FEATURE',
          'La asociación XMI debe declarar todos sus extremos en memberEnd.',
        );
      }
      const memberEndIds = new Set<string>();
      for (const memberEndId of association.memberEndIds) {
        if (memberEndIds.has(memberEndId)) {
          xmiError('XMI_MALFORMED', 'Una asociación XMI declara extremos duplicados.');
        }
        memberEndIds.add(memberEndId);
        const end = allEnds.find((candidate) => candidate.id === memberEndId);
        if (!end) {
          xmiError(
            'XMI_MISSING_REFERENCE',
            'Una asociación XMI referencia un extremo inexistente.',
          );
        }
        orderedEnds.push(end);
      }
    } else {
      orderedEnds.push(...allEnds);
    }
    const orderedEndIds = new Set(orderedEnds.flatMap((end) => (end.id ? [end.id] : [])));
    const navigableEndIds = new Set<string>();
    for (const navigableEndId of association.navigableEndIds) {
      if (navigableEndIds.has(navigableEndId)) {
        xmiError('XMI_MALFORMED', 'Una asociación XMI declara extremos navegables duplicados.');
      }
      navigableEndIds.add(navigableEndId);
      if (!orderedEndIds.has(navigableEndId)) {
        xmiError(
          'XMI_MISSING_REFERENCE',
          'Una asociación XMI declara un extremo navegable inexistente.',
        );
      }
    }
    if (orderedEnds.length !== 2) {
      for (const end of orderedEnds) {
        mapAssociationEnd(
          end,
          classifierByExternalId,
          association.navigableEndIds,
          association.navigableEndIdsDeclared,
        );
      }
      diagnostics.push(
        diagnostic(
          'XMI_UNSUPPORTED_ASSOCIATION_ARITY',
          'Solo se importan asociaciones binarias; la asociación se ignoró.',
          externalId,
        ),
      );
      continue;
    }
    let source = mapAssociationEnd(
      orderedEnds[0]!,
      classifierByExternalId,
      association.navigableEndIds,
      association.navigableEndIdsDeclared,
    );
    let target = mapAssociationEnd(
      orderedEnds[1]!,
      classifierByExternalId,
      association.navigableEndIds,
      association.navigableEndIdsDeclared,
    );
    const sourceAggregation = orderedEnds[0]!.aggregation?.trim().toLocaleLowerCase('en');
    const targetAggregation = orderedEnds[1]!.aggregation?.trim().toLocaleLowerCase('en');
    if (
      sourceAggregation &&
      sourceAggregation !== 'none' &&
      targetAggregation &&
      targetAggregation !== 'none'
    ) {
      xmiError(
        'XMI_MALFORMED',
        'Una asociación XMI no puede declarar agregación en ambos extremos.',
      );
    }
    let kind: UmlRelationship['kind'] = 'association';
    if (targetAggregation === 'shared' || targetAggregation === 'composite') {
      [source, target] = [target, source];
      kind = targetAggregation === 'composite' ? 'composition' : 'aggregation';
    } else if (sourceAggregation === 'shared' || sourceAggregation === 'composite') {
      kind = sourceAggregation === 'composite' ? 'composition' : 'aggregation';
    }
    const associationClassId = association.associationClass
      ? classifierByExternalId.get(externalId)?.id
      : undefined;
    relationships.push({
      ...(association.name === undefined
        ? {}
        : {
            name: requireRoundTrippableAttributeValue(
              association.name,
              'El nombre de relación XMI',
            ),
          }),
      ...(associationClassId ? { associationClassId } : {}),
      id: canonicalId('relationship', externalId),
      kind,
      source,
      target,
    });
  }
  return relationships;
}

function mapDirectedRelationships(
  source: RawDirectedRelationship[],
  classifierByExternalId: Map<string, { id: string; name: string }>,
): UmlRelationship[] {
  return source.map((relationship) => {
    const externalId = requireIdentifier(relationship.id, 'La relación XMI');
    const sourceClassifier = relationship.source
      ? classifierByExternalId.get(relationship.source)
      : undefined;
    const targetClassifier = relationship.target
      ? classifierByExternalId.get(relationship.target)
      : undefined;
    if (!sourceClassifier || !targetClassifier) {
      xmiError('XMI_MISSING_REFERENCE', 'Una relación XMI referencia un clasificador inexistente.');
    }
    return {
      ...(relationship.name === undefined
        ? {}
        : {
            name: requireRoundTrippableAttributeValue(
              relationship.name,
              'El nombre de relación XMI',
            ),
          }),
      id: canonicalId('relationship', externalId),
      kind: relationship.kind,
      source: { elementId: sourceClassifier.id, multiplicity: '1', navigable: false, role: '' },
      target: { elementId: targetClassifier.id, multiplicity: '1', navigable: false, role: '' },
    };
  });
}

function assertDataTypesRetained(
  dataTypes: RawDataType[],
  model: CanonicalUmlModel,
  diagnostics: XmiDiagnostic[],
): void {
  const referencedNames = new Set(nonStandardTypeNames(model));
  const declaredNames = new Set<string>();
  for (const dataType of dataTypes) {
    requireIdentifier(dataType.id, 'El tipo de dato XMI');
    const name = requireName(dataType.name, 'El tipo de dato XMI');
    if (omgPrimitiveName(name)) {
      xmiError(
        'XMI_UNSUPPORTED_FEATURE',
        'El perfil XMI no admite un DataType local homónimo de una primitiva OMG.',
      );
    }
    if (declaredNames.has(name)) {
      xmiError('XMI_MALFORMED', 'El XMI declara tipos de dato locales con el mismo nombre.');
    }
    declaredNames.add(name);
    if (!referencedNames.has(name)) {
      diagnostics.push(
        diagnostic(
          'XMI_DATATYPE_UNUSED',
          'El tipo de dato local no referenciado se omitio del modelo canonico.',
          dataType.id,
          'datatype',
        ),
      );
    }
  }
}

function deterministicPositions(
  elements: UmlClassifier[],
): CanonicalUmlModel['diagram']['visual']['positions'] {
  return elements
    .toSorted((left, right) => left.id.localeCompare(right.id, 'en'))
    .map((element, index) => ({
      elementId: element.id,
      height: 180,
      width: 220,
      x: 80 + (index % 4) * 280,
      y: 80 + Math.floor(index / 4) * 240,
    }));
}

function summaryFor(model: CanonicalUmlModel): XmiSummary {
  return {
    attributes: model.diagram.elements.reduce(
      (count, element) => count + element.attributes.length,
      0,
    ),
    classes: model.diagram.elements.filter((element) => element.kind === 'class').length,
    interfaces: model.diagram.elements.filter((element) => element.kind === 'interface').length,
    operations: model.diagram.elements.reduce(
      (count, element) => count + element.operations.length,
      0,
    ),
    relationships: model.diagram.relationships.length,
  };
}

function profileFor(raw: RawXmiModel): XmiProfile {
  return {
    id: 'uml-class-designer-xmi',
    umlNamespace: raw.umlNamespace,
    version: XMI_PROFILE_VERSION,
    xmiVersion: raw.xmiVersion,
  };
}

export function importXmiToCanonical(bytes: Buffer, seed: XmiCanonicalSeed): XmiImportResult {
  const raw = parseXmi(bytes);
  const diagnostics = [...raw.diagnostics];
  const classifierByExternalId = new Map<string, { id: string; name: string }>();
  const classifierByName = new Map<string, { id: string; name: string }>();
  const ambiguousNames = new Set<string>();
  for (const classifier of raw.classifiers) {
    const externalId = requireIdentifier(classifier.id, 'El clasificador XMI');
    const name = requireName(classifier.name, 'El clasificador XMI');
    const identity = { id: canonicalId('classifier', externalId), name };
    classifierByExternalId.set(externalId, identity);
    if (classifierByName.has(name)) {
      ambiguousNames.add(name);
    } else {
      classifierByName.set(name, identity);
    }
  }
  for (const ambiguousName of ambiguousNames) {
    classifierByName.delete(ambiguousName);
  }
  const dataTypeByExternalId = new Map<string, string>();
  for (const dataType of raw.dataTypes) {
    const externalId = requireIdentifier(dataType.id, 'El tipo de dato XMI');
    dataTypeByExternalId.set(externalId, requireName(dataType.name, 'El tipo de dato XMI'));
  }
  const primitiveByExternalId = new Map<string, string>();
  for (const [externalId, name] of collectEaPrimitiveTypes(bytes)) {
    const primitive = omgPrimitiveName(name);
    if (primitive) primitiveByExternalId.set(externalId, primitive);
    else dataTypeByExternalId.set(externalId, name);
  }
  const elements = raw.classifiers
    .map((classifier): UmlClassifier => {
      const externalId = requireIdentifier(classifier.id, 'El clasificador XMI');
      const identity = classifierByExternalId.get(externalId);
      if (!identity) xmiError('XMI_MISSING_REFERENCE', 'El clasificador XMI no pudo resolverse.');
      const common = {
        attributes: classifier.attributes.map((attribute) =>
          mapAttribute(
            attribute,
            classifierByExternalId,
            classifierByName,
            dataTypeByExternalId,
            primitiveByExternalId,
            diagnostics,
          ),
        ),
        id: identity.id,
        name: identity.name,
        operations: classifier.operations.map((operation) =>
          mapOperation(
            operation,
            classifierByExternalId,
            classifierByName,
            dataTypeByExternalId,
            primitiveByExternalId,
            diagnostics,
          ),
        ),
      };
      if (classifier.kind === 'interface') {
        return { ...common, kind: 'interface' } satisfies UmlInterface;
      }
      return { ...common, isAbstract: classifier.isAbstract, kind: 'class' } satisfies UmlClass;
    })
    .toSorted((left, right) => left.id.localeCompare(right.id, 'en'));
  const relationships = [
    ...mapAssociations(raw.associations, raw.associationEnds, classifierByExternalId, diagnostics),
    ...mapDirectedRelationships(raw.directedRelationships, classifierByExternalId),
  ].toSorted((left, right) => left.id.localeCompare(right.id, 'en'));
  const model: CanonicalUmlModel = {
    diagram: {
      elements,
      id: seed.diagramId,
      name: requireName(raw.modelName, 'El modelo XMI'),
      relationships,
      visual: { positions: deterministicPositions(elements) },
    },
    metadata: { createdAt: seed.createdAt, revision: seed.revision, updatedAt: seed.updatedAt },
    project: { id: seed.projectId, name: seed.projectName },
    schemaVersion: '0.1.0',
  };
  assertDataTypesRetained(raw.dataTypes, model, diagnostics);
  return { diagnostics, model, profile: profileFor(raw), summary: summaryFor(model) };
}

function escapeXml(value: string): string {
  if (containsInvalidXml10Character(value)) {
    xmiError(
      'XMI_UNSUPPORTED_FEATURE',
      'El perfil XMI no puede serializar caracteres no válidos en XML 1.0.',
    );
  }
  if (/[\t\n\r]/u.test(value)) {
    xmiError(
      'XMI_UNSUPPORTED_FEATURE',
      'El perfil XMI no puede serializar tabulaciones ni saltos de línea en atributos.',
    );
  }
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function containsInvalidXml10Character(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      (codePoint !== 0x9 &&
        codePoint !== 0xa &&
        codePoint !== 0xd &&
        !(
          (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
          (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
          (codePoint >= 0x10000 && codePoint <= 0x10ffff)
        ))
    ) {
      return true;
    }
  }
  return false;
}

function xmlAttributes(values: Record<string, string | boolean | undefined>): string {
  return Object.entries(values)
    .filter((entry): entry is [string, string | boolean] => entry[1] !== undefined)
    .map(([key, value]) => ` ${key}="${escapeXml(String(value))}"`)
    .join('');
}

// UML XMI serializa las multiplicidades con lowerValue/upperValue anidados.
// Enterprise Architect ignora los atributos lower/upper abreviados, por lo que
// el exportador usa la forma estandar que EA importa correctamente.
function writeMultiplicity(
  reference: Pick<UmlTypeReference, 'collection' | 'nullable'>,
  indent: string,
): string[] {
  return [
    `${indent}<lowerValue${xmlAttributes({ 'xmi:type': 'uml:LiteralInteger', value: reference.nullable ? '0' : '1' })}/>`,
    `${indent}<upperValue${xmlAttributes({ 'xmi:type': 'uml:LiteralUnlimitedNatural', value: reference.collection ? '*' : '1' })}/>`,
  ];
}

function nonStandardTypeNames(model: CanonicalUmlModel): string[] {
  const names = new Set<string>();
  const add = (reference: UmlTypeReference) => {
    if (reference.elementId) return;
    const primitiveName = omgPrimitiveName(reference.name);
    if (primitiveName) {
      if (primitiveName !== reference.name) {
        xmiError(
          'XMI_UNSUPPORTED_FEATURE',
          'El perfil XMI no puede normalizar el uso no canónico de una primitiva OMG.',
        );
      }
      return;
    }
    names.add(reference.name);
  };
  for (const element of model.diagram.elements) {
    for (const attribute of element.attributes) add(attribute.type);
    for (const operation of element.operations) {
      for (const parameter of operation.parameters) add(parameter.type);
      add(operation.returnType);
    }
  }
  return [...names].toSorted((left, right) => left.localeCompare(right, 'en'));
}

function writeType(
  reference: UmlTypeReference,
  indent: string,
  dataTypeXmiIds: ReadonlyMap<string, string>,
): string[] {
  if (reference.elementId) return [];
  const primitiveName = omgPrimitiveName(reference.name);
  if (primitiveName) {
    if (primitiveName !== reference.name) {
      xmiError(
        'XMI_UNSUPPORTED_FEATURE',
        'El perfil XMI no puede normalizar el uso no canónico de una primitiva OMG.',
      );
    }
    return [
      `${indent}<type${xmlAttributes({ 'xmi:type': 'uml:PrimitiveType', href: `${UML_PRIMITIVE_TYPES_HREF}#${primitiveName}` })}/>`,
    ];
  }
  const dataTypeXmiId = dataTypeXmiIds.get(reference.name);
  if (!dataTypeXmiId) {
    xmiError('XMI_MISSING_REFERENCE', 'El modelo canónico referencia un tipo de dato inexistente.');
  }
  return [
    `${indent}<type${xmlAttributes({ 'xmi:type': 'uml:DataType', href: `#${dataTypeXmiId}` })}/>`,
  ];
}

function typeAttribute(
  reference: UmlTypeReference,
  elementXmiIds: Map<string, string>,
): string | undefined {
  if (!reference.elementId) return undefined;
  const xmiId = elementXmiIds.get(reference.elementId);
  if (!xmiId) {
    xmiError('XMI_MISSING_REFERENCE', 'El modelo canónico referencia un clasificador inexistente.');
  }
  return xmiId;
}

function writeAttribute(
  attribute: UmlAttribute,
  indent: string,
  elementXmiIds: Map<string, string>,
  dataTypeXmiIds: ReadonlyMap<string, string>,
): string[] {
  const xmiId = canonicalId('attribute', attribute.id);
  const nested = [
    ...writeType(attribute.type, `${indent}  `, dataTypeXmiIds),
    ...writeMultiplicity(attribute.type, `${indent}  `),
    ...(attribute.defaultValue === undefined
      ? []
      : [
          `${indent}  <defaultValue${xmlAttributes({ 'xmi:type': 'uml:LiteralString', value: attribute.defaultValue })}/>`,
        ]),
  ];
  const attributes = {
    isReadOnly: attribute.isReadOnly,
    isStatic: attribute.isStatic,
    'xmi:id': xmiId,
    name: attribute.name,
    type: typeAttribute(attribute.type, elementXmiIds),
    visibility: attribute.visibility,
  };
  if (nested.length === 0) return [`${indent}<ownedAttribute${xmlAttributes(attributes)}/>`];
  return [
    `${indent}<ownedAttribute${xmlAttributes(attributes)}>`,
    ...nested,
    `${indent}</ownedAttribute>`,
  ];
}

function writeParameter(
  parameter: UmlParameter | UmlTypeReference,
  direction: 'in' | 'return',
  indent: string,
  elementXmiIds: Map<string, string>,
  dataTypeXmiIds: ReadonlyMap<string, string>,
  operationId: string,
): string[] {
  const isReturn = !('id' in parameter);
  const reference = isReturn ? parameter : parameter.type;
  const name = isReturn ? 'return' : parameter.name;
  const xmiId = canonicalId('parameter', isReturn ? `${operationId}:return` : parameter.id);
  const defaultValue = isReturn ? undefined : parameter.defaultValue;
  const nested = [
    ...writeType(reference, `${indent}  `, dataTypeXmiIds),
    ...writeMultiplicity(reference, `${indent}  `),
    ...(defaultValue === undefined
      ? []
      : [
          `${indent}  <defaultValue${xmlAttributes({ 'xmi:type': 'uml:LiteralString', value: defaultValue })}/>`,
        ]),
  ];
  const attributes = {
    direction,
    'xmi:id': xmiId,
    name,
    type: typeAttribute(reference, elementXmiIds),
  };
  if (nested.length === 0) return [`${indent}<ownedParameter${xmlAttributes(attributes)}/>`];
  return [
    `${indent}<ownedParameter${xmlAttributes(attributes)}>`,
    ...nested,
    `${indent}</ownedParameter>`,
  ];
}

function writeOperation(
  operation: UmlOperation,
  indent: string,
  elementXmiIds: Map<string, string>,
  dataTypeXmiIds: ReadonlyMap<string, string>,
): string[] {
  const lines = [
    `${indent}<ownedOperation${xmlAttributes({
      isAbstract: operation.isAbstract,
      isStatic: operation.isStatic,
      'xmi:id': canonicalId('operation', operation.id),
      name: operation.name,
      visibility: operation.visibility,
    })}>`,
  ];
  for (const parameter of operation.parameters) {
    lines.push(
      ...writeParameter(
        parameter,
        'in',
        `${indent}  `,
        elementXmiIds,
        dataTypeXmiIds,
        operation.id,
      ),
    );
  }
  lines.push(
    ...writeParameter(
      operation.returnType,
      'return',
      `${indent}  `,
      elementXmiIds,
      dataTypeXmiIds,
      operation.id,
    ),
  );
  lines.push(`${indent}</ownedOperation>`);
  return lines;
}

function assertExportableRelationship(relationship: UmlRelationship): void {
  const association =
    relationship.kind === 'association' ||
    relationship.kind === 'aggregation' ||
    relationship.kind === 'composition';
  if (!association && relationship.associationClassId) {
    xmiError(
      'XMI_UNSUPPORTED_FEATURE',
      'El perfil XMI solo admite clases asociativas en asociaciones, agregaciones o composiciones.',
    );
  }
  if (association && relationship.associationClassId && !relationship.name?.trim()) {
    xmiError(
      'XMI_UNSUPPORTED_FEATURE',
      'El perfil XMI exige un nombre de relación para una clase asociativa.',
    );
  }
  if (association) return;
  for (const end of [relationship.source, relationship.target]) {
    if (end.multiplicity !== '1' || end.navigable || end.role !== '') {
      xmiError(
        'XMI_UNSUPPORTED_FEATURE',
        'El perfil XMI solo admite extremos dirigidos con rol vacío, multiplicidad 1 y no navegables.',
      );
    }
  }
}

function classifierRelationships(
  classifier: UmlClassifier,
  relationships: UmlRelationship[],
  elementXmiIds: Map<string, string>,
  indent: string,
): string[] {
  const lines: string[] = [];
  for (const relationship of relationships) {
    if (relationship.source.elementId !== classifier.id) continue;
    if (relationship.kind === 'generalization') {
      lines.push(
        `${indent}<generalization${xmlAttributes({
          general: elementXmiIds.get(relationship.target.elementId),
          'xmi:id': canonicalId('relationship', relationship.id),
          name: relationship.name,
        })}/>`,
      );
    }
    if (relationship.kind === 'realization') {
      lines.push(
        `${indent}<interfaceRealization${xmlAttributes({
          supplier: elementXmiIds.get(relationship.target.elementId),
          'xmi:id': canonicalId('relationship', relationship.id),
          name: relationship.name,
        })}/>`,
      );
    }
  }
  return lines;
}

function writeClassifier(
  classifier: UmlClassifier,
  relationships: UmlRelationship[],
  elementXmiIds: Map<string, string>,
  dataTypeXmiIds: ReadonlyMap<string, string>,
  indent: string,
): string[] {
  const xmiType = classifier.kind === 'class' ? 'uml:Class' : 'uml:Interface';
  const lines = [
    `${indent}<packagedElement${xmlAttributes({
      ...(classifier.kind === 'class' ? { isAbstract: classifier.isAbstract } : {}),
      'xmi:id': elementXmiIds.get(classifier.id),
      'xmi:type': xmiType,
      name: classifier.name,
    })}>`,
  ];
  for (const attribute of classifier.attributes) {
    lines.push(...writeAttribute(attribute, `${indent}  `, elementXmiIds, dataTypeXmiIds));
  }
  for (const operation of classifier.operations) {
    lines.push(...writeOperation(operation, `${indent}  `, elementXmiIds, dataTypeXmiIds));
  }
  lines.push(...classifierRelationships(classifier, relationships, elementXmiIds, `${indent}  `));
  lines.push(`${indent}</packagedElement>`);
  return lines;
}

function writeAssociation(
  relationship: UmlRelationship,
  associationClass: UmlClass | undefined,
  relationships: UmlRelationship[],
  elementXmiIds: Map<string, string>,
  dataTypeXmiIds: ReadonlyMap<string, string>,
  indent: string,
): string[] {
  const xmiId = canonicalId('relationship', relationship.id);
  const sourceEndId = canonicalId('association_end', `${relationship.id}:source`);
  const targetEndId = canonicalId('association_end', `${relationship.id}:target`);
  const xmiType = associationClass ? 'uml:AssociationClass' : 'uml:Association';
  const sourceAggregation =
    relationship.kind === 'composition'
      ? 'composite'
      : relationship.kind === 'aggregation'
        ? 'shared'
        : 'none';
  const navigableEndIds = [
    ...(relationship.source.navigable ? [sourceEndId] : []),
    ...(relationship.target.navigable ? [targetEndId] : []),
  ];
  const lines = [
    `${indent}<packagedElement${xmlAttributes({
      ...(associationClass?.isAbstract === undefined
        ? {}
        : { isAbstract: associationClass.isAbstract }),
      'ucd:associationName': associationClass ? relationship.name : undefined,
      'xmi:id': xmiId,
      'xmi:type': xmiType,
      memberEnd: `${sourceEndId} ${targetEndId}`,
      navigableOwnedEnd: navigableEndIds.length > 0 ? navigableEndIds.join(' ') : undefined,
      name: associationClass?.name ?? relationship.name,
    })}>`,
  ];
  if (associationClass) {
    for (const attribute of associationClass.attributes) {
      lines.push(...writeAttribute(attribute, `${indent}  `, elementXmiIds, dataTypeXmiIds));
    }
    for (const operation of associationClass.operations) {
      lines.push(...writeOperation(operation, `${indent}  `, elementXmiIds, dataTypeXmiIds));
    }
    lines.push(
      ...classifierRelationships(associationClass, relationships, elementXmiIds, `${indent}  `),
    );
  }
  lines.push(
    ...writeOwnedEnd(
      relationship.source,
      sourceAggregation,
      sourceEndId,
      elementXmiIds,
      `${indent}  `,
    ),
    ...writeOwnedEnd(relationship.target, 'none', targetEndId, elementXmiIds, `${indent}  `),
    `${indent}</packagedElement>`,
  );
  return lines;
}

function writeOwnedEnd(
  end: UmlRelationship['source'],
  aggregation: string,
  xmiId: string,
  elementXmiIds: Map<string, string>,
  indent: string,
): string[] {
  return [
    `${indent}<ownedEnd${xmlAttributes({
      aggregation,
      isNavigable: end.navigable,
      name: end.role,
      type: elementXmiIds.get(end.elementId),
      'xmi:id': xmiId,
    })}>`,
    `${indent}  <lowerValue${xmlAttributes({ 'xmi:type': 'uml:LiteralInteger', value: multiplicityLower(end.multiplicity) })}/>`,
    `${indent}  <upperValue${xmlAttributes({ 'xmi:type': 'uml:LiteralUnlimitedNatural', value: multiplicityUpper(end.multiplicity) })}/>`,
    `${indent}</ownedEnd>`,
  ];
}

function multiplicityLower(value: string): string {
  if (value === '*') return '0';
  return value.includes('..') ? (value.split('..')[0] ?? '1') : value;
}

function multiplicityUpper(value: string): string {
  return value.includes('..') ? (value.split('..')[1] ?? '1') : value;
}

function writeDependency(
  relationship: UmlRelationship,
  elementXmiIds: Map<string, string>,
  indent: string,
): string {
  return `${indent}<packagedElement${xmlAttributes({
    client: elementXmiIds.get(relationship.source.elementId),
    name: relationship.name,
    supplier: elementXmiIds.get(relationship.target.elementId),
    'xmi:id': canonicalId('relationship', relationship.id),
    'xmi:type': 'uml:Dependency',
  })}/>`;
}

export function exportCanonicalModelToXmi(model: CanonicalUmlModel): Buffer {
  const stereotypedElement = model.diagram.elements.find(
    (element) => element.stereotypes !== undefined && element.stereotypes.length > 0,
  );
  if (stereotypedElement) {
    xmiError(
      'XMI_UNSUPPORTED_FEATURE',
      `El perfil XMI no exporta estereotipos (${stereotypedElement.name}).`,
    );
  }
  for (const relationship of model.diagram.relationships) {
    assertExportableRelationship(relationship);
  }
  const associationClassOwners = new Map<string, UmlRelationship>();
  for (const relationship of model.diagram.relationships) {
    if (relationship.associationClassId) {
      const associationClass = model.diagram.elements.find(
        (element) => element.id === relationship.associationClassId,
      );
      if (associationClass?.kind !== 'class') {
        xmiError(
          'XMI_MISSING_REFERENCE',
          'Una clase asociativa debe referenciar una clase existente.',
        );
      }
      associationClassOwners.set(relationship.associationClassId, relationship);
    }
  }
  const elementXmiIds = new Map<string, string>();
  for (const element of model.diagram.elements) {
    const association = associationClassOwners.get(element.id);
    elementXmiIds.set(
      element.id,
      association
        ? canonicalId('relationship', association.id)
        : canonicalId('classifier', element.id),
    );
  }
  const dataTypeXmiIds = new Map(
    nonStandardTypeNames(model).map((name): [string, string] => [
      name,
      canonicalId('data_type', name),
    ]),
  );
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<xmi:XMI${xmlAttributes({ 'xmi:version': '2.5', 'xmlns:ucd': XMI_EXTENSION_NAMESPACE, 'xmlns:uml': UML_NAMESPACE, 'xmlns:xmi': XMI_NAMESPACE })}>`,
    `  <uml:Model${xmlAttributes({ 'xmi:id': canonicalId('model', model.diagram.id), name: model.diagram.name })}>`,
  ];
  for (const [name, xmiId] of dataTypeXmiIds) {
    lines.push(
      `    <packagedElement${xmlAttributes({ 'xmi:id': xmiId, 'xmi:type': 'uml:DataType', name })}/>`,
    );
  }
  const sortedElements = model.diagram.elements.toSorted((left, right) =>
    left.id.localeCompare(right.id, 'en'),
  );
  for (const element of sortedElements) {
    if (!associationClassOwners.has(element.id)) {
      lines.push(
        ...writeClassifier(
          element,
          model.diagram.relationships,
          elementXmiIds,
          dataTypeXmiIds,
          '    ',
        ),
      );
    }
  }
  const sortedRelationships = model.diagram.relationships.toSorted((left, right) =>
    left.id.localeCompare(right.id, 'en'),
  );
  for (const relationship of sortedRelationships) {
    if (
      relationship.kind === 'association' ||
      relationship.kind === 'aggregation' ||
      relationship.kind === 'composition'
    ) {
      const associationClass = relationship.associationClassId
        ? model.diagram.elements.find((element) => element.id === relationship.associationClassId)
        : undefined;
      if (associationClass?.kind === 'interface') {
        xmiError('XMI_MALFORMED', 'Una clase asociativa debe ser una clase.');
      }
      lines.push(
        ...writeAssociation(
          relationship,
          associationClass as UmlClass | undefined,
          model.diagram.relationships,
          elementXmiIds,
          dataTypeXmiIds,
          '    ',
        ),
      );
    }
    if (relationship.kind === 'dependency') {
      lines.push(writeDependency(relationship, elementXmiIds, '    '));
    }
  }
  lines.push('  </uml:Model>', '</xmi:XMI>', '');
  const bytes = Buffer.from(lines.join('\n'), 'utf8');
  if (bytes.byteLength > XMI_LIMITS.maxBytes) {
    xmiError(
      'XMI_LIMIT_EXCEEDED',
      `La exportación XMI supera el límite de ${XMI_LIMITS.maxBytes} bytes.`,
      413,
    );
  }
  return bytes;
}

export function xmiSha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
