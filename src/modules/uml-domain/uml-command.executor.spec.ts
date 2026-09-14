import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CanonicalModelValidator } from './canonical-model.validator';
import type { CanonicalUmlModel, UmlCommand } from './collaboration.types';
import { UmlCommandExecutor } from './uml-command.executor';

function fixture(): CanonicalUmlModel {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), 'contracts/fixtures/valid-uml-model.json'), 'utf8'),
  ) as CanonicalUmlModel;
}

describe('UmlCommandExecutor', () => {
  const timestamp = '2026-09-08T12:00:00.000Z';

  it('treats an association-class aggregate deletion as affecting every classifier', () => {
    const model = fixture();
    const affected = new UmlCommandExecutor().affectedElementIds(model, {
      type: 'relationship.delete',
      timestamp,
      relationshipId: 'rel_enrollment',
    });

    expect(affected).toEqual(new Set(model.diagram.elements.map((element) => element.id)));
  });

  it('treats a classifier rename as affecting every classifier with an updated type reference', () => {
    const model = fixture();
    const order = model.diagram.elements.find((element) => element.id === 'order');
    if (!order) {
      throw new Error('Expected the order classifier fixture.');
    }

    const affected = new UmlCommandExecutor().affectedElementIds(model, {
      type: 'classifier.update',
      timestamp,
      elementId: 'order',
      classifier: { ...order, name: 'PurchaseOrder' },
    });

    expect(affected).toEqual(new Set(['order', 'customer', 'repository']));
  });

  it('includes an association class in the affected elements of relationship creation', () => {
    const affected = new UmlCommandExecutor().affectedElementIds(fixture(), {
      type: 'relationship.create',
      timestamp,
      relationship: {
        id: 'rel_customer_order_line',
        kind: 'association',
        source: { elementId: 'customer', role: 'customer', multiplicity: '0..*', navigable: true },
        target: { elementId: 'order', role: 'orders', multiplicity: '0..*', navigable: true },
        associationClassId: 'order_line',
      },
    });

    expect(affected).toEqual(new Set(['customer', 'order', 'order_line']));
  });

  it('applies every editor command variant while preserving the canonical model', () => {
    const executor = new UmlCommandExecutor();
    const validator = new CanonicalModelValidator();
    let model = fixture();
    let revision = 0;

    const apply = (command: UmlCommand) => {
      revision += 1;
      model = executor.execute(model, command);
      model = validator.validateAndNormalize(
        model as unknown as Record<string, unknown>,
        revision,
        new Date(timestamp),
        {
          projectId: '11111111-1111-4111-8111-111111111111',
          documentId: '22222222-2222-4222-8222-222222222222',
        },
      ) as unknown as CanonicalUmlModel;
    };

    const invoice = {
      id: 'invoice',
      kind: 'class' as const,
      name: 'Invoice',
      isAbstract: false,
      attributes: [],
      operations: [],
    };

    apply({
      type: 'classifier.create',
      timestamp,
      classifier: invoice,
      position: { elementId: 'invoice', x: 80, y: 760, width: 280 },
    });
    apply({
      type: 'classifier.update',
      timestamp,
      elementId: 'invoice',
      classifier: { ...invoice, name: 'InvoiceRecord' },
    });
    apply({
      type: 'classifier.move',
      timestamp,
      elementId: 'invoice',
      position: { x: 120, y: 800 },
    });
    apply({
      type: 'classifier.duplicate',
      timestamp,
      sourceElementId: 'invoice',
      classifier: { ...invoice, id: 'invoice_copy', name: 'InvoiceCopy' },
      position: { elementId: 'invoice_copy', x: 440, y: 800, width: 280 },
    });
    apply({
      type: 'attribute.add',
      timestamp,
      classifierId: 'invoice',
      attribute: {
        id: 'invoice_code',
        name: 'code',
        visibility: 'private',
        type: { name: 'String', nullable: false, collection: false },
        isStatic: false,
        isReadOnly: false,
      },
    });
    apply({
      type: 'attribute.update',
      timestamp,
      classifierId: 'invoice',
      attributeId: 'invoice_code',
      attribute: {
        id: 'invoice_code',
        name: 'externalCode',
        visibility: 'public',
        type: { name: 'String', nullable: false, collection: false },
        isStatic: false,
        isReadOnly: true,
      },
    });
    apply({
      type: 'attribute.delete',
      timestamp,
      classifierId: 'invoice',
      attributeId: 'invoice_code',
    });
    apply({
      type: 'operation.add',
      timestamp,
      classifierId: 'invoice',
      operation: {
        id: 'invoice_send',
        name: 'send',
        visibility: 'public',
        parameters: [],
        returnType: { name: 'void', nullable: false, collection: false },
        isAbstract: false,
        isStatic: false,
      },
    });
    apply({
      type: 'operation.update',
      timestamp,
      classifierId: 'invoice',
      operationId: 'invoice_send',
      operation: {
        id: 'invoice_send',
        name: 'sendToLedger',
        visibility: 'public',
        parameters: [
          {
            id: 'invoice_send_destination',
            name: 'destination',
            type: { name: 'String', nullable: false, collection: false },
          },
        ],
        returnType: { name: 'void', nullable: false, collection: false },
        isAbstract: false,
        isStatic: false,
      },
    });
    apply({
      type: 'operation.delete',
      timestamp,
      classifierId: 'invoice',
      operationId: 'invoice_send',
    });
    apply({
      type: 'relationship.create',
      timestamp,
      relationship: {
        id: 'rel_invoice_order',
        kind: 'association',
        source: { elementId: 'invoice', role: 'invoices', multiplicity: '0..*', navigable: true },
        target: { elementId: 'order', role: 'orders', multiplicity: '0..*', navigable: true },
      },
    });
    apply({
      type: 'relationship.update',
      timestamp,
      relationshipId: 'rel_invoice_order',
      relationship: {
        id: 'rel_invoice_order',
        kind: 'association',
        name: 'contains',
        source: { elementId: 'invoice', role: 'invoices', multiplicity: '0..*', navigable: true },
        target: { elementId: 'order', role: 'orders', multiplicity: '0..*', navigable: true },
      },
    });
    apply({
      type: 'association-class.create',
      timestamp,
      relationshipId: 'rel_invoice_order',
      classifier: {
        id: 'invoice_order_link',
        kind: 'class',
        name: 'InvoiceOrderLink',
        isAbstract: false,
        stereotypes: ['association-class'],
        attributes: [],
        operations: [],
      },
      position: { elementId: 'invoice_order_link', x: 320, y: 960, width: 280 },
    });
    apply({
      type: 'relationship.delete',
      timestamp,
      relationshipId: 'rel_invoice_order',
    });
    apply({ type: 'classifier.delete', timestamp, elementId: 'invoice_copy' });
    apply({ type: 'diagram.clear', timestamp });

    expect(revision).toBe(16);
    expect(model.metadata.revision).toBe(16);
    expect(model.diagram.elements).toEqual([]);
    expect(model.diagram.relationships).toEqual([]);
    expect(model.diagram.visual.positions).toEqual([]);
  });
});
