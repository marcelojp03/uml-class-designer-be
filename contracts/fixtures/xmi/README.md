# Fixtures XMI 7A.1

## Fixtures semanticos

| Archivo | Cobertura |
|---|---|
| `basic.xmi` | Fixture A: `Customer`, `Order`, atributos, operacion y asociacion `1` a `0..*`. SHA-256: `A36872B47D126D5DBB370620FA1E9175D30293BCEB27BCE12965D6B68C8E6B32`. |
| `relationships.xmi` | Fixture B: clase abstracta, interfaz, herencia, realizacion, agregacion, composicion, dependencia, reflexiva, paralelas, N:M y clase asociativa. SHA-256: `15AFA79FA607EFEF4CE2AE3E260786509B3B327C84F9E59E3A00BAC3D8818DF2`. |

## Fixture real de Enterprise Architect

| Archivo | Cobertura |
|---|---|
| `enterprise-architect/ea15-uml251.xmi` | Exportacion real de Enterprise Architect 15.0.0.1514 (perfil `xmiEA251`, XMI 2.5.1 con namespace UML 20131001, `encoding="windows-1252"` ASCII, sin `xmi:version`, con `xmi:Documentation`, paquete raiz, extensiones EA y tipos `EAJava_*`). Contiene 8 clases, 1 interfaz, 10 atributos, 5 operaciones, generalizacion, realizacion, dependencia, asociaciones paralelas, reflexiva, N:M, agregacion y composicion. SHA-256: `1BFB392879A4A3858CFF15C1A92DA0401E9D8CBA1467C71D789EA40E9D5E662F`. El unico dato sanitizado es el autor del proyecto (`EA-CERTIFICATION`); el resto son bytes reales de EA. |

## Fixtures hostiles

`hostile/` contiene entradas minimizadas para revision humana: XML mal formado, DTD/entidad externa, expansion de entidades, profundidad excesiva, IDs duplicados, referencia colgante, multiplicidad invalida, ciclo de generalizacion, namespace desconocido y elemento no soportado. El caso sobredimensionado se construye dinamicamente en `xmi.adapter.spec.ts` para no versionar un payload hostil de mas de 1 MiB.

## Fixture C de Enterprise Architect

No se incluye un fixture presentado falsamente como exportado por EA. El MCP local no puede crear un repositorio temporal ni exportar XMI. La obtencion de un Fixture C sanitizado y su README quedan `REVISE` hasta seguir el procedimiento aislado de `resultados-opencode/033-incremento-7a1-interoperabilidad-xmi/INTEROPERABILIDAD_ENTERPRISE_ARCHITECT.md`.
