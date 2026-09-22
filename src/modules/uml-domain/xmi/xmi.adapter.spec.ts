import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CanonicalModelValidationError,
  validateCanonicalModel,
} from '../canonical-model.validation';
import type { CanonicalUmlModel } from '../collaboration.types';
import {
  UML_PRIMITIVE_TYPES_HREF,
  XMI_LIMITS,
  UML_NAMESPACE,
  XMI_NAMESPACE,
} from './xmi.constants';
import { exportCanonicalModelToXmi, importXmiToCanonical, xmiSha256 } from './xmi.adapter';
import { XmiInteroperabilityError } from './xmi.error';
import { areSemanticallyEquivalent } from './xmi.semantic-equivalence';
import type { XmiCanonicalSeed } from './xmi.adapter';

const seed: XmiCanonicalSeed = {
  createdAt: '2026-09-21T00:00:00.000Z',
  diagramId: 'diagram_fixture',
  diagramName: 'Persisted diagram',
  projectId: 'project_fixture',
  projectName: 'Persisted project',
  revision: 3,
  updatedAt: '2026-09-21T00:00:00.000Z',
};

function fixture(name: string): Buffer {
  return readFileSync(resolve(process.cwd(), `contracts/fixtures/xmi/${name}`));
}

function importFixture(name: string) {
  return importXmiToCanonical(fixture(name), seed);
}

function expectXmiError(bytes: Buffer, code: XmiInteroperabilityError['code']): void {
  try {
    importXmiToCanonical(bytes, seed);
  } catch (error) {
    expect(error).toBeInstanceOf(XmiInteroperabilityError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected XMI error ${code}.`);
}

function expectExportXmiError(
  model: CanonicalUmlModel,
  code: XmiInteroperabilityError['code'],
): void {
  try {
    exportCanonicalModelToXmi(model);
  } catch (error) {
    expect(error).toBeInstanceOf(XmiInteroperabilityError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected XMI export error ${code}.`);
}

describe('XMI adapter', () => {
  it('imports the basic fixture deterministically into a valid canonical model', () => {
    const first = importFixture('basic.xmi');
    const second = importFixture('basic.xmi');

    expect(validateCanonicalModel(first.model)).toEqual(first.model);
    expect(first).toEqual(second);
    expect(first.profile).toEqual({
      id: 'uml-class-designer-xmi',
      umlNamespace: UML_NAMESPACE,
      version: '1.0.0',
      xmiVersion: '2.5',
    });
    expect(first.summary).toEqual({
      attributes: 2,
      classes: 2,
      interfaces: 0,
      operations: 1,
      relationships: 1,
    });
    expect(first.model.diagram.relationships).toEqual([
      expect.objectContaining({
        kind: 'association',
        name: 'orders',
        source: expect.objectContaining({ multiplicity: '1', navigable: false, role: 'customer' }),
        target: expect.objectContaining({ multiplicity: '0..*', navigable: true, role: 'orders' }),
      }),
    ]);
    expect(xmiSha256(fixture('basic.xmi'))).toMatch(/^[a-f0-9]{64}$/);
  });

  it('maps all supported relationship kinds, association classes and type references', () => {
    const result = importFixture('relationships.xmi');
    validateCanonicalModel(result.model);

    expect(result.summary).toEqual({
      attributes: 3,
      classes: 6,
      interfaces: 1,
      operations: 2,
      relationships: 9,
    });
    expect(result.model.diagram.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ isAbstract: true, kind: 'class', name: 'Person' }),
        expect.objectContaining({ kind: 'interface', name: 'Identifiable' }),
        expect.objectContaining({ kind: 'class', name: 'Enrollment' }),
      ]),
    );
    expect(
      result.model.diagram.relationships.map((relationship) => relationship.kind).toSorted(),
    ).toEqual(
      [
        'aggregation',
        'association',
        'association',
        'association',
        'association',
        'composition',
        'dependency',
        'generalization',
        'realization',
      ].toSorted(),
    );
    expect(result.model.diagram.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          associationClassId: expect.any(String),
          kind: 'association',
          name: 'Enrollment',
          source: expect.objectContaining({ multiplicity: '0..*', navigable: true }),
          target: expect.objectContaining({ multiplicity: '0..*', navigable: true }),
        }),
        expect.objectContaining({ kind: 'aggregation', name: 'departmentEmployees' }),
        expect.objectContaining({ kind: 'composition', name: 'addresses' }),
        expect.objectContaining({ kind: 'dependency', name: 'employeeDepartment' }),
        expect.objectContaining({ kind: 'generalization' }),
        expect.objectContaining({ kind: 'realization' }),
      ]),
    );
  });

  it('exports deterministically and preserves supported UML semantics through a round trip', () => {
    const imported = importFixture('relationships.xmi').model;
    const employee = imported.diagram.elements.find((element) => element.name === 'Employee');
    const assign = employee?.operations.find((operation) => operation.name === 'assign');
    const generalization = imported.diagram.relationships.find(
      (relationship) => relationship.kind === 'generalization',
    );
    const realization = imported.diagram.relationships.find(
      (relationship) => relationship.kind === 'realization',
    );
    if (!employee || !assign || !generalization || !realization) {
      throw new Error(
        'The relationship fixture must include Employee, inheritance, realization and assign.',
      );
    }
    employee.attributes[0]!.type.nullable = true;
    assign.parameters[0]!.type.nullable = true;
    assign.returnType.nullable = true;
    generalization.name = 'inheritsFrom';
    realization.name = 'implementsIdentity';
    const first = exportCanonicalModelToXmi(imported);
    const second = exportCanonicalModelToXmi(imported);
    const roundTripped = importXmiToCanonical(first, seed).model;

    expect(first.equals(second)).toBe(true);
    expect(first.toString('utf8')).toContain('encoding="UTF-8"');
    expect(validateCanonicalModel(roundTripped)).toEqual(roundTripped);
    expect(areSemanticallyEquivalent(imported, roundTripped)).toBe(true);
  });

  it('exports product-specific types as local UML data types instead of fictitious OMG primitives', () => {
    const imported = importFixture('relationships.xmi').model;
    const exported = exportCanonicalModelToXmi(imported);
    const contents = exported.toString('utf8');

    expect(contents).toContain('xmi:type="uml:DataType"');
    expect(contents).toContain('name="Date"');
    expect(contents).toContain('name="void"');
    expect(contents).toContain(`${UML_PRIMITIVE_TYPES_HREF}#String`);
    expect(contents).not.toContain(`${UML_PRIMITIVE_TYPES_HREF}#Date`);
    expect(contents).not.toContain(`${UML_PRIMITIVE_TYPES_HREF}#void`);
    expect(areSemanticallyEquivalent(imported, importXmiToCanonical(exported, seed).model)).toBe(
      true,
    );
  });

  it('retains only referenced nominal local data types and canonical OMG primitive names', () => {
    const basic = fixture('basic.xmi').toString('utf8');
    const unusedDataType = importXmiToCanonical(
      Buffer.from(
        basic.replace(
          '</uml:Model>',
          '<packagedElement xmi:type="uml:DataType" xmi:id="unused_type" name="Unused"/></uml:Model>',
        ),
        'utf8',
      ),
      seed,
    );
    expect(unusedDataType.summary.classes).toBe(2);
    expect(unusedDataType.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'XMI_DATATYPE_UNUSED' })]),
    );
    const withoutReturn = importXmiToCanonical(
      Buffer.from(
        basic.replace(/\s*<ownedParameter direction="return"[\s\S]*?<\/ownedParameter>/u, ''),
        'utf8',
      ),
      seed,
    );
    const voidOperation = withoutReturn.model.diagram.elements.flatMap(
      (element) => element.operations,
    )[0];
    expect(voidOperation?.returnType).toEqual({ name: 'void', nullable: false, collection: false });
    const voidRoundTripped = importXmiToCanonical(
      exportCanonicalModelToXmi(withoutReturn.model),
      seed,
    ).model;
    expect(areSemanticallyEquivalent(withoutReturn.model, voidRoundTripped)).toBe(true);
    expectXmiError(Buffer.from(basic.replace(' name="Commerce"', ''), 'utf8'), 'XMI_MALFORMED');
    expectXmiError(
      Buffer.from(
        basic.replace(
          'xmi:type="uml:DataType" xmi:id="decimal_type"',
          'xmi:type="uml:PrimitiveType" xmi:id="decimal_type"',
        ),
        'utf8',
      ),
      'XMI_UNSUPPORTED_FEATURE',
    );
    const nonCanonicalPrimitive = importFixture('basic.xmi').model;
    const customer = nonCanonicalPrimitive.diagram.elements.find(
      (element) => element.name === 'Customer',
    );
    if (!customer) throw new Error('The basic fixture must include Customer.');
    customer.attributes[0]!.type.name = 'string';
    expectExportXmiError(nonCanonicalPrimitive, 'XMI_UNSUPPORTED_FEATURE');
  });

  it('rejects unrepresentable directed ends and serializes bare star multiplicity safely', () => {
    const directedModel = importFixture('relationships.xmi').model;
    const dependency = directedModel.diagram.relationships.find(
      (relationship) => relationship.kind === 'dependency',
    );
    if (!dependency) throw new Error('The relationship fixture must include a dependency.');
    dependency.source.role = 'client';
    expectExportXmiError(directedModel, 'XMI_UNSUPPORTED_FEATURE');

    const associationModel = importFixture('basic.xmi').model;
    const association = associationModel.diagram.relationships.find(
      (relationship) => relationship.kind === 'association',
    );
    if (!association) throw new Error('The basic fixture must include an association.');
    association.target.multiplicity = '*';
    const exported = exportCanonicalModelToXmi(associationModel);
    const roundTripped = importXmiToCanonical(exported, seed).model;
    expect(roundTripped.diagram.relationships[0]?.target.multiplicity).toBe('0..*');
    expect(areSemanticallyEquivalent(associationModel, roundTripped)).toBe(true);
  });

  it('preserves optional association names and parameter order through the profile', () => {
    const unnamedAssociation = importFixture('basic.xmi').model;
    const association = unnamedAssociation.diagram.relationships.find(
      (relationship) => relationship.kind === 'association',
    );
    if (!association) throw new Error('The basic fixture must include an association.');
    association.name = undefined;
    const roundTripped = importXmiToCanonical(
      exportCanonicalModelToXmi(unnamedAssociation),
      seed,
    ).model;
    expect(roundTripped.diagram.relationships[0]?.name).toBeUndefined();
    expect(areSemanticallyEquivalent(unnamedAssociation, roundTripped)).toBe(true);

    const ordered = importFixture('relationships.xmi').model;
    const operation = ordered.diagram.elements
      .find((element) => element.name === 'Employee')
      ?.operations.find((candidate) => candidate.name === 'assign');
    if (!operation) throw new Error('The relationship fixture must include Employee.assign.');
    operation.parameters.push({
      ...operation.parameters[0]!,
      id: 'second_parameter',
      name: 'fallback',
    });
    const reordered = structuredClone(ordered);
    const reorderedOperation = reordered.diagram.elements
      .find((element) => element.name === 'Employee')
      ?.operations.find((candidate) => candidate.name === 'assign');
    if (!reorderedOperation) throw new Error('The reordered fixture must include Employee.assign.');
    reorderedOperation.parameters.reverse();
    expect(areSemanticallyEquivalent(ordered, reordered)).toBe(false);
  });

  it('rejects ambiguous aliases and nested values without an explicit lexical value', () => {
    const basic = fixture('basic.xmi').toString('utf8');
    expectXmiError(
      Buffer.from(basic.replace('name="Commerce"', 'name="Commerce" uml:name="Other"'), 'utf8'),
      'XMI_MALFORMED',
    );
    const xmiAlias = Buffer.from(
      basic.replace(
        '<packagedElement xmi:type="uml:Class" xmi:id="customer" name="Customer">',
        `<packagedElement xmlns:xi="${XMI_NAMESPACE}" xi:type="uml:Class" xi:id="customer" name="Customer">`,
      ),
      'utf8',
    );
    expect(importXmiToCanonical(xmiAlias, seed).summary.classes).toBe(2);
    expectXmiError(
      Buffer.from(
        basic.replace(
          '<packagedElement xmi:type="uml:Class" xmi:id="customer" name="Customer">',
          `<packagedElement xmlns:xi="${XMI_NAMESPACE}" xmlns:xmi="${UML_NAMESPACE}" xi:type="uml:Class" xi:id="customer" name="Customer" xmi:name="Other">`,
        ),
        'utf8',
      ),
      'XMI_UNSUPPORTED_PROFILE',
    );
    expectXmiError(
      Buffer.from(
        basic.replace(
          '<packagedElement xmi:type="uml:Class" xmi:id="customer" name="Customer">',
          `<packagedElement xmlns:xi="${XMI_NAMESPACE}" xmlns:xmi="${UML_NAMESPACE}" xi:type="xmi:Class" xi:id="customer" name="Customer">`,
        ),
        'utf8',
      ),
      'XMI_UNSUPPORTED_PROFILE',
    );
    expectXmiError(
      Buffer.from(
        basic.replace(
          '</ownedAttribute>',
          '<defaultValue xmi:type="uml:LiteralString"/></ownedAttribute>',
        ),
        'utf8',
      ),
      'XMI_UNSUPPORTED_FEATURE',
    );
    expectXmiError(
      Buffer.from(
        basic.replace(
          '</ownedAttribute>',
          '<lowerValue xmi:type="uml:LiteralInteger" value=""/></ownedAttribute>',
        ),
        'utf8',
      ),
      'XMI_MALFORMED',
    );
    const nonRoundTrippableValue = importFixture('basic.xmi').model;
    const customer = nonRoundTrippableValue.diagram.elements.find(
      (element) => element.name === 'Customer',
    );
    if (!customer) throw new Error('The basic fixture must include Customer.');
    customer.attributes[0]!.defaultValue = 'line\nbreak';
    expectExportXmiError(nonRoundTrippableValue, 'XMI_UNSUPPORTED_FEATURE');
  });

  it('rejects external type identities that the canonical contract cannot retain', () => {
    const basic = fixture('basic.xmi').toString('utf8');
    expectXmiError(
      Buffer.from(
        basic.replace(
          `${UML_PRIMITIVE_TYPES_HREF}#String`,
          'https://vendor.invalid/types.xmi#Money',
        ),
        'utf8',
      ),
      'XMI_UNSUPPORTED_FEATURE',
    );
    expectXmiError(
      Buffer.from(
        basic.replace(`${UML_PRIMITIVE_TYPES_HREF}#String`, `${UML_PRIMITIVE_TYPES_HREF}#Decimal`),
        'utf8',
      ),
      'XMI_UNSUPPORTED_FEATURE',
    );
    expectXmiError(
      Buffer.from(
        basic.replace(`${UML_PRIMITIVE_TYPES_HREF}#String`, `${UML_PRIMITIVE_TYPES_HREF}#`),
        'utf8',
      ),
      'XMI_UNSUPPORTED_FEATURE',
    );
    const localPrimitiveNamesake = basic
      .replace(
        '<packagedElement xmi:type="uml:Class" xmi:id="customer" name="Customer">',
        '<packagedElement xmi:type="uml:DataType" xmi:id="local_string" name="String"/><packagedElement xmi:type="uml:Class" xmi:id="customer" name="Customer">',
      )
      .replace(
        `<type xmi:type="uml:PrimitiveType" href="${UML_PRIMITIVE_TYPES_HREF}#String"/>`,
        '<type xmi:type="uml:DataType" href="#local_string"/>',
      );
    expectXmiError(Buffer.from(localPrimitiveNamesake, 'utf8'), 'XMI_UNSUPPORTED_FEATURE');
  });

  it('rejects structured UML data types that the canonical contract cannot represent', () => {
    const basic = fixture('basic.xmi').toString('utf8');
    for (const member of [
      '<ownedAttribute xmi:id="decimal_scale" name="scale"/>',
      '<ownedOperation xmi:id="decimal_round" name="round"/>',
    ]) {
      expectXmiError(
        Buffer.from(
          basic.replace(
            '<packagedElement xmi:type="uml:DataType" xmi:id="decimal_type" name="Decimal"/>',
            `<packagedElement xmi:type="uml:DataType" xmi:id="decimal_type" name="Decimal">${member}</packagedElement>`,
          ),
          'utf8',
        ),
        'XMI_UNSUPPORTED_FEATURE',
      );
    }
  });

  it('rejects XMI containment that the canonical model cannot preserve', () => {
    const basic = fixture('basic.xmi').toString('utf8');
    const wrappedModel = basic
      .replace(
        '<uml:Model xmi:id="commerce_model" name="Commerce">',
        '<wrapper><uml:Model xmi:id="commerce_model" name="Commerce">',
      )
      .replace('</uml:Model>', '</uml:Model></wrapper>');
    expectXmiError(Buffer.from(wrappedModel, 'utf8'), 'XMI_UNSUPPORTED_PROFILE');
    expectXmiError(
      Buffer.from(
        basic.replace(
          '</uml:Model>',
          '<uml:Package xmi:id="nested_package" name="Nested"/></uml:Model>',
        ),
        'utf8',
      ),
      'XMI_UNSUPPORTED_FEATURE',
    );
    expectXmiError(
      Buffer.from(
        basic.replace(
          '</uml:Model>',
          '</uml:Model><uml:Model xmi:id="second_model" name="Second"/>',
        ),
        'utf8',
      ),
      'XMI_UNSUPPORTED_FEATURE',
    );
    expectXmiError(
      Buffer.from(
        basic.replace(
          '</packagedElement>',
          '<packagedElement xmi:type="uml:Class" xmi:id="nested_class" name="Nested"/></packagedElement>',
        ),
        'utf8',
      ),
      'XMI_UNSUPPORTED_FEATURE',
    );
    expectXmiError(
      Buffer.from(
        basic.replace(
          '</uml:Model>',
          '<ownedAttribute xmi:id="orphan_attribute" name="orphan" type="order" visibility="private"/></uml:Model>',
        ),
        'utf8',
      ),
      'XMI_UNSUPPORTED_FEATURE',
    );
  });

  it('rejects member semantics that the canonical contract cannot represent', () => {
    const basic = fixture('basic.xmi').toString('utf8');
    expectXmiError(
      Buffer.from(
        basic.replace(
          '<ownedAttribute xmi:id="order_total" name="total" visibility="private">',
          '<ownedAttribute xmi:id="order_total" lower="2" name="total" upper="5" visibility="private">',
        ),
        'utf8',
      ),
      'XMI_UNSUPPORTED_FEATURE',
    );
    expectXmiError(
      Buffer.from(
        basic.replace(
          '<ownedAttribute xmi:id="customer_name"',
          '<ownedAttribute type="order" xmi:id="customer_name"',
        ),
        'utf8',
      ),
      'XMI_MALFORMED',
    );
    expectXmiError(
      Buffer.from(
        basic
          .replace(
            '<ownedAttribute xmi:id="customer_name"',
            '<ownedAttribute lower="1" xmi:id="customer_name"',
          )
          .replace(
            '</ownedAttribute>',
            '<lowerValue xmi:type="uml:LiteralInteger" value="0"/></ownedAttribute>',
          ),
        'utf8',
      ),
      'XMI_MALFORMED',
    );
    expectXmiError(
      Buffer.from(basic.replace('name="return">', 'name="result">'), 'utf8'),
      'XMI_UNSUPPORTED_FEATURE',
    );
    expectXmiError(
      Buffer.from(
        basic.replace(
          '</ownedParameter>',
          '<defaultValue xmi:type="uml:LiteralString" value="true"/></ownedParameter>',
        ),
        'utf8',
      ),
      'XMI_UNSUPPORTED_FEATURE',
    );
    expectXmiError(
      Buffer.from(
        basic.replace('visibility="private">', 'isDerived="true" visibility="private">'),
        'utf8',
      ),
      'XMI_UNSUPPORTED_FEATURE',
    );
    expectXmiError(
      Buffer.from(basic.replace('isNavigable="false"', 'isNavigable="sometimes"'), 'utf8'),
      'XMI_MALFORMED',
    );
    expectXmiError(
      Buffer.from(
        basic.replace(
          '</ownedAttribute>',
          '<defaultValue xmi:type="uml:LiteralInteger" value="1"/></ownedAttribute>',
        ),
        'utf8',
      ),
      'XMI_UNSUPPORTED_FEATURE',
    );
    expectXmiError(
      Buffer.from(
        basic.replace(
          '</ownedAttribute>',
          '<lowerValue xmi:type="uml:LiteralBoolean" value="false"/></ownedAttribute>',
        ),
        'utf8',
      ),
      'XMI_UNSUPPORTED_FEATURE',
    );
    const relationships = fixture('relationships.xmi').toString('utf8');
    expectXmiError(
      Buffer.from(relationships.replace('aggregation="none"', 'aggregation="invalid"'), 'utf8'),
      'XMI_MALFORMED',
    );
    expectXmiError(
      Buffer.from(basic.replace('isNavigable="true"', 'isNavigable="false"'), 'utf8'),
      'XMI_MALFORMED',
    );
    expectXmiError(
      Buffer.from(
        relationships.replace(
          'isAbstract="true" isStatic="false"',
          'isAbstract="true" isQuery="true" isStatic="false"',
        ),
        'utf8',
      ),
      'XMI_UNSUPPORTED_FEATURE',
    );
    expectXmiError(
      Buffer.from(relationships.replace('direction="return"', 'direction="out"'), 'utf8'),
      'XMI_UNSUPPORTED_FEATURE',
    );
    expectXmiError(
      Buffer.from(
        relationships.replace(
          '</ownedOperation>',
          '<ownedParameter direction="return" xmi:id="duplicate_return" name="return"/></ownedOperation>',
        ),
        'utf8',
      ),
      'XMI_MALFORMED',
    );
  });

  it('rejects XML-invalid canonical values and oversized exports while preserving association-class names', () => {
    const invalidCharacterModel = importFixture('basic.xmi').model;
    invalidCharacterModel.diagram.elements[0]!.attributes[0]!.defaultValue = 'bad\u0001value';
    expect(() => validateCanonicalModel(invalidCharacterModel)).toThrow(
      CanonicalModelValidationError,
    );
    expectExportXmiError(invalidCharacterModel, 'XMI_UNSUPPORTED_FEATURE');

    const oversizedModel = importFixture('basic.xmi').model;
    const customer = oversizedModel.diagram.elements.find((element) => element.name === 'Customer');
    if (!customer) throw new Error('The basic fixture must include Customer.');
    const template = customer.attributes[0]!;
    customer.attributes = Array.from({ length: 1_300 }, (_value, index) => ({
      ...template,
      defaultValue: '&'.repeat(500),
      id: `oversized_attribute_${index}`,
      name: `field${index}`,
    }));
    expect(Buffer.byteLength(JSON.stringify(oversizedModel), 'utf8')).toBeLessThan(
      XMI_LIMITS.maxBytes,
    );
    expectExportXmiError(oversizedModel, 'XMI_LIMIT_EXCEEDED');

    const associationClassModel = importFixture('relationships.xmi').model;
    const associationClass = associationClassModel.diagram.relationships.find(
      (relationship) => relationship.associationClassId,
    );
    if (!associationClass)
      throw new Error('The relationship fixture must include an association class.');
    associationClass.name = 'participates';
    const exportedAssociationClass = exportCanonicalModelToXmi(associationClassModel);
    expect(exportedAssociationClass.toString('utf8')).toContain(
      'ucd:associationName="participates"',
    );
    expect(
      areSemanticallyEquivalent(
        associationClassModel,
        importXmiToCanonical(exportedAssociationClass, seed).model,
      ),
    ).toBe(true);
  });

  it('ignores foreign namespaces instead of treating them as supported UML', () => {
    const input = Buffer.from(
      fixture('basic.xmi')
        .toString('utf8')
        .replace(
          '</uml:Model>',
          '<evil:packagedElement xmlns:evil="https://example.invalid/evil" xmi:id="evil_customer" xmi:type="evil:Class" name="ForeignCustomer"/></uml:Model>',
        ),
      'utf8',
    );
    const result = importXmiToCanonical(input, seed);

    expect(result.summary.classes).toBe(2);
    expect(result.model.diagram.elements).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'ForeignCustomer' })]),
    );
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'XMI_EXTENSION_IGNORED',
          xmiId: 'evil_customer',
          xmiType: 'evil:packagedElement',
        }),
      ]),
    );
  });

  it('treats XMI and foreign extension subtrees as opaque', () => {
    const injected =
      '<uml:packagedElement xmi:type="uml:Class" xmi:id="extension_class" name="Injected"><ownedAttribute xmi:id="extension_attribute" name="secret" type="order" visibility="private"/></uml:packagedElement>';
    for (const { extension, diagnosticCode } of [
      {
        diagnosticCode: 'XMI_EXTENSION_IGNORED',
        extension: `<xmi:Extension>${injected}</xmi:Extension>`,
      },
      {
        diagnosticCode: 'XMI_EXTENSION_IGNORED',
        extension: `<evil:Extension xmlns:evil="https://example.invalid/evil">${injected}</evil:Extension>`,
      },
      {
        diagnosticCode: 'XMI_UNSUPPORTED_ELEMENT',
        extension: `<wrapper>${injected}</wrapper>`,
      },
    ]) {
      const input = Buffer.from(
        fixture('basic.xmi').toString('utf8').replace('</uml:Model>', `${extension}</uml:Model>`),
        'utf8',
      );
      const result = importXmiToCanonical(input, seed);

      expect(result.summary.classes).toBe(2);
      expect(result.model.diagram.elements).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'Injected' })]),
      );
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: diagnosticCode })]),
      );
    }
  });

  it('keeps UML containers inside ignored extension subtrees opaque', () => {
    const ignoredContainers =
      '<uml:Model xmi:id="extension_model" name="Extension"><uml:Package xmi:id="extension_package" name="Nested"/></uml:Model>';
    for (const extension of [
      `<xmi:Extension>${ignoredContainers}</xmi:Extension>`,
      `<evil:Extension xmlns:evil="https://example.invalid/evil">${ignoredContainers}</evil:Extension>`,
    ]) {
      const input = Buffer.from(
        fixture('basic.xmi').toString('utf8').replace('</uml:Model>', `${extension}</uml:Model>`),
        'utf8',
      );
      const result = importXmiToCanonical(input, seed);

      expect(result.summary.classes).toBe(2);
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'XMI_EXTENSION_IGNORED' })]),
      );
    }
  });

  it('ignores root-level XMI and foreign extensions before the model container', () => {
    const basic = fixture('basic.xmi').toString('utf8');
    for (const extension of [
      '<xmi:Extension xmi:id="root_extension" extender="Enterprise Architect"/>',
      '<evil:Extension xmlns:evil="https://example.invalid/evil" xmi:id="root_evil_extension"/>',
      '<evil:stub xmlns:evil="https://example.invalid/evil" xmi:id="root_evil_stub"/>',
    ]) {
      const result = importXmiToCanonical(
        Buffer.from(basic.replace('<uml:Model', `${extension}<uml:Model`), 'utf8'),
        seed,
      );

      expect(result.summary.classes).toBe(2);
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'XMI_EXTENSION_IGNORED' })]),
      );
    }
    expectXmiError(
      Buffer.from(
        basic.replace(
          '</uml:Model>',
          '</uml:Model><uml:Package xmi:id="root_package" name="Root"/>',
        ),
        'utf8',
      ),
      'XMI_UNSUPPORTED_PROFILE',
    );
  });

  it('returns structured diagnostics for unsupported UML elements without losing supported content', () => {
    const input = Buffer.from(
      fixture('basic.xmi')
        .toString('utf8')
        .replace(
          '</uml:Model>',
          '<packagedElement xmi:type="uml:Enumeration" xmi:id="status" name="Status"/></uml:Model>',
        ),
      'utf8',
    );
    const result = importXmiToCanonical(input, seed);

    expect(result.summary.classes).toBe(2);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'XMI_UNSUPPORTED_ELEMENT',
          xmiId: 'status',
          xmiType: 'enumeration',
        }),
      ]),
    );
  });

  it('rejects hostile XML and invalid semantic references before a candidate can be applied', () => {
    const basic = fixture('basic.xmi').toString('utf8');
    expectXmiError(Buffer.from('<xmi:XMI>', 'utf8'), 'XMI_MALFORMED');
    expectXmiError(Buffer.from(`<!DOCTYPE xmi:XMI>${basic}`, 'utf8'), 'XMI_DOCTYPE_FORBIDDEN');
    expectXmiError(
      Buffer.from(basic.replace('xmi:id="order"', 'xmi:id="customer"'), 'utf8'),
      'XMI_DUPLICATE_ID',
    );
    expectXmiError(
      Buffer.from(basic.replace('type="order"', 'type="missing"'), 'utf8'),
      'XMI_MISSING_REFERENCE',
    );
    expectXmiError(
      Buffer.from(
        basic.replace(
          'lower="1" name="customer" type="customer" upper="1"',
          'lower="2" name="customer" type="customer" upper="1"',
        ),
        'utf8',
      ),
      'XMI_MALFORMED',
    );
    expectXmiError(
      Buffer.from(basic.replace(UML_NAMESPACE, 'https://example.invalid/uml'), 'utf8'),
      'XMI_UNSUPPORTED_PROFILE',
    );
    expectXmiError(
      Buffer.from(basic.replace('xmi:version="2.5"', 'xmi:version="2.4"'), 'utf8'),
      'XMI_UNSUPPORTED_PROFILE',
    );
    const withoutVersion = importXmiToCanonical(
      Buffer.from(basic.replace(' xmi:version="2.5"', ''), 'utf8'),
      seed,
    );
    expect(withoutVersion.profile.xmiVersion).toBeNull();
    expect(withoutVersion.summary.classes).toBe(2);
    expectXmiError(
      Buffer.from(basic.replace('<xmi:XMI ', '<xmi:XMI vendor="value" '), 'utf8'),
      'XMI_UNSUPPORTED_FEATURE',
    );
    // xmi:Documentation es metadato estandar de XMI; se ignora sin afectar el modelo.
    expect(
      importXmiToCanonical(
        Buffer.from(basic.replace('</uml:Model>', '<xmi:Documentation/></uml:Model>'), 'utf8'),
        seed,
      ).summary.classes,
    ).toBe(2);
    expectXmiError(
      Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><xmi:XMI xmlns:xmi="http://www.omg.org/spec/XMI/20131001" xmlns:uml="${UML_NAMESPACE}" xmi:version="2.5"><uml:Enumeration xmi:id="status" name="Status"/></xmi:XMI>`,
        'utf8',
      ),
      'XMI_UNSUPPORTED_PROFILE',
    );
    const legacyAscii = importXmiToCanonical(
      Buffer.from(basic.replace('encoding="UTF-8"', 'encoding="windows-1252"'), 'ascii'),
      seed,
    );
    expect(legacyAscii.summary.classes).toBe(2);
    const latin1Text = basic
      .replace('encoding="UTF-8"', 'encoding="ISO-8859-1"')
      .replace('name="Commerce"', 'name="Comércio"');
    expectXmiError(Buffer.from(latin1Text, 'latin1'), 'XMI_INVALID_ENCODING');
    expectXmiError(Buffer.from([0, 1, 2]), 'XMI_BINARY_CONTENT');
    expectXmiError(Buffer.alloc(XMI_LIMITS.maxBytes + 1, 0x20), 'XMI_LIMIT_EXCEEDED');
  });

  it('rejects relationship endpoint references that would otherwise lose semantics', () => {
    const basic = fixture('basic.xmi').toString('utf8');
    expectXmiError(
      Buffer.from(
        basic.replace(
          'memberEnd="customer_orders_customer customer_orders_order"',
          'memberEnd="customer_orders_customer customer_orders_customer"',
        ),
        'utf8',
      ),
      'XMI_MALFORMED',
    );
    expectXmiError(
      Buffer.from(
        basic.replace(
          'navigableOwnedEnd="customer_orders_order"',
          'navigableOwnedEnd="missing_end"',
        ),
        'utf8',
      ),
      'XMI_MISSING_REFERENCE',
    );
    expectXmiError(
      Buffer.from(
        basic.replace(
          'xmi:id="customer_orders_order"/>',
          'xmi:id="customer_orders_order"/><ownedEnd aggregation="none" isNavigable="false" lower="0" name="extra" type="order" upper="1" xmi:id="customer_orders_extra"/>',
        ),
        'utf8',
      ),
      'XMI_UNSUPPORTED_FEATURE',
    );
    expectXmiError(
      Buffer.from(
        fixture('relationships.xmi')
          .toString('utf8')
          .replace('client="employee"', 'client="employee department"'),
        'utf8',
      ),
      'XMI_UNSUPPORTED_FEATURE',
    );
  });

  it('enforces nesting limits with a bounded hostile fixture', () => {
    expectXmiError(fixture('hostile/depth-exceeded.xmi'), 'XMI_LIMIT_EXCEEDED');
  });

  it('keeps the small hostile fixtures as regression inputs', () => {
    expectXmiError(fixture('hostile/malformed.xmi'), 'XMI_MALFORMED');
    expectXmiError(fixture('hostile/doctype.xmi'), 'XMI_DOCTYPE_FORBIDDEN');
    expectXmiError(fixture('hostile/external-entity.xmi'), 'XMI_DOCTYPE_FORBIDDEN');
    expectXmiError(fixture('hostile/entity-expansion.xmi'), 'XMI_DOCTYPE_FORBIDDEN');
    expectXmiError(fixture('hostile/duplicate-ids.xmi'), 'XMI_DUPLICATE_ID');
    expectXmiError(fixture('hostile/dangling-reference.xmi'), 'XMI_MISSING_REFERENCE');
    expectXmiError(fixture('hostile/invalid-multiplicity.xmi'), 'XMI_MALFORMED');

    let cycleError: unknown;
    try {
      validateCanonicalModel(importFixture('hostile/generalization-cycle.xmi').model);
    } catch (error) {
      cycleError = error;
    }
    expect(cycleError).toBeInstanceOf(CanonicalModelValidationError);
    expect(cycleError).toMatchObject({
      validationErrors: expect.arrayContaining([
        expect.objectContaining({ message: 'generalization relationships cannot form a cycle.' }),
      ]),
    });
    expect(importFixture('hostile/unknown-namespace.xmi').diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'XMI_EXTENSION_IGNORED' })]),
    );
    expect(importFixture('hostile/unsupported-element.xmi').diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'XMI_UNSUPPORTED_ELEMENT' })]),
    );
  });

  it('imports a real Enterprise Architect 15 XMI 2.5.1 export without losing supported semantics', () => {
    const result = importFixture('enterprise-architect/ea15-uml251.xmi');

    expect(result.profile).toMatchObject({
      umlNamespace: 'http://www.omg.org/spec/UML/20131001',
      xmiVersion: null,
    });
    expect(result.summary).toEqual({
      attributes: 10,
      classes: 8,
      interfaces: 1,
      operations: 5,
      relationships: 9,
    });
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['XMI_EXTENSION_IGNORED', 'XMI_PACKAGE_FLATTENED']),
    );

    const byName = new Map(result.model.diagram.elements.map((element) => [element.name, element]));
    const person = byName.get('Person');
    expect(person?.kind).toBe('class');
    expect(person?.kind === 'class' ? person.isAbstract : undefined).toBe(true);
    expect(person?.attributes).toEqual([
      expect.objectContaining({
        name: 'name',
        type: expect.objectContaining({ name: 'String' }),
      }),
    ]);
    expect(person?.operations).toEqual([
      expect.objectContaining({
        name: 'displayName',
        returnType: expect.objectContaining({ name: 'String' }),
      }),
      expect.objectContaining({
        name: 'rename',
        parameters: [
          expect.objectContaining({
            name: 'newName',
            type: expect.objectContaining({ name: 'String' }),
          }),
        ],
        returnType: expect.objectContaining({ name: 'void' }),
      }),
    ]);
    expect(byName.get('Customer')?.operations).toEqual([
      expect.objectContaining({
        name: 'placeOrder',
        parameters: [
          expect.objectContaining({
            name: 'total',
            type: expect.objectContaining({ name: 'Real' }),
          }),
        ],
        returnType: expect.objectContaining({ elementId: expect.any(String), name: 'Order' }),
      }),
    ]);
    expect(byName.get('OrderRepository')?.operations).toEqual([
      expect.objectContaining({
        name: 'save',
        parameters: [
          expect.objectContaining({
            type: expect.objectContaining({ elementId: expect.any(String), name: 'Order' }),
          }),
        ],
        returnType: expect.objectContaining({ name: 'Boolean' }),
      }),
    ]);

    const idToName = new Map(
      result.model.diagram.elements.map((element) => [element.id, element.name]),
    );
    const relationships = result.model.diagram.relationships.map((relationship) => ({
      end: `${idToName.get(relationship.source.elementId)}:${relationship.source.role}:${relationship.source.multiplicity}`,
      kind: relationship.kind,
      name: relationship.name ?? '',
      target: `${idToName.get(relationship.target.elementId)}:${relationship.target.role}:${relationship.target.multiplicity}`,
    }));
    expect(relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          end: 'Customer::1',
          kind: 'generalization',
          target: 'Person::1',
        }),
        expect.objectContaining({
          end: 'JpaOrderRepository::1',
          kind: 'realization',
          target: 'OrderRepository::1',
        }),
        expect.objectContaining({
          end: 'Customer::1',
          kind: 'dependency',
          name: 'usesInvoice',
          target: 'Invoice::1',
        }),
        expect.objectContaining({
          end: 'Person:reports:0..*',
          kind: 'association',
          name: 'manages',
          target: 'Person:manager:0..1',
        }),
        expect.objectContaining({
          kind: 'aggregation',
          name: 'sharedLines',
        }),
        expect.objectContaining({
          kind: 'composition',
          name: 'billingAddress',
        }),
      ]),
    );
    const serialized = JSON.stringify(relationships);
    expect(serialized).toContain('OrderLine:order:1');
    expect(serialized).toContain('Order:lines:0..*');
    expect(serialized).toContain('Invoice:addresses:0..*');
    expect(serialized).toContain('Address:invoice:1');
    expect(serialized).toContain('Customer:verifiedCustomer:0..1');
    expect(serialized).toContain('Order:verifiedOrders:1..*');
    expect(serialized).toContain('Customer:customers:0..*');
    expect(serialized).toContain('Product:products:0..*');
    expect(relationships.filter((entry) => entry.name === 'billing')).toHaveLength(1);
    expect(relationships.filter((entry) => entry.name === 'shipping')).toHaveLength(1);

    const roundTripped = importXmiToCanonical(exportCanonicalModelToXmi(result.model), seed).model;
    expect(areSemanticallyEquivalent(result.model, roundTripped)).toBe(true);
  });
});
