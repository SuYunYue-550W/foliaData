import type { LocalLibraryAssignment, LocalLibraryEntity, LocalLibraryEntityKind } from '../types/localLibrary';

// src/utils/localLibraryIndex.ts
// Builds reusable alias and assignment indexes for resolver and GridView adapters.

export interface LocalLibraryIndex {
  entitiesById: Map<string, LocalLibraryEntity>;
  entityIdsByAlias: Map<string, string[]>;
  assignmentsBySongId: Map<string, LocalLibraryAssignment>;
}

export const buildLocalLibraryIndex = (
  entities: LocalLibraryEntity[],
  assignments: LocalLibraryAssignment[] = [],
): LocalLibraryIndex => {
  const entityIdsByAlias = new Map<string, string[]>();
  entities.forEach(entity => {
    entity.normalizedAliases.forEach(alias => {
      const key = `${entity.kind}:${alias}`;
      // 不要 [...] 重建数组：大量实体共享同一个归一化别名时（同名艺人/专辑），
      // 每次都复制已有数组会退化成 O(k²) 分配和 GC。直接往原数组里 push。
      const ids = entityIdsByAlias.get(key);
      if (ids) ids.push(entity.id);
      else entityIdsByAlias.set(key, [entity.id]);
    });
  });
  return {
    entitiesById: new Map(entities.map(entity => [entity.id, entity])),
    entityIdsByAlias,
    assignmentsBySongId: new Map(assignments.map(assignment => [assignment.songId, assignment])),
  };
};

export const followEntityRedirect = (
  entityId: string,
  entitiesById: Map<string, LocalLibraryEntity>,
): string | undefined => {
  let current = entitiesById.get(entityId);
  const visited = new Set<string>();
  while (current?.mergedInto && !visited.has(current.id)) {
    visited.add(current.id);
    current = entitiesById.get(current.mergedInto);
  }
  return current?.id;
};

export const getActiveEntities = (
  entities: LocalLibraryEntity[],
  kind?: LocalLibraryEntityKind,
) => entities.filter(entity => !entity.mergedInto && (!kind || entity.kind === kind));

