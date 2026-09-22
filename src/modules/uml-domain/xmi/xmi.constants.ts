export const XMI_PROFILE_VERSION = '1.0.0';
export const XMI_CONTENT_TYPE = 'application/xmi+xml';
export const XMI_ACCEPTED_CONTENT_TYPES = [
  XMI_CONTENT_TYPE,
  'application/xml',
  'text/xml',
] as const;
export const XMI_NAMESPACE = 'http://www.omg.org/spec/XMI/20131001';
export const UML_NAMESPACE = 'http://www.omg.org/spec/UML/20161101';
export const UML_PRIMITIVE_TYPES_HREF = 'http://www.omg.org/spec/UML/20161101/PrimitiveTypes.xmi';
export const XMI_EXTENSION_NAMESPACE = 'https://uml-class-designer.local/xmi/1.0';

export const XMI_LIMITS = {
  maxAttributeCount: 32,
  maxBytes: 1_048_576,
  maxDepth: 64,
  maxNodes: 10_000,
  maxProcessingMs: 1_000,
  maxTextCharacters: 524_288,
  maxValueCharacters: 2_000,
} as const;

export const XMI_BODY_PARSER_LIMIT = '1mb';
