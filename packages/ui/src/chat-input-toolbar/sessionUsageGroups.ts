export interface SessionUsageGroupModel {
  main: true;
  child: boolean;
}

export function buildSessionUsageGroupModel(childCount: number): SessionUsageGroupModel {
  return {
    main: true,
    child: childCount > 0,
  };
}
